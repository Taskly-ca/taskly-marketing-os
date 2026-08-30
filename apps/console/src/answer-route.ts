/**
 * THE ANSWER ENDPOINT — a question in, a staged answer out, and a turn that
 * survives the tab being closed.
 *
 * `/api/research` already streams, and this is not a second copy of it. Three
 * things are genuinely different, and each is a hole the plan's audit named:
 *
 *  - **It persists.** `/api/research` mints a `runId`, spends real money, and
 *    discards both the answer and the id. Here the turn is a user message and
 *    an assistant message with its citations, written through the Part 2 store,
 *    and the `runId` goes on the row — which is what turns `ai_usage_log` from
 *    a spend total into per-message cost attribution.
 *  - **It refuses to run twice.** `/api/research` has no concurrency guard, so
 *    N tabs is N concurrent paid runs and a reload during a 60-second answer
 *    silently buys a second one. See `AnswerGuard`.
 *  - **It checks the day's budget at the door**, against a ledger rebuilt from
 *    `ai_usage_log` rather than from zero. `budget-boot.ts` explains why that
 *    is not the same ceiling `callGroq` already enforces.
 *
 * ── WHAT IS TESTED AND WHAT IS NOT ─────────────────────────────────────────
 *
 * `runAnswerStream` takes an `SseSink` and a bag of dependencies rather than a
 * `ServerResponse` and a database, because there is no HTTP-level test harness
 * in this repo and no jsdom. Everything that can go wrong in a way that costs
 * money or corrupts a thread — sequencing, the guard, the persistence, the
 * pre-flight — is therefore provable with fakes. `runAnswer` below is the
 * remaining glue: headers, credentials, a `res.end()`. It is deliberately thin
 * because it is the part no test can reach.
 *
 * ── ONE EVENT THIS ROUTE ADDS TO THE CONTRACT: `epilogue` ──────────────────
 *
 *   event: epilogue
 *   data:  { unanswered: string[], note: string, related: string[] }
 *
 * Emitted AT MOST ONCE, immediately before `done`, and only when at least one
 * of the three fields carries something. `done` is unchanged.
 *
 * Why it is not simply more fields on `DoneEvent`: `events.ts` is the contract
 * three parallel pieces were written against, and widening a shape that two of
 * them already implement is how three pieces come to hold two contracts. A new
 * name is additive — a reader that does not know it ignores the frame, which is
 * exactly what SSE does with an unregistered event type.
 *
 * What each field is, and what it is NOT:
 *
 *  - `unanswered` — the parts of the question the planner said the web cannot
 *    answer. This is the **Not answerable** card in §3's anatomy. It is not a
 *    failure of the run; it is the run being explicit about its edges, and §7
 *    item 1 is that hiding these is the tempting thing to delete for a cleaner
 *    screen. The UI could not populate that section before, because `done`
 *    carried only counts.
 *  - `note` — the pipeline's own reason for writing no prose ("no search
 *    results", "the model was unavailable"). It co-occurs with an EMPTY answer,
 *    so when it is present there is nothing on screen and this frame is the
 *    reader's only explanation. It is also what got persisted as the message
 *    body, so the two cannot disagree.
 *  - `related` — follow-up questions the pipeline proposed. It is present only
 *    when the pipeline actually returned some; this route never writes one. An
 *    answer engine that invents its own related questions is generating
 *    unsourced text under a heading that looks derived, which is the whole
 *    class of thing `packages/research` exists to refuse.
 *
 * `dropped` spans are deliberately NOT here: they are attribution's refusals,
 * they arrive per-span while the answer is still being built, and the frame
 * they belong on is a per-span one rather than a summary at the end.
 */
import type { ServerResponse } from 'node:http';
import {
  checkSentence,
  groundedDocs,
  groundedSourceEvents,
  groundedSpanEvents,
  groundedUniverse,
  research,
  streamAnswer,
  streamGrounded,
} from '@tmos/research';
import { randomUUID } from 'node:crypto';

import { db, sql } from '@tmos/db';
import { loadEnv, type BudgetLimits } from '@tmos/shared';
import {
  appendMessage,
  createAsk,
  createAskStream,
  createResearchReader,
  createThread,
  getThread,
  searchProvidersFromEnv,
  type AnswerPayload,
  type CitationRecord,
  type MessageRecord,
  type NewMessage,
  type NewThread,
  type ThreadDetail,
  type ThreadRecord,
} from '@tmos/adapters';
import type {
  AskPort,
  AskStreamPort,
  CitableSpan,
  ConversationTurn,
  DeltaEvent,
  Dropped,
  Point,
  ReadDoc,
  ReadPort,
  GroundedUniverse,
  ResearchAnswer,
  ResearchDeps,
  SearchPort,
  SentenceEvent,
  SourceEvent,
  SpanEvent,
  StatusEvent,
} from '@tmos/research';

import { dailyBudget, noteSpend, refuseForBudget } from './budget-boot.js';
import {
  createPostgresGroundedReader,
  retrieveGrounded,
  type GroundedEvidence,
} from './grounded-retrieval.js';
import { openSse, send, type SseSink } from './sse.js';

/* ── the seam ───────────────────────────────────────────────────────────── */

