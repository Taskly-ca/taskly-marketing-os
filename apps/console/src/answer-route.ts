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
 */
import type { ServerResponse } from 'node:http';
import { streamAnswer } from '@tmos/research';
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
  type MessageRole,
  type NewMessage,
  type NewThread,
  type ThreadDetail,
  type ThreadRecord,
} from '@tmos/adapters';
import type {
  AskPort,
  AskStreamPort,
  DeltaEvent,
  ReadDoc,
  ReadPort,
  SearchPort,
  SentenceEvent,
  SourceEvent,
  SpanEvent,
  StatusEvent,
} from '@tmos/research';

import { dailyBudget, noteSpend, refuseForBudget } from './budget-boot.js';
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

/** One prior turn, oldest first — a follow-up is answered in context or it is
 *  not a follow-up. */
interface AnswerTurn {
  readonly role: MessageRole;
  readonly body: string;
}

export interface StreamAnswerDeps extends AnswerPorts {
  /** Part 5. Passed now because reading it is the route's job either way, and
   *  a pipeline that ignores a field costs nothing. */
  readonly history: readonly AnswerTurn[];
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
  readonly flagged?: number;
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
    points: [],
    dropped: [],
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
}

export interface AnswerDeps {
  readonly store: AnswerStore;
  readonly guard: AnswerGuard;
  readonly streamAnswer: StreamAnswerFn;
  readonly ports: AnswerPorts;
  /** Joins every `ai_usage_log` row this run writes to the message it paid for. */
  readonly runId: string;
  readonly now: () => Date;
  readonly newId: () => string;
  /** The day's ledger, or the reason it refuses. Null means go. */
  readonly checkBudget: () => string | null;
  readonly noteCost: (costCents: number) => void;
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
    let history: readonly AnswerTurn[] = [];

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
      history = existing.messages.map((m) => ({ role: m.role, body: m.body }));
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

    /* 3 ─ the pipeline */
    const result = await deps.streamAnswer(question, { ...deps.ports, history, ...relay });

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
      mode: 'fast',
      runId: deps.runId,
      costCents: result.costCents,
      answer: answerPayloadFor(result),
      citations: citationsFor(result.text, spans, sources),
      createdAt: deps.now().toISOString(),
    });

    deps.noteCost(result.costCents);
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
): Promise<void> {
  openSse(res);

  const env = loadEnv();
  const providers = searchProvidersFromEnv();
  if (providers.length === 0) {
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
    { question, threadId },
    {
      store: PG_STORE,
      guard: GUARD,
      streamAnswer: STREAM_ANSWER,
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