/**
 * WHERE `streamAnswer` PLUGS IN.
 *
 * Part 3 owns `packages/research/src/stream.ts` and its `streamAnswer(question,
 * deps)`. These types are a LOCAL RESTATEMENT of that function's signature —
 * every payload on them is imported from `events.ts`, the contract both halves
 * were written against, so the only local thing is the shape carrying them.
 *
 * They are deliberately looser than the real ones in the two directions that
 * make the swap safe: the deps carry everything `StreamDeps` requires (and one
 * field it does not yet — `history`, which is Part 5's follow-up context and is
 * harmless to pass early), and the result requires only what this route reads,
 * with the rest optional. So `StreamedAnswer` satisfies `StreamAnswerResult`
 * and this route's deps satisfy `StreamDeps`, which is what reduces the wiring
 * to one line.
 */
export interface AnswerPorts {
  readonly ask: AskPort;
  readonly askStream: AskStreamPort;
  readonly search: readonly SearchPort[];
  readonly read: ReadPort;
}

export interface StreamAnswerDeps extends AnswerPorts {
  /**
   * The thread so far, oldest first — a follow-up is answered in context or it
   * is not a follow-up.
   *
   * `ConversationTurn` comes from `events.ts` rather than being restated here,
   * because the planner that resolves "and in Vancouver?" against it and the
   * route that loads it out of Postgres are two pieces built in parallel, and a
   * shape each of them defines separately is two shapes.
   *
   * The pipeline's own `StreamDeps` grew a matching optional `history` on
   * 2026-08-31, built in parallel with this. Nothing here had to change when it
   * landed, and nothing here breaks if it is reverted: the deps object this
   * route passes is a SUPERSET of what the pipeline requires, so a pipeline
   * that ignores the field behaves exactly as it did before it existed. That is
   * the whole point of restating the signature locally — see the seam below.
   */
  readonly history: readonly ConversationTurn[];
  readonly onStatus: (e: StatusEvent) => void;
  readonly onSource: (e: SourceEvent) => void;
  readonly onSpan: (e: SpanEvent) => void;
  readonly onDelta: (e: DeltaEvent) => void;
  readonly onSentence: (e: SentenceEvent) => void;
}

export interface StreamAnswerResult {
  /** The whole answer, with `[N]` markers. NOT reassembled from the deltas —
   *  a stream that died halfway reads exactly like one that finished. */
  readonly text: string;
  readonly costCents: number;
  /** Everything below is optional so that a change on Part 3's side is a
   *  smaller answer here rather than a broken build. */
  readonly sources?: readonly ReadDoc[];
  readonly queries?: readonly string[];
  readonly unanswered?: readonly string[];
  /** Non-empty when there is no answer and the reader is owed the reason. */
  readonly note?: string;
  /**
   * Follow-up questions the pipeline proposed, if it proposed any.
   *
   * Optional, and absent today: `streamAnswer` does not return them yet. The
   * route relays what it is given and writes none of its own — related
   * questions the console invented would be ungrounded text sitting under a
   * heading that reads as derived from the answer.
   */
  readonly related?: readonly string[];
  readonly flagged?: number;
  /**
   * Verified mode's shape, and only Verified mode's.
   *
   * A `Point` is a claim that survived a WHOLE-ANSWER gate — span verbatim in a
   * document this run fetched, every figure inside a cited span, honesty gate
   * clear. Fast mode produces none and must keep sending none: filling these by
   * casting its dropped SPANS into dropped CLAIMS would file one kind of
   * refusal under another kind's name.
   *
   * `droppedClaims`, not `dropped`, and the name is doing real work: the fast
   * pipeline's own result already carries a `dropped` of `DroppedSpan` —
   * attribution's refusals, a quote it could not prove. These are the gate's
   * refusals, a CLAIM the evidence would not carry. Two different refusals
   * under one name is how a UI comes to render one as the other.
   */
  readonly points?: readonly Point[];
  readonly droppedClaims?: readonly Dropped[];
}

export type StreamAnswerFn = (
  question: string,
  deps: StreamAnswerDeps,
) => Promise<StreamAnswerResult>;

/**
 * ▲ THE SEAM ▲ — closed 2026-08-31, once `stream.ts` reached the barrel.
 *
 * `StreamAnswerFn` stays a named local type rather than collapsing into a
 * direct call: it is the declaration of what this route needs from the
 * pipeline, and it is what let this file be written and fully tested against
 * fakes while `stream.ts` was still being built in parallel.
 *
 * What stood here is worth remembering — a REJECTING stub, chosen over one that
 * returned plausible prose, because an answer engine whose failure mode is a
 * fluent uncited essay is the exact thing `packages/research` exists to
 * prevent, and it would have passed every test in this file.
 */
const STREAM_ANSWER: StreamAnswerFn = streamAnswer;

/* ── modes ──────────────────────────────────────────────────────────────── */

/**
 * THE THREE THINGS THE BOX CAN BE ASKED TO DO.
 *
 *  - `web` — the attribute-first pipeline over pages fetched this run. Fast,
 *    per-sentence checks, the default since §9's founder call.
 *  - `grounded` — Part 6. Answered from OUR evidence: the world model, live
 *    Findings, the Brain and the prediction ledger. **It never reaches a search
 *    provider**, and that is not a cost optimisation — "what do we know about
 *    Jiffy?" answered from Tavily is a different question with the same words.
 *  - `verified` — the strict whole-answer gate in `pipeline.ts`, which has been
 *    sitting unreachable since the answer engine shipped because this route
 *    took only `q` and `thread`.
 *
 * An unknown value is `web` rather than an error. A mode arrives in a query
 * string, a query string is a link somebody may have kept, and refusing an old
 * link outright is worse than answering it the default way.
 */
type AnswerMode = 'web' | 'grounded' | 'verified';

export function parseMode(raw: string | null | undefined): AnswerMode {
  const m = (raw ?? '').trim().toLowerCase();
  return m === 'grounded' || m === 'verified' ? m : 'web';
}

/**
 * WHAT GOES IN `message.mode`, WHICH CANNOT SAY "GROUNDED".
 *
 * Migration 015 constrains the column to `('fast','verified')`, and migrations
 * are a locked, serial file this task may not touch. So a grounded turn is
 * stored as `fast` — which is true about the SHAPE of the answer (streamed
 * prose, per-sentence checks, no whole-answer gate) and silent about where its
 * evidence came from. That is a real gap, not a rounding: cost-per-mode and
 * "was this answered from our own ledger?" cannot be recovered from the row.
 * Widening the constraint is a one-line migration and a serial change.
 */
function messageMode(mode: AnswerMode): 'fast' | 'verified' {
  return mode === 'verified' ? 'verified' : 'fast';
}

/* ── grounded mode: the seam ────────────────────────────────────────────── */

/**
 * WHERE PHASE B FOR GROUNDED MODE PLUGS IN.
 *
 * `packages/research/src/grounded.ts` landed while this was being written and
 * owns phase A: `groundedUniverse()` turns the records this console retrieves
 * into a `GroundedUniverse`, which IS a `CitableUniverse` — the same shape
 * `attribute()` produces for the web path. That is the whole design: phase B
 * and phase C never asked where a span came from.
 *
 * What does NOT exist yet is the generation half — a `streamGrounded` beside
 * `streamAnswer` that writes prose against `groundedSpanBlock(universe)` and
 * checks each sentence. So the seam is drawn there, and the deps below are the
 * local restatement of what that function will need: the same style, and the
 * same reason, as `StreamAnswerFn` above.
 *
 * `search` and `read` are deliberately ABSENT from this shape. A grounded
 * answer that COULD reach a search provider would eventually reach one.
 */
interface GroundedAnswerDeps {
  readonly ask: AskPort;
  readonly askStream: AskStreamPort;
  /** Phase A's output, already built. Spans are proven; nothing here needs a
   *  model to decide what is quotable. */
  readonly universe: GroundedUniverse;
  /** What the retrieval looked for and did not find. Not part of the universe,
   *  because "we hold no facts about this company" is a fact about the QUERY. */
  readonly excluded: readonly string[];
  readonly history: readonly ConversationTurn[];
  readonly onStatus: (e: StatusEvent) => void;
  readonly onDelta: (e: DeltaEvent) => void;
  readonly onSentence: (e: SentenceEvent) => void;
}

export type GroundedAnswerFn = (
  question: string,
  deps: GroundedAnswerDeps,
) => Promise<StreamAnswerResult>;

/**
 * ▲ THE SEAM ▲ — closed 2026-08-31, once `streamGrounded` landed in `stream.ts`.
 *
 * What stood here is worth remembering: a REJECTING stub, chosen over one that
 * returned plausible prose, because an answer engine whose failure mode is a
 * fluent uncited essay is the exact thing `packages/research` exists to
 * prevent, and it would have passed every test in this file.
 *
 * `streamGrounded` is phase B and phase C over a prebuilt universe. It calls
 * the SAME `writeFromSpans` the web path calls, so the marker gate, the
 * figure-in-a-cited-span check, the honesty gate and the causal lint are the
 * same code and a `confirmed` badge means the same thing in both modes. It is
 * given no search port and no read port, which is what makes "grounded mode
 * never reaches a search provider" structural rather than a rule to remember.
 *
 * The deps this route composes are a superset of what it takes — `excluded` and
 * `history` are read here and not there. `history` in particular goes no
 * further: grounded mode has no planner to resolve a follow-up against, so the
 * question reaches phase B as it was typed, and there is no prior prose
 * anywhere near the generator.
 */
export const GROUNDED_ANSWER: GroundedAnswerFn = (question, deps) =>
  streamGrounded(question, deps.universe, deps);

/**
 * Grounded mode as a `StreamAnswerFn`, so the run body stays one call.
 *
 * Phase A runs HERE rather than behind the seam because the source cards and
 * the span numbering must be on the wire before any prose exists — that
 * ordering is the product, per §3 of the plan — and because an empty universe
 * has to stop the run before a model is ever asked.
 */
export function groundedRunner(
  retrieveEvidence: (question: string) => Promise<GroundedEvidence>,
  answer: GroundedAnswerFn,
): StreamAnswerFn {
  return async (question, deps) => {
    // Never `searching`. The phase enum has one, and a grounded run announcing
    // it would be claiming a search it did not do.
    deps.onStatus({ phase: 'reading', detail: 'the world model, findings, the Brain and the ledger' });
    const evidence = await retrieveEvidence(question);

    // Phase A. Free and synchronous: internal spans were proven the day they
    // were written, so there is no extraction pass to pay for.
    deps.onStatus({ phase: 'attributing', detail: `${evidence.records.length} internal record(s)` });
    const universe = groundedUniverse(question, evidence.records);
    for (const source of groundedSourceEvents(universe)) deps.onSource(source);
    for (const span of groundedSpanEvents(universe)) deps.onSpan(span);

    if (universe.spans.length === 0) {
      // A legitimate outcome, and the honest one. Falling back to the web here
      // would silently answer a different question — the reader asked what WE
      // know — while wearing grounded mode's badge. `universe.note` already
      // distinguishes "we hold nothing" from "we hold things and none can be
      // quoted" from "all we have is a forecast", so it is relayed rather than
      // replaced with a line of this route's own.
      return {
        text: '',
        costCents: 0,
        sources: groundedDocs(universe),
        queries: [],
        note: universe.note,
        unanswered: [...evidence.excluded],
      };
    }

    const result = await answer(question, {
      ask: deps.ask,
      askStream: deps.askStream,
      universe,
      excluded: evidence.excluded,
      history: deps.history,
      onStatus: deps.onStatus,
      onDelta: deps.onDelta,
      onSentence: deps.onSentence,
    });

    return {
      ...result,
      // The retrieval record, so a thread reopened tomorrow still shows which
      // of our own rows it rested on. `queries` stays empty: none were run.
      sources: result.sources ?? groundedDocs(universe),
      queries: result.queries ?? [],
      unanswered: [...(result.unanswered ?? []), ...evidence.excluded],
    };
  };
}

/* ── verified mode: the strict gate, reachable at last ──────────────────── */

type ResearchFn = (question: string, deps: ResearchDeps) => Promise<ResearchAnswer>;

/** Shown on the source card. A URL we cannot parse is one we still fetched. */
const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Markers ride inside the sentence, before its final stop, the way the fast
 *  pipeline emits them — so one renderer handles both modes. */
function withMarkers(claim: string, markers: readonly number[]): string {
  const tag = markers.map((n) => `[${n}]`).join('');
  const body = claim.trim();
  if (tag === '') return body;
  return /[.!?]$/.test(body) ? `${body.slice(0, -1)} ${tag}${body.slice(-1)}` : `${body} ${tag}.`;
}

/**
 * VERIFIED MODE, ON THE SAME WIRE AS FAST MODE.
 *
 * `research()` is unchanged — it is the asset, and §2 of the plan keeps it as
 * the second mode precisely because it is slower and stricter. What is new is
 * the adapter: its `Point[]` becomes numbered spans, one sentence per point,
 * emitted through the same `source`/`span`/`delta`/`sentence` contract the
 * browser already renders.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO:
 *
 *  1. **It does not stream.** Nothing is emitted until the whole answer has
 *     passed the gate, because that IS Verified mode. Emitting the events at
 *     the end is the design, not a shortcut.
 *  2. **It never sends `summary`.** `research()` returns the model's own
 *     prose alongside the points, and that prose is NOT verified — only the
 *     points are. Putting it on the wire would slip unchecked generative text
 *     into the mode whose entire promise is that nothing unchecked is shown.
 *     The answer is assembled from the surviving claims, by us, deterministically.
 *  3. **It does not assume `confirmed`.** Every assembled sentence goes through
 *     `checkSentence` — the same function fast mode uses — so a badge means the
 *     same thing in both modes. `verifyPoints` should already have guaranteed
 *     it; running the check anyway is what stops the two gates drifting into
 *     one badge with two meanings, and it adds the causal lint `research()`
 *     has never run.
 */
export function verifiedRunner(run: ResearchFn): StreamAnswerFn {
  return async (question, deps) => {
    deps.onStatus({ phase: 'planning' });
    const answer = await run(question, {
      ask: deps.ask,
      search: deps.search,
      read: deps.read,
      onStep: (line) => deps.onStatus({ phase: 'reading', detail: line }),
    });

    const indexOf = new Map<string, number>();
    answer.sources.forEach((doc, i) => {
      indexOf.set(doc.url, i + 1);
      deps.onSource({ i: i + 1, url: doc.url, title: doc.title, domain: domainOf(doc.url), kind: 'web' });
    });

    /* Points → spans. One id per distinct quote, so a quote cited by two claims
     * is one number and one card, exactly as attribution numbers a universe. */
    deps.onStatus({ phase: 'attributing', detail: `${answer.points.length} verified point(s)` });
    const spans: CitableSpan[] = [];
    const idOf = new Map<string, number>();
    const markersFor = (point: Point): number[] => {
      const out: number[] = [];
      for (const c of point.citations) {
        const docIndex = indexOf.get(c.url);
        if (docIndex === undefined) continue;
        const key = `${docIndex}\u0000${c.span}`;
        let id = idOf.get(key);
        if (id === undefined) {
          id = spans.length + 1;
          idOf.set(key, id);
          const span: CitableSpan = { id, docIndex, url: c.url, span: c.span };
          spans.push(span);
          deps.onSpan({ id, sourceIndex: docIndex, quote: c.span });
        }
        if (!out.includes(id)) out.push(id);
      }
      return out;
    };

    deps.onStatus({ phase: 'writing' });
    const written: string[] = [];
    let flagged = 0;
    answer.points.forEach((point, i) => {
      const n = i + 1;
      const text = withMarkers(point.claim, markersFor(point));
      written.push(text);
      deps.onDelta({ n, text: i === 0 ? text : ` ${text}` });
      const verdict = checkSentence(n, text, spans);
      if (verdict.verdict === 'flagged') flagged += 1;
      deps.onSentence(verdict);
    });

    deps.onStatus({ phase: 'checking', detail: `${answer.dropped.length} claim(s) dropped by the gate` });

    return {
      text: written.join(' '),
      costCents: answer.costCents,
      sources: answer.sources,
      queries: answer.queries,
      unanswered: answer.unanswered,
      points: answer.points,
      droppedClaims: answer.dropped,
      flagged,
      // Written here, never lifted from `answer.summary` — an unverified
      // summary stored as the message body is the "empty answer replayed as a
      // lie" bug with a longer sentence.
      ...(answer.points.length === 0
        ? {
            note:
              answer.dropped.length > 0
                ? `Verified mode kept nothing: all ${answer.dropped.length} claim(s) were refused because their evidence did not check out. The refusals are listed below.`
                : 'Verified mode found nothing it could quote for that question.',
          }
        : {}),
    };
  };
}

const VERIFIED_ANSWER: StreamAnswerFn = verifiedRunner(research);

/* ── the concurrency guard ──────────────────────────────────────────────── */

/**
 * Two answers at once, and what each kind actually costs.
 *
 * `runner.ts` refuses a concurrent worker pass because two passes interleaved
 * can lose a real competitor change by classifying it as already-seen. Nothing
 * that severe happens here — but two other things do, and they are the reason
 * the ceiling is not simply "as many as you like":
 *
 *  - **Same thread.** `appendMessage` assigns `seq` under the thread's row lock,
 *    so two answers on one thread do not corrupt the numbering — they serialise
 *    on it, and then interleave as user, user, assistant, assistant. The thread
 *    reads as two questions followed by two answers with no way to tell which
 *    answered which. Refused.
 *  - **Same question, no thread.** This is the reported failure: N tabs is N
 *    concurrent paid runs, and the common case is one tab reloaded during a
 *    60-second answer, which carries no thread id to collide on. Normalising
 *    the question is what makes those two requests the same key.
 *
 * Different questions genuinely are different work, so they are allowed to run
 * alongside — up to a small ceiling, because the remaining cost of concurrency
 * is money and the budget ledger is checked per-run at admission, not
 * continuously. Two in flight can each pass a pre-flight the pair of them will
 * then exceed. The cap bounds how far that can drift.
 *
 * A queue would be worse, for `runner.ts`'s reason: somebody asked a question
 * and a run that starts several minutes later against a stale page is not what
 * they asked for.
 */
const MAX_CONCURRENT_ANSWERS = 2;

export class AnswerBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerBusy';
  }
}

/** Whitespace and case are not the question. A reload is the same run. */
export function answerKey(threadId: string | null, question: string): string {
  if (threadId !== null && threadId !== '') return `thread:${threadId}`;
  return `q:${question.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

export class AnswerGuard {
  private readonly inFlight = new Set<string>();

  constructor(private readonly maxConcurrent: number = MAX_CONCURRENT_ANSWERS) {}

  size(): number {
    return this.inFlight.size;
  }

  /** Claims a slot, returning the release. Throws `AnswerBusy` if refused. */
  begin(key: string): () => void {
    if (this.inFlight.has(key)) {
      throw new AnswerBusy(
        'that question is already being answered — watching it is free, asking again is not. ' +
          'Wait for it, or reload to rejoin the run in flight.',
      );
    }
    if (this.inFlight.size >= this.maxConcurrent) {
      throw new AnswerBusy(
        `${this.maxConcurrent} answers are already running, and each one is a paid search-and-read pass. ` +
          'Wait for one to finish.',
      );
    }
    this.inFlight.add(key);
    let released = false;
    return () => {
      // Idempotent: the release runs in a `finally` that also runs on the error
      // path, and a second call must not free somebody else's later slot.
      if (released) return;
      released = true;
      this.inFlight.delete(key);
    };
  }
}

/* ── small pure pieces ──────────────────────────────────────────────────── */

/** The thread's name, before anyone renames it. `title_source = 'question'`
 *  records that it is a derivation, so a later auto-titler may replace it and a
 *  human rename may not be replaced. */
export function titleFor(question: string): string {
  const one = question.replace(/\s+/g, ' ').trim();
  if (one === '') return 'Untitled question';
  return one.length <= 80 ? one : `${one.slice(0, 79).trimEnd()}…`;
}

/**
 * The `[N]` markers the prose actually used, resolved to their spans.
 *
 * Only markers that appear in the text become citations. A span in the citable
 * universe that the model never cited is not a citation — storing it would put
 * a source under an answer that never rested on it, which is the "real source
 * attached to a claim it never made" failure in miniature, committed by us
 * rather than by the model.
 *
 * A marker with no span is dropped rather than repaired. Guessing which quote
 * `[7]` meant is this route inventing attribution, and the whole design rests on
 * the URL being retrieved and never generated.
 */
export function citationsFor(
  text: string,
  spans: readonly SpanEvent[],
  sources: readonly SourceEvent[],
): CitationRecord[] {
  const out: CitationRecord[] = [];
  const seen = new Set<number>();

  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(match[1]);
    // A repeat is one citation: `appendMessage` refuses two rows at the same
    // ordinal outright, and a refused append aborts the whole turn.
    if (!Number.isInteger(n) || n < 1 || seen.has(n)) continue;

    const span = spans.find((s) => s.id === n);
    if (!span) continue;
    const source = sources.find((s) => s.i === span.sourceIndex);
    if (!source || source.url.trim() === '' || span.quote.trim() === '') continue;

    seen.add(n);
    out.push({ ordinal: n, sourceUrl: source.url, span: span.quote, title: source.title });
  }
  return out;
}

/**
 * HOW MUCH OF A THREAD A FOLLOW-UP IS ANSWERED AGAINST.
 *
 * A thread grows without bound and a prompt does not, so something has to give.
 * The choice made here is that IT IS ALWAYS A CONTIGUOUS SUFFIX — the newest N
 * turns, whole — and never a sample, a summary, or the head plus the tail.
 *
 * The reason is what a follow-up MEANS. "And in Vancouver?" is defined entirely
 * by the turn before it; "why is that different from what you said earlier?"
 * is defined by two turns that must both be present and adjacent. Dropping a
 * turn out of the MIDDLE leaves a history that still reads as a conversation
 * and is a different conversation from the one the user is looking at — the
 * model has no way to notice the seam, and neither does the reader. Dropping
 * from the OLDEST end is visible in the thread view and degrades in the
 * direction follow-ups actually point: backwards, and not very far.
 *
 * The numbers: at most `MAX_HISTORY_TURNS` turns, and at most
 * `MAX_HISTORY_CHARS` of question-plus-answer text across them, whichever binds
 * first. Roughly 3k tokens of the ~8k a planning call can afford, leaving room
 * for the plan prompt and the new question. Both are deliberately small: a
 * planner needs the shape of the conversation, not a transcript.
 *
 * TURNS ARE NEVER CUT IN HALF. If the newest turn alone exceeds the budget it
 * is still sent whole, because a follow-up is almost always about that turn and
 * half an answer is not a shorter answer — it is a different one, missing
 * exactly the markers a question like "where did that price come from?" is
 * about.
 *
 * A question whose run died before it was answered is dropped rather than sent
 * with an empty answer: `appendMessage` writes the user turn before the
 * pipeline runs (deliberately — see `runAnswerStream`), so an unanswered
 * question in the thread is a crash, and feeding it back as a turn tells the
 * planner it was answered with silence.
 */
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 12_000;

/** What the last turn read, so a follow-up can reuse rather than re-fetch. The
 *  documents first, then any cited URL not among them — a citation whose
 *  document did not survive into the payload is still a page we read. */
function sourceUrlsFor(m: MessageRecord): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const all = [
    ...(m.answer?.sources ?? []).map((d) => d.url),
    ...m.citations.map((c) => c.sourceUrl),
  ];
  for (const raw of all) {
    const url = raw.trim();
    if (url === '' || seen.has(url)) continue;
    // Only fetchable pages. A grounded turn stores LOCATORS here — `finding ·
    // f-1`, `20-architecture/SYSTEM.md § Roles` — and the follow-up planner
    // hands this list to the reader as pages to re-read. A locator would be
    // fetched, fail, and count against the run's page budget for nothing.
    if (!/^https?:\/\//i.test(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function historyFor(detail: ThreadDetail): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let question: string | null = null;

  for (const m of detail.messages) {
    if (m.role === 'user') {
      question = m.body;
      continue;
    }
    // An assistant message with no question before it cannot be paired, and
    // pairing it with an older one would attribute an answer to the wrong ask.
    if (question === null) continue;
    // The answer goes back AS RENDERED, `[N]` markers intact — `events.ts` says
    // why: a follow-up like "where did that number come from?" is about the
    // marker, and a history that quietly deleted it cannot answer.
    turns.push({ question, answer: m.body, sourceUrls: sourceUrlsFor(m) });
    question = null;
  }

  const kept: ConversationTurn[] = [];
  let chars = 0;
  for (const turn of [...turns.slice(-MAX_HISTORY_TURNS)].reverse()) {
    const size = turn.question.length + turn.answer.length;
    // The newest turn is admitted whatever it costs; every older one has to fit.
    if (kept.length > 0 && chars + size > MAX_HISTORY_CHARS) break;
    kept.unshift(turn);
    chars += size;
  }
  return kept;
}

/**
 * The `epilogue` frame — see the header for the wire shape and why it is not
 * more fields on `done`.
 *
 * Returns null when there is nothing to say, and the route then sends nothing:
 * an empty epilogue is a frame the UI has to decide to ignore, and the sections
 * it feeds (Not answerable, related questions) are absent rather than empty
 * when a run had neither.
 */
export interface EpilogueEvent {
  readonly unanswered: readonly string[];
  readonly note: string;
  readonly related: readonly string[];
}

const cleaned = (xs: readonly string[] | undefined): string[] =>
  (xs ?? []).map((x) => x.trim()).filter((x) => x !== '');

export function epilogueFor(result: StreamAnswerResult): EpilogueEvent | null {
  const unanswered = cleaned(result.unanswered);
  const note = (result.note ?? '').trim();
  // Relayed, never authored. `related` is empty until the pipeline returns some.
  const related = cleaned(result.related);
  if (unanswered.length === 0 && note === '' && related.length === 0) return null;
  return { unanswered, note, related };
}

/** The pipeline's own note when it wrote nothing, a generic line when it had
 *  none, and the prose otherwise. */
function bodyFor(result: StreamAnswerResult): string {
  if (result.text.trim() !== '') return result.text;
  const note = (result.note ?? '').trim();
  return note !== ''
    ? note
    : 'The documents this run read carried nothing quotable for that question.';
}

/**
 * What goes in `message.answer`.
 *
 * `points` and `dropped` stay EMPTY, and that is not a gap being papered over:
 * they are Verified mode's shape — a whole-answer gate producing `Point`s — and
 * a fast run genuinely makes none. Filling them by casting the dropped SPANS
 * into dropped CLAIMS would store one kind of refusal under another kind's
 * name, which is the sort of quiet re-labelling this system exists to refuse.
 *
 * What is worth keeping is the retrieval record: the documents read and the
 * queries run, so a thread reopened tomorrow can still show its source strip
 * and what was actually searched. The citations carry the cited spans; this
 * carries the rest of the run.
 */
function answerPayloadFor(result: StreamAnswerResult): AnswerPayload | null {
  if (result.sources === undefined && result.queries === undefined) return null;
  return {
    // Empty for fast and grounded runs, which genuinely produce no `Point`;
    // populated for Verified mode, where the gate's kept and refused claims ARE
    // the answer and dropping them would delete the mode's whole output.
    points: result.points ?? [],
    dropped: result.droppedClaims ?? [],
    unanswered: result.unanswered ?? [],
    sources: result.sources ?? [],
    queries: result.queries ?? [],
  };
}

/* ── the run ────────────────────────────────────────────────────────────── */

/** The store, narrowed to the three calls a turn makes. A port rather than the
 *  module, so the persistence order is provable without Postgres. */
export interface AnswerStore {
  createThread(t: NewThread): Promise<ThreadRecord>;
  getThread(id: string): Promise<ThreadDetail | null>;
  appendMessage(m: NewMessage): Promise<MessageRecord>;
}

interface AnswerParams {
  readonly question: string;
  /** Non-null continues an existing thread. A follow-up, not a new question. */
  readonly threadId: string | null;
  /** Absent is `web`, which is what every request sent before 2026-08-31. */
  readonly mode?: AnswerMode;
}

export interface AnswerDeps {
  readonly store: AnswerStore;
  readonly guard: AnswerGuard;
  /** Web mode. Named as it always was, so nothing that wired this breaks. */
  readonly streamAnswer: StreamAnswerFn;
  /**
   * The other two modes, optional so a caller can decline to offer one.
   *
   * A mode with no runner is REFUSED by name rather than quietly answered the
   * default way: somebody who asked for Verified and silently got Fast has been
   * told a weaker answer is a stronger one, which is the failure this whole
   * package is organised against.
   */
  readonly groundedAnswer?: StreamAnswerFn;
  readonly verifiedAnswer?: StreamAnswerFn;
  readonly ports: AnswerPorts;
  /** Joins every `ai_usage_log` row this run writes to the message it paid for. */
  readonly runId: string;
  readonly now: () => Date;
  readonly newId: () => string;
  /** The day's ledger, or the reason it refuses. Null means go. */
  readonly checkBudget: () => string | null;
  readonly noteCost: (costCents: number) => void;
}

/** The runner this mode needs, or null when the caller did not supply one. */
function runnerFor(mode: AnswerMode, deps: AnswerDeps): StreamAnswerFn | null {
  if (mode === 'grounded') return deps.groundedAnswer ?? null;
  if (mode === 'verified') return deps.verifiedAnswer ?? null;
  return deps.streamAnswer;
}

/** Below this there is no question to plan searches from. Same floor as
 *  `/api/research`, for the same reason. */
const MIN_QUESTION_CHARS = 8;

/**
 * One turn, start to finish.
 *
 * ORDER IS LOAD-BEARING in three places:
 *
 *  1. The question is validated and the budget checked BEFORE a thread exists,
 *     so a refused day leaves no trail of empty threads behind it.
 *  2. The guard is claimed SYNCHRONOUSLY, before the first `await`. A second
 *     request that arrives while the first is between two awaits must still be
 *     refused, and an async check would let both through.
 *  3. The user message is written BEFORE the pipeline runs. A run that dies
 *     halfway then leaves a thread showing what was asked and no answer, which
 *     is the truth. Writing it afterwards loses the question entirely.
 */
export async function runAnswerStream(
  sink: SseSink,
  params: AnswerParams,
  deps: AnswerDeps,
): Promise<void> {
  const question = params.question.trim();
  if (question.length < MIN_QUESTION_CHARS) {
    send(sink, 'error_msg', 'Ask a fuller question — a few words cannot be turned into a search.');
    return;
  }

  // Before the budget and before the thread: a mode this server cannot run is
  // not a question that should cost anything or leave a thread behind.
  const mode = params.mode ?? 'web';
  const runner = runnerFor(mode, deps);
  if (runner === null) {
    send(sink, 'error_msg', `${mode} mode is not available on this server, and answering in another mode would be answering a different question.`);
    return;
  }

  const refusal = deps.checkBudget();
  if (refusal !== null) {
    send(sink, 'error_msg', `Refused by the daily budget: ${refusal}`);
    return;
  }

  let release: () => void;
  try {
    release = deps.guard.begin(answerKey(params.threadId, question));
  } catch (err) {
    if (err instanceof AnswerBusy) {
      send(sink, 'error_msg', err.message);
      return;
    }
    throw err;
  }

  // Collected as the pipeline emits them: the citations written to the message
  // are resolved from the SAME spans and sources the reader was shown, so what
  // is stored cannot disagree with what streamed.
  const sources: SourceEvent[] = [];
  const spans: SpanEvent[] = [];
  let flagged = 0;

  const relay = {
    onStatus: (e: StatusEvent) => send(sink, 'status', e),
    onSource: (e: SourceEvent) => {
      sources.push(e);
      send(sink, 'source', e);
    },
    onSpan: (e: SpanEvent) => {
      spans.push(e);
      send(sink, 'span', e);
    },
    onDelta: (e: DeltaEvent) => send(sink, 'delta', e),
    onSentence: (e: SentenceEvent) => {
      if (e.verdict === 'flagged') flagged += 1;
      send(sink, 'sentence', e);
    },
  };

  try {
    /* 1 ─ the thread */
    let threadId: string;
    let history: readonly ConversationTurn[] = [];

    if (params.threadId !== null && params.threadId !== '') {
      const existing = await deps.store.getThread(params.threadId);
      if (existing === null) {
        send(
          sink,
          'error_msg',
          'That conversation no longer exists — it was deleted. Ask the question again to start a new one.',
        );
        return;
      }
      threadId = existing.id;
      // Loaded BEFORE the new question is appended, so the thread the planner
      // sees is the conversation as it stood when the follow-up was asked.
      history = historyFor(existing);
    } else {
      const created = await deps.store.createThread({
        id: deps.newId(),
        title: titleFor(question),
        titleSource: 'question',
        createdAt: deps.now().toISOString(),
      });
      threadId = created.id;
    }

    /* 2 ─ the question, recorded before it is answered */
    await deps.store.appendMessage({
      id: deps.newId(),
      threadId,
      role: 'user',
      body: question,
      createdAt: deps.now().toISOString(),
    });

    /* 3 ─ the pipeline for the mode that was asked for */
    const result = await runner(question, { ...deps.ports, history, ...relay });

    /* 4 ─ the answer, with the markers it actually used */
    const messageId = deps.newId();
    await deps.store.appendMessage({
      id: messageId,
      threadId,
      role: 'assistant',
      // `appendMessage` refuses a blank body, and an empty answer is a real
      // outcome — an empty citable universe produces no prose. The pipeline's
      // own note says WHY it is empty, so it is preferred over a generic line;
      // naming it either way beats aborting the turn and losing the question.
      body: bodyFor(result),
      // `grounded` collapses to `fast` here — see `messageMode`.
      mode: messageMode(mode),
      runId: deps.runId,
      costCents: result.costCents,
      answer: answerPayloadFor(result),
      citations: citationsFor(result.text, spans, sources),
      createdAt: deps.now().toISOString(),
    });

    deps.noteCost(result.costCents);

    // Before `done`, so a UI that renders on `done` already has the refusals
    // and the related questions in hand rather than reflowing a beat later.
    const epilogue = epilogueFor(result);
    if (epilogue !== null) send(sink, 'epilogue', epilogue);

    send(sink, 'done', {
      costCents: result.costCents,
      threadId,
      messageId,
      // Surfaced, never swallowed: a flagged sentence is "we could not confirm
      // this from the spans it cites", and hiding the count is how a weaker
      // answer comes to look like a stronger one.
      flagged: result.flagged ?? flagged,
    });
  } catch (err) {
    send(sink, 'error_msg', err instanceof Error ? err.message : String(err));
  } finally {
    release();
  }
}

/* ── the wiring ─────────────────────────────────────────────────────────── */

/** Process-wide: the guard is only a guard if every request consults the same
 *  one. */
const GUARD = new AnswerGuard();

/**
 * What one answer is assumed to cost at the door.
 *
 * A research question has run 0.19¢ of synthesis in practice, and search is
 * billed per call on top. This is deliberately a small, generous estimate: the
 * pre-flight exists to refuse a run on a day that is ALREADY spent, not to
 * predict the bill. The real per-call ceiling lives in `callGroq` and is not
 * being replaced here.
 */
const ESTIMATED_ANSWER_COST_CENTS = 5;

const PG_STORE: AnswerStore = { createThread, getThread, appendMessage };

/**
 * GET, because `EventSource` cannot POST. The question rides in the query
 * string and is never logged anywhere a URL would be.
 */
export async function runAnswer(
  res: ServerResponse,
  question: string,
  threadId: string | null,
  mode: AnswerMode = 'web',
): Promise<void> {
  openSse(res);

  const env = loadEnv();
  const providers = searchProvidersFromEnv();
  // Grounded mode reads our own records and never a provider, so a console with
  // no search key can still answer "what do we know about X" — which is, for a
  // system whose whole point is the evidence it already holds, the more
  // important half. Web and Verified both search and both still refuse.
  if (providers.length === 0 && mode !== 'grounded') {
    send(res, 'error_msg', 'No search provider configured. Set TAVILY_API_KEY or EXA_API_KEY.');
    res.end();
    return;
  }

  const runId = randomUUID();
  const limits: BudgetLimits = {
    maxRunTokens: env.TMOS_MAX_RUN_TOKENS,
    maxDailyCostCents: env.TMOS_MAX_DAILY_COST_CENTS,
    maxToolDepth: env.TMOS_MAX_TOOL_DEPTH,
  };

  const askConfig = {
    apiKey: env.GROQ_API_KEY ?? '',
    limits,
    runId,
    // Every model call, success or refusal, lands in the table the daily
    // ceiling is rebuilt from. A run that spends without logging silently
    // raises tomorrow's budget — see `budget-boot.ts`.
    onUsage: async (usage: { promptTokens: number; completionTokens: number; costCents: number }, model: string) => {
      await db().execute(sql`
        insert into ai_usage_log (run_id, provider, model, tokens_in, tokens_out, cost_cents, outcome, reason)
        values (${runId}, 'groq', ${model}, ${usage.promptTokens}, ${usage.completionTokens},
                ${usage.costCents}, 'allowed', 'answer')`);
    },
  };

  const budget = await dailyBudget();

  await runAnswerStream(
    res,
    { question, threadId, mode },
    {
      store: PG_STORE,
      guard: GUARD,
      streamAnswer: STREAM_ANSWER,
      // Retrieval is real and runs today; `GROUNDED_ANSWER` is the open seam
      // and refuses rather than writing prose it cannot cite.
      groundedAnswer: groundedRunner(
        (q) => retrieveGrounded(q, createPostgresGroundedReader()),
        GROUNDED_ANSWER,
      ),
      verifiedAnswer: VERIFIED_ANSWER,
      ports: {
        ask: createAsk(askConfig),
        askStream: createAskStream(askConfig),
        search: providers,
        read: createResearchReader(),
      },
      runId,
      now: () => new Date(),
      newId: randomUUID,
      checkBudget: () => refuseForBudget(budget, limits, ESTIMATED_ANSWER_COST_CENTS, new Date()),
      noteCost: (costCents) => noteSpend(budget, runId, costCents, new Date()),
    },
  );

  res.end();
}
