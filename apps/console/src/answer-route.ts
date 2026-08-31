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
 * `dropped` spans are deliberately NOT here: on the web path they are
 * attribution's refusals, they arrive per-span while the answer is still being
 * built, and the frame they belong on is a per-span one rather than a summary
 * at the end.
 *
 * ── AND ONE MORE, FOR GROUNDED MODE: `unused` ──────────────────────────────
 *
 *   event: unused
 *   data:  { dropped:      [{ span: string, why: string }],
 *            expectations: [{ id, locator, title, claim, p, resolveAt }] }
 *
 * Emitted AT MOST ONCE per run, only by grounded mode, only when at least one
 * of the two lists carries something — and, unlike `epilogue`, EARLY: right
 * after the last `span` and before the first `delta`. Both lists are facts
 * about the EVIDENCE, true the moment phase A finishes, so the reader gets the
 * refusals beside the source strip while the prose is still arriving. That is
 * the same argument §3 makes for sources landing before prose. `epilogue` is
 * about the answer; this is about what the answer was allowed to rest on.
 *
 * A sibling rather than three more fields on `epilogue`, for the reason
 * `epilogue` is itself a sibling of `done`: these arrive at a different moment
 * and mean a different thing, and one frame carrying "what the run could not
 * answer" next to "which of our own rows failed a check" is one frame with two
 * jobs. A reader that does not know this event ignores the frame and loses
 * nothing it had — which is what SSE does with an unregistered event type.
 *
 * THE TWO LISTS ARE SEPARATE BECAUSE THEY ARE SEPARATE THINGS, and a renderer
 * that merges them undoes the one distinction grounded mode can only enforce at
 * selection time — phase B is told every span is already proven and phase C's
 * number check would happily confirm a figure that genuinely is in a ledger
 * row, so both are blind to it:
 *
 *  - `dropped` — a record that COULD have been evidence and failed a check: a
 *    fact stored with no snippet, a superseded finding, a draft Brain passage,
 *    a passage too long to narrow to a citable span. §7 item 1 is that showing
 *    these is the most honest thing this system does and the most tempting
 *    thing to delete for a cleaner screen. The UI currently says "no drop stage
 *    on a grounded run", which was true only while this frame did not exist.
 *  - `expectations` — open rows from the prediction ledger. NOT refusals: a
 *    forecast never entered the contest, because it is not an observation and
 *    may never be cited. Shown so a reader can see what we expect, under a
 *    heading that says so — and never under "Dropped".
 *
 * NOT PERSISTED, which is a real limitation rather than a decision: a reopened
 * thread does not replay this frame. `message.answer` has exactly one `dropped`
 * field and it holds Verified mode's refused CLAIMS; putting span-level
 * refusals in it would file one kind of refusal under another kind's name,
 * which is the re-labelling `answerPayloadFor` already refuses to do.
 *
 * ── DEEP MODE: FOUR CONTRACT EVENTS, RELAYED AND NOT RESHAPED ──────────────
 *
 * `plan`, `step`, `reflect` and `clarify` are `events.ts`'s, not this route's,
 * and the difference from `epilogue`/`unused` above is the whole point: those
 * two are frames this file INVENTED because no contract carried them. These
 * four already exist, `DEEP_EVENTS` names them, and the route's only job is to
 * put each payload on the wire under its own name, byte for byte. Anything this
 * file adds to a `PlanEvent` on the way past is a second contract.
 *
 * They are relayed for deep mode alone. A web or grounded run is handed the
 * callbacks (one deps object is composed per request) and never calls them,
 * exactly as it is handed `onUnused` and never calls it — and a reader must
 * read "no `plan` frame" as "this mode does not plan", never as "the plan was
 * empty".
 *
 * ── THE CLARIFY ROUND TRIP ─────────────────────────────────────────────────
 *
 * `ClarifyEvent` ENDS the stream: SSE has no upstream channel, so the replies
 * arrive as a NEW request. The whole design is four decisions:
 *
 *  1. **They ride in as repeated `a=` query parameters, POSITIONALLY.**
 *     `ClarifyEvent` is `{questions: string[], because}` — no ids — so position
 *     is the only correspondence the contract offers, and minting a key here
 *     would be inventing the half of a contract the pipeline does not share.
 *     Which is why `parseClarifications` keeps an INTERIOR blank: a skipped
 *     question that is dropped rather than held shifts every later answer onto
 *     the wrong question, and nothing downstream can see that it happened.
 *  2. **They reach the pipeline as answers, never as the question.** They are
 *     a field on `DeepAnswerDeps`, not text concatenated onto `q`. Concatenating
 *     would make "Toronto only" a phrase the writer sees, and the run's own
 *     question would no longer be the one the reader typed.
 *  3. **They are evidence of nothing.** Clarifications are reader-authored text
 *     arriving in a URL. They may shape the plan — that is what they are for —
 *     and they may never be quoted, cited or carried into generation as fact.
 *     Same boundary as `history`, for the same reason, and the enforcement is
 *     the same one: the shape. There is no span, no source and no citation a
 *     clarification can become.
 *  4. **They are capped** — `MAX_CLARIFICATIONS`, and a length per reply. A GET
 *     parameter that reaches a planner prompt is untrusted input with a token
 *     bill attached.
 *
 * ── AND WHAT AN UNANSWERED CLARIFY LEAVES BEHIND: A REAL TURN ──────────────
 *
 * Decided deliberately, because the alternative is defensible. By the time the
 * pipeline can ask, the thread and the user message already exist — the clarify
 * is a pre-retrieval gate INSIDE the run, and the run's question is recorded
 * before the run starts (see `runAnswerStream`'s ordering note). So the choice
 * is not "leave a trace or not"; it is what the trace SAYS.
 *
 * The route writes the clarifying questions as the assistant turn. Three
 * reasons, in order of how much they matter:
 *
 *  - **Otherwise an abandoned clarify is indistinguishable from a crash.** A
 *    thread holding a question and no answer is exactly what a run that died
 *    halfway leaves, and `historyFor` drops such a question rather than report
 *    it answered with silence. Two very different events would arrive at the
 *    reader, and at us, wearing one shape.
 *  - **The questions have to survive the tab closing.** A clarify asked at
 *    minute zero and answered tomorrow has lost the questions it was answering
 *    if they lived only in a stream that ended.
 *  - **It is what happened.** Somebody asked, and we asked back. A thread that
 *    renders that is a record; a thread that renders half of it is clutter, and
 *    the clutter reading comes from storing the question alone.
 *
 * The replies then ride into a SECOND request, whose user turn is stored as the
 * question with the replies under it (`userBodyFor`) — so one exchange spread
 * over two HTTP requests reads back as one exchange. Nothing is rewritten: the
 * reader typed both halves.
 *
 * WHAT IS NOT SOLVED. The clarify turn re-enters a later follow-up's context
 * through `historyFor` as a turn whose "answer" is a set of questions. That is
 * accurate — it carries no claim and no figure — but it is a turn shape the
 * planner has never been shown before, and nothing here proves it plans well
 * against one.
 */
import type { ServerResponse } from 'node:http';
import {
  checkSentence,
  groundedDocs,
  groundedSourceEvents,
  groundedSpanEvents,
  groundedUniverse,
  planSearches,
  research,
  streamAnswer,
  streamDeep,
  streamGrounded,
  DEFAULT_DEEP_BUDGET,
} from '@tmos/research';
import { randomUUID } from 'node:crypto';

import { db, sql } from '@tmos/db';
import { DEFAULT_PACK_ID, packById } from '@tmos/packs';
import { estimateCostCents, loadEnv, MODELS, type BudgetLimits } from '@tmos/shared';
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
  ClarifyEvent,
  ConversationTurn,
  DeltaEvent,
  Dropped,
  DroppedSpan,
  Expectation,
  PlanEvent,
  Point,
  ReadDoc,
  ReadPort,
  ReflectEvent,
  GroundedUniverse,
  ResearchAnswer,
  ResearchDeps,
  SearchPort,
  SentenceEvent,
  SourceEvent,
  SpanEvent,
  StatusEvent,
  StepEvent,
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
  /** The pack's one line naming whose interests the queries serve. Optional:
   *  absent plans exactly as this did before 2026-08-31, asserted by test. */
  readonly subject?: string;
}

/**
 * The `unused` frame — see the header for the wire shape, the timing, and why
 * an expectation is not a refusal.
 *
 * Both fields are relayed exactly as `groundedUniverse` produced them. Nothing
 * here re-words a refusal: `grounded.ts` writes the `why` on a dropped record
 * and it is the sentence a reader acts on, so a second phrasing composed at the
 * wire would be a second place for "a draft may not be cited" to be wrong.
 */
export interface UnusedEvent {
  readonly dropped: readonly DroppedSpan[];
  readonly expectations: readonly Expectation[];
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
  /**
   * Phase A's refusals and the forecasts it is holding. Grounded mode calls it;
   * the web pipeline does not, and is not being asked to — `StreamDeps` has no
   * such field, so `streamAnswer` receives a dep it cannot see, exactly as it
   * received `history` before `stream.ts` grew a matching one. A web run
   * therefore emits no `unused` frame, and a UI must read "no frame" as "this
   * mode does not report that", never as "nothing was refused".
   */
  readonly onUnused: (e: UnusedEvent) => void;
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
 *  - `deep` — Part 7. A plan, then steps against it, then a reflection on what
 *    is still open, over minutes and many model calls. It is not "web mode with
 *    more searches": it publishes its work as it goes (`plan`/`step`/`reflect`)
 *    and it may stop BEFORE retrieving anything to ask what the question means
 *    (`clarify`). Every other mode either answers or refuses; this one can
 *    reply with a question, and that is a third outcome the wire had to grow.
 *
 * An unknown value is `web` rather than an error. A mode arrives in a query
 * string, a query string is a link somebody may have kept, and refusing an old
 * link outright is worse than answering it the default way.
 */
export type AnswerMode = 'web' | 'grounded' | 'verified' | 'deep';
/** What `message.mode` stores. `web` AND `deep` are written `fast`; see
 *  `messageMode`, which is where the second of those is argued and regretted. */
type StoredMode = 'fast' | 'verified' | 'grounded' | 'deep';

export function parseMode(raw: string | null | undefined): AnswerMode {
  const m = (raw ?? '').trim().toLowerCase();
  return m === 'grounded' || m === 'verified' || m === 'deep' ? m : 'web';
}

/**
 * THE CLARIFY REPLIES, OUT OF THE QUERY STRING.
 *
 * Repeated `a=` parameters, in the order of `ClarifyEvent.questions`, because
 * that event carries no ids and position is therefore the only correspondence
 * the contract offers.
 *
 * A TRAILING blank is dropped and an INTERIOR one is kept, and the asymmetry is
 * the only interesting line in this function. A trailing blank is a question
 * the reader never got to; an interior blank is a question they SKIPPED, and
 * removing it slides every answer after it up onto the wrong question — a
 * corruption that is invisible to the pipeline, to the reader, and to us,
 * because the result is a perfectly well-formed set of answers to a different
 * set of questions.
 *
 * The caps are because this is untrusted text arriving in a URL and landing in
 * a planner prompt with a token bill attached.
 */
export const MAX_CLARIFICATIONS = 8;
const MAX_CLARIFICATION_CHARS = 500;

export function parseClarifications(raw: readonly string[]): string[] {
  const out = raw
    .slice(0, MAX_CLARIFICATIONS)
    .map((v) => v.trim().slice(0, MAX_CLARIFICATION_CHARS));
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * WHAT GOES IN `message.mode`, AND WHY IT CANNOT SAY "DEEP".
 *
 * The column can. **Migration 016 widened it to `('fast','verified','grounded')`**
 * — verified against the live database — so the schema half of this gap is
 * closed and the two questions 015 built the column for ("was this answered
 * from our own ledger?", "what does each mode cost?") are answerable of a row.
 *
 * The DECODER was the second half, and it is now closed too. `packages/adapters`
 * reads this column through `asUnion`, which THROWS on an unlisted value — and
 * `getThread` is both what renders a thread and what `historyFor` reads a
 * follow-up's context from. So a row carrying 'grounded' would not have failed
 * on the way in; it would have failed on every way out, making its own thread
 * permanently unreadable. That is strictly worse than the mislabelling it was
 * meant to fix, which is why the migration landed first and alone.
 *
 * ORDER, for whoever adds the next mode: widen the reader, ship it, THEN write
 * the value. A schema that admits a mode nothing writes is inert; a writer that
 * emits a mode nothing can read is a corrupted thread.
 *
 * ── AND NOW `deep`, WHICH IS THE SAME GAP ONE MODE LATER ───────────────────
 *
 * Neither half is widened for it. The CHECK constraint is `('fast','verified',
 * 'grounded')` (migration 016) and `MODES` in `packages/adapters/src/pg/
 * thread-store.ts` lists the same three. Migrations and `packages/adapters` are
 * both outside this task's allow-list, so a deep turn is stored as **`fast`**,
 * and that is a deliberate mislabelling rather than an oversight.
 *
 * WHY `fast` IS THE CLOSEST HONEST VALUE. 016's own column comment defines the
 * three: fast = per-sentence checks over pages fetched this run; verified = the
 * whole-answer verbatim gate; grounded = answered from our own evidence with no
 * search provider reached. A deep run does per-sentence checks over pages
 * fetched this run — so `fast` is TRUE about the check regime and the
 * provenance, and merely silent about the plan, the steps and the minutes.
 * `verified` would claim a gate that never ran. `grounded` would claim we never
 * reached a search provider, which is the opposite of what deep mode does, and
 * it would corrupt the one question grounded mode exists to make answerable.
 *
 * WHAT THE MISLABELLING COSTS, stated so nobody discovers it in a spreadsheet:
 * the per-mode cost table is wrong in the expensive direction. A deep run costs
 * some multiple of a fast one, and every one of them lands in the `fast` row —
 * so `fast` reads more expensive than it is, `deep` does not appear, and the
 * §10 ledger comparing the modes silently stops meaning anything the first time
 * somebody runs a deep question. A test pins this so it stays visible.
 *
 * THE FIX, IN ORDER, and the order is not negotiable: (1) widen `MODES` in
 * `packages/adapters`, ship it; (2) migration 017 widening the CHECK; (3) then
 * one word here. Writing 'deep' today inserts cleanly and throws on every read,
 * because `rowToMessage` decodes through `asUnion` and `getThread` is both what
 * renders a thread and what a follow-up reads its context from. One unreadable
 * thread is strictly worse than one mislabelled row.
 */
function messageMode(mode: AnswerMode): StoredMode {
  // The vocabularies differ by one word and always have: the route calls it
  // `web` because that is where it looked, the column calls it `fast` because
  // that is how it answered. Mapping here rather than renaming either keeps a
  // URL somebody kept working and a column 015 already constrained.
  //
  // `deep` stores as itself since 017. It stored as `fast` until then, which
  // was the honest choice while the column had no word for it — but a deep
  // run's ceiling is ~70x a fast answer's, so one of them landing in the `fast`
  // row made that row read more expensive than every real fast answer combined.
  // A per-mode cost table that is WRONG is worse than one with a gap, because
  // nobody distrusts it.
  return mode === 'web' ? 'fast' : mode;
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
  /**
   * NO `history`, AND ITS ABSENCE IS THE ENFORCEMENT.
   *
   * It was here while grounded mode had no planner and nothing read it. Now
   * that a follow-up IS resolved against the conversation (see
   * `RESOLVE_FOLLOW_UP`), a field carrying prior turns into phase B's deps is
   * one edit away from a prompt containing a previous answer — and that failure
   * is invisible: a sentence copied out of an earlier answer, marked with a
   * citation to a span retrieved this run, passes every per-sentence check and
   * renders `confirmed`. The shape is the defence; the comment is the reminder.
   * `stream.ts` makes the identical argument above its own generation call, and
   * `GroundedStreamDeps` has no `history` field either.
   */
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
 * The deps this route composes are a superset of what it takes — `excluded` is
 * read here and not there. What is NOT in either shape is the conversation: the
 * question that arrives has already been resolved against it, and no prior
 * prose comes anywhere near the generator.
 */
export const GROUNDED_ANSWER: GroundedAnswerFn = (question, deps) =>
  streamGrounded(question, deps.universe, deps);

/* ── grounded mode: resolving a follow-up ───────────────────────────────── */

/**
 * What the run actually retrieves and answers against.
 *
 * `standalone` is the question with every reference resolved. It equals the
 * question as typed on a first turn, and whenever the planner could not do
 * better.
 */
export interface ResolvedQuestion {
  readonly standalone: string;
  readonly costCents: number;
  /** Non-empty only when a follow-up could NOT be resolved and the run went
   *  ahead against the literal words. Surfaced, never swallowed. */
  readonly note: string;
}

export type ResolveFollowUpFn = (
  question: string,
  history: readonly ConversationTurn[],
  ask: AskPort,
) => Promise<ResolvedQuestion>;

/**
 * GROUNDED MODE GETS A PLANNER — AND ONLY THE ONE THING A PLANNER IS FOR.
 *
 * Retrieval here is deterministic term-and-entity matching over our own rows,
 * so "and in Vancouver?" was matched against those four words and came back
 * with nothing. That was a deliberate choice while the alternative was handing
 * phase B a previous answer; it is not the only alternative. `planSearches`
 * already resolves a follow-up into a STANDALONE QUESTION using the
 * conversation, and a standalone question is a question — not evidence, not
 * prose, and not something a sentence may rest on.
 *
 * WHAT CROSSES AND WHAT DOES NOT. History reaches this function and stops here.
 * What leaves is one rewritten interrogative sentence, which then goes to
 * retrieval and to phase B in place of the follow-up — exactly what the web
 * path does with `plan.standalone`. What never leaves is the previous ANSWER:
 * `GroundedAnswerDeps` has no `history` field to put it in and neither does
 * `GroundedStreamDeps`, so the boundary holds by shape and not by memory. The
 * residual risk is the one the web path also carries and `stream.ts` names: a
 * planner could smuggle an earlier claim into the rewrite it returns. Phase C
 * is the backstop there, and it is a backstop — which is why the structural
 * rule about prose is kept absolute rather than traded against it.
 *
 * THREE THINGS FROM THE PLAN ARE DELIBERATELY DROPPED ON THE FLOOR:
 *
 *  - `queries` — grounded mode reaches no search provider. `maxQueries` is 0,
 *    so the planner's queries are sliced away before they can tempt anything.
 *  - `unanswerable` — the planner is asked what THE OPEN WEB cannot settle.
 *    Relaying that into a grounded run's "Not answerable" card would answer a
 *    question about our ledger with a statement about the web.
 *  - `reuse` — it decides whether to re-fetch pages, and there are no pages.
 *
 * NO HISTORY, NO CALL. A first question is resolved by definition, and spending
 * a planning call on it would put a model between the reader and the ledger for
 * nothing — grounded mode costs a fifth of a web answer precisely because phase
 * A is free, and a turn-one planner would be most of the remaining bill.
 */
export const RESOLVE_FOLLOW_UP: ResolveFollowUpFn = async (question, history, ask) => {
  if (history.length === 0) return { standalone: question, costCents: 0, note: '' };

  const plan = await planSearches(question, history, ask, 0);
  return {
    standalone: plan.standalone,
    costCents: plan.costCents,
    // A dead planning call degrades the run; it does not fail it. Retrieval
    // against the literal follow-up usually returns little, and a reader
    // looking at a thin answer is owed the reason it is thin.
    note:
      plan.note === ''
        ? ''
        : `this follow-up was not resolved against the conversation (${plan.note.trim()}), so our records were searched for the words as typed`,
  };
};

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
  resolve: ResolveFollowUpFn = RESOLVE_FOLLOW_UP,
): StreamAnswerFn {
  return async (question, deps) => {
    // The conversation is resolved BEFORE anything is retrieved, because the
    // retrieval is the thing the follow-up was failing. `planning` and never
    // `searching`: the phase enum has one, and a grounded run announcing it
    // would be claiming a search it did not do.
    if (deps.history.length > 0) {
      deps.onStatus({ phase: 'planning', detail: 'resolving the follow-up against the conversation' });
    }
    const resolved = await resolve(question, deps.history, deps.ask);
    // From here down, `asked` is the question. The follow-up as typed is not
    // carried alongside it: `streamGrounded` composes its own QUESTION block
    // and shows what it is given, so passing both would put the unresolved
    // words in front of the writer for no gain.
    const asked = resolved.standalone;

    deps.onStatus({ phase: 'reading', detail: 'the world model, findings, the Brain and the ledger' });
    const evidence = await retrieveEvidence(asked);

    // Phase A. Free and synchronous: internal spans were proven the day they
    // were written, so there is no extraction pass to pay for.
    deps.onStatus({ phase: 'attributing', detail: `${evidence.records.length} internal record(s)` });
    const universe = groundedUniverse(asked, evidence.records);
    for (const source of groundedSourceEvents(universe)) deps.onSource(source);
    for (const span of groundedSpanEvents(universe)) deps.onSpan(span);

    // Phase A's refusals, and the forecasts it may not quote. Emitted here —
    // after the spans, before any prose, and before the empty-universe return
    // below, where the dropped list is the entire explanation of why there is
    // nothing to read. See the `unused` block in this file's header.
    const unused = unusedFor(universe);
    if (unused !== null) deps.onUnused(unused);

    // Everything a run could not do is one list by the time it reaches the
    // reader: what retrieval looked for and did not find, plus a follow-up that
    // could not be resolved.
    const excluded = [...evidence.excluded, ...(resolved.note === '' ? [] : [resolved.note])];

    if (universe.spans.length === 0) {
      // A legitimate outcome, and the honest one. Falling back to the web here
      // would silently answer a different question — the reader asked what WE
      // know — while wearing grounded mode's badge. `universe.note` already
      // distinguishes "we hold nothing" from "we hold things and none can be
      // quoted" from "all we have is a forecast", so it is relayed rather than
      // replaced with a line of this route's own.
      return {
        text: '',
        // Phase A is free, so the planning call — when there was one — is the
        // whole bill, and it is reported rather than rounded to the zero it
        // would have been on a first question.
        costCents: resolved.costCents,
        sources: groundedDocs(universe),
        queries: [],
        note: universe.note,
        unanswered: excluded,
      };
    }

    const result = await answer(asked, {
      ask: deps.ask,
      askStream: deps.askStream,
      universe,
      excluded,
      onStatus: deps.onStatus,
      onDelta: deps.onDelta,
      onSentence: deps.onSentence,
    });

    return {
      ...result,
      costCents: result.costCents + resolved.costCents,
      // The retrieval record, so a thread reopened tomorrow still shows which
      // of our own rows it rested on. `queries` stays empty: none were run.
      sources: result.sources ?? groundedDocs(universe),
      queries: result.queries ?? [],
      unanswered: [...(result.unanswered ?? []), ...excluded],
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

/* ── deep research: the seam ────────────────────────────────────────────── */

/**
 * WHAT A DEEP RUN NEEDS THAT THE OTHER THREE DO NOT.
 *
 * A separate shape rather than four more fields on `StreamAnswerDeps`, and the
 * argument is the one this file already makes about `history` and
 * `GroundedAnswerDeps`: **the shape is the enforcement.** A web run that could
 * emit `clarify` would eventually emit one, and a reader looking at a 20-second
 * answer that stopped to ask a question has been shown a deep run's behaviour
 * wearing fast mode's badge. There is no callback for it in what web mode is
 * declared to receive.
 *
 * (It still RECEIVES them at runtime — the route composes one deps object per
 * request and hands the same object to whichever runner the mode selected, so
 * `DeepAnswerDeps` is a subtype and every runner is assignable. That is exactly
 * the arrangement `streamAnswer` has had with `history` since Part 5, and the
 * declared shape is what a pipeline is written against.)
 *
 * The four relays are `events.ts`'s payloads, unwrapped and unrenamed. Nothing
 * here composes a `PlanEvent` or edits one in flight.
 */
export interface DeepRelays {
  /**
   * The reader's answers to a previous run's `ClarifyEvent`, in ITS order.
   *
   * Empty on a first ask, and empty on a run that was never asked to clarify.
   * A blank entry is a question the reader skipped, and it holds its place —
   * see `parseClarifications`.
   *
   * THEY ARE NOT EVIDENCE, AND THERE IS NOWHERE FOR THEM TO BECOME EVIDENCE.
   * A clarification is reader-authored text that arrived in a URL. It may shape
   * the plan, which is its whole purpose; it may never be quoted, cited, or
   * treated as a fact about the world. `CitableSpan` is built from documents
   * this run fetched and from our own proven rows, and a string typed into a
   * text box is neither, so there is no path from here to a citation short of
   * somebody building one on purpose.
   */
  readonly clarifications: readonly string[];
  readonly onPlan: (e: PlanEvent) => void;
  readonly onStep: (e: StepEvent) => void;
  readonly onReflect: (e: ReflectEvent) => void;
  /**
   * Asked BEFORE any retrieval, after which the pipeline STOPS and the stream
   * ends. `events.ts` explains why the ordering is a finding rather than a
   * preference: retrieved context reads as confidence and makes a model less
   * likely to ask, so ambiguity is settled before the first search or it is
   * never settled at all.
   */
  readonly onClarify: (e: ClarifyEvent) => void;
}

export type DeepAnswerDeps = StreamAnswerDeps & DeepRelays;

export type DeepAnswerFn = (
  question: string,
  deps: DeepAnswerDeps,
) => Promise<StreamAnswerResult>;

/**
 * ▲ THE SEAM ▲ — closed 2026-08-31, once `deep.ts` reached the barrel.
 *
 * `DeepAnswerFn` stays a named local type rather than collapsing into a direct
 * call, for the reason `StreamAnswerFn` and `GroundedAnswerFn` do: it is the
 * declaration of what this route needs from the pipeline, every payload on it
 * comes from `events.ts` rather than from `deep.ts`, and it is what let this
 * file be written and fully tested against fakes while `streamDeep` was being
 * built in parallel. The deps composed here are a SUPERSET of `DeepDeps` —
 * `history` and `onUnused` are read nowhere in the pipeline — which is what
 * reduced the wiring to one line when it landed.
 *
 * What stood here is worth remembering, and it is the same note both earlier
 * seams carry: a REJECTING stub, chosen over one that returned plausible prose,
 * because an answer engine whose unbuilt-feature failure mode is a fluent
 * uncited essay is the exact thing `packages/research` exists to prevent — and
 * it would have passed every test in `answer-route.test.ts`.
 *
 * NO `budget` IS PASSED, so the run takes `DEFAULT_DEEP_BUDGET`: 5 steps, 10c,
 * four minutes, 40 spans. That is deliberate rather than an omission — those
 * numbers are argued where the loop that obeys them lives, and a second set
 * chosen here would be the console quietly overriding the pipeline's own cap
 * with a number nothing in this file could justify. It is read below, at the
 * admission check, and never written.
 */
export const DEEP_ANSWER: DeepAnswerFn = (question, deps) => streamDeep(question, deps);

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
 *
 * ── AND WHY A DEEP RUN GETS A CEILING OF ITS OWN ───────────────────────────
 *
 * The paragraph above reasons about two answers at once and concludes that the
 * remaining cost of concurrency is money, bounded by a per-run pre-flight. That
 * reasoning was written for a run measured in seconds and it does NOT transfer.
 *
 * The pre-flight is the only budget gate this route has, it fires ONCE at
 * admission, and `noteCost` does not move the day's ledger until a run FINISHES.
 * For a 30-second answer that window is 30 seconds wide and two runs drifting
 * past a shared ceiling is a rounding error. For a run that spends continuously
 * for two to four minutes, two of them admitted a minute apart both pass a
 * pre-flight against a day that neither has yet reported to, and each is worth
 * some multiple of the answer the ceiling was sized for. The cap is on RUNS and
 * the ceiling is on MONEY, and deep mode is where those two stop being
 * proportional.
 *
 * So: one deep run at a time, and it still counts against the total of two, so
 * a deep run and a fast one may overlap. This does not make mid-run spend
 * bounded — nothing in this file does, and `runAnswer` says what actually is —
 * it makes the admission check meaningful again, by ensuring the day's ledger
 * is never consulted while a second minutes-long bill is already accruing
 * against it unrecorded.
 */
const MAX_CONCURRENT_ANSWERS = 2;
const MAX_CONCURRENT_DEEP = 1;

/** What a slot is being claimed for. Only the cost profile differs, and that is
 *  the entire reason the guard has to know. Not exported: a caller names the
 *  kind with a literal, and knip is right that a type nobody imports is noise. */
type RunKind = 'fast' | 'deep';

export class AnswerBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerBusy';
  }
}

/**
 * Whitespace and case are not the question. A reload is the same run.
 *
 * A CLARIFY REPLY IS NOT A DUPLICATE, and this is the one case where the
 * question alone lies. A deep run that stops to ask ends its stream; the reader
 * answers; the reply arrives carrying the SAME question, because it is the same
 * question — that is the whole point of the round trip. Keyed on the question
 * alone it reads as a reload of the run that just asked, and the guard refuses
 * the answer to its own question. Found on the first live deep run, where an
 * immediate reply was rejected and an ~8-second pause was the workaround.
 *
 * So a reply keys on the replies too. Two readers answering the same clarify
 * differently are genuinely two runs; the same reader double-clicking Send is
 * still one, and still refused.
 */
export function answerKey(
  threadId: string | null,
  question: string,
  clarifications: readonly string[] = [],
): string {
  const answered = clarifications.length > 0 ? `#${clarifications.join('\u0000')}` : '';
  if (threadId !== null && threadId !== '') return `thread:${threadId}${answered}`;
  return `q:${question.replace(/\s+/g, ' ').trim().toLowerCase()}${answered}`;
}

export class AnswerGuard {
  private readonly inFlight = new Set<string>();
  private readonly deepInFlight = new Set<string>();

  constructor(
    private readonly maxConcurrent: number = MAX_CONCURRENT_ANSWERS,
    private readonly maxDeep: number = MAX_CONCURRENT_DEEP,
  ) {}

  size(): number {
    return this.inFlight.size;
  }

  deepSize(): number {
    return this.deepInFlight.size;
  }

  /** Claims a slot, returning the release. Throws `AnswerBusy` if refused. */
  begin(key: string, kind: RunKind = 'fast'): () => void {
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
    // Checked after the total, so the message a reader gets names the ceiling
    // that actually stopped them.
    if (kind === 'deep' && this.deepInFlight.size >= this.maxDeep) {
      throw new AnswerBusy(
        'a deep research run is already going. It spends continuously for minutes and the day\u2019s ' +
          'budget is only checked when a run starts, so a second one would be admitted against a ' +
          'ledger the first has not reported to yet. Wait for it, or ask this one in web mode.',
      );
    }
    this.inFlight.add(key);
    if (kind === 'deep') this.deepInFlight.add(key);
    let released = false;
    return () => {
      // Idempotent: the release runs in a `finally` that also runs on the error
      // path, and a second call must not free somebody else's later slot.
      if (released) return;
      released = true;
      this.inFlight.delete(key);
      this.deepInFlight.delete(key);
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

/**
 * The `unused` frame, or null when phase A refused nothing and holds no
 * forecast.
 *
 * Null and not an empty frame, for `epilogueFor`'s reason: a run that dropped
 * nothing and a run that does not report drops must not look alike on the wire,
 * and the UI's card already distinguishes "nothing was dropped" from "not
 * reported by this run". Sending `{dropped: [], expectations: []}` would answer
 * that question with the wrong one of the two.
 */
export function unusedFor(universe: GroundedUniverse): UnusedEvent | null {
  if (universe.dropped.length === 0 && universe.expectations.length === 0) return null;
  return { dropped: [...universe.dropped], expectations: [...universe.expectations] };
}

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
 * THE ASSISTANT TURN FOR A RUN THAT ASKED INSTEAD OF ANSWERING.
 *
 * Written rather than left empty because the alternative — a thread holding a
 * question and nothing else — is byte-for-byte what a crashed run leaves, and
 * `historyFor` deliberately drops such a question rather than report it
 * answered with silence. Two different events must not arrive wearing one
 * shape. The header argues the rest of it.
 *
 * `bodyFor` must not be reached for this case: it would fall through to "the
 * documents this run read carried nothing quotable", and a run that stopped
 * BEFORE retrieving read no documents. That sentence would be false in the
 * particular way this system spends its whole design budget avoiding — a
 * fluent, confident account of something that did not happen.
 *
 * THE QUESTIONS ARE NUMBERED, AND A BLANK ONE STILL TAKES ITS NUMBER. The
 * replies ride back positionally against `ClarifyEvent.questions`, so the
 * number a reader sees here has to be the position they are answering in, even
 * when the pipeline emitted an empty string into the middle of its own list.
 * Renumbering to tidy the display would misaddress every later answer.
 */
export function clarifyBody(e: ClarifyEvent): string {
  const because = e.because.trim();
  const questions = e.questions.map((q) => q.trim());

  if (!questions.some((q) => q !== '')) {
    return because === ''
      ? 'This run stopped before searching, because the question was too broad to spend minutes on.'
      : `This run stopped before searching, because ${because}`;
  }

  const head =
    because === ''
      ? 'Before spending minutes on this, the run stopped to ask:'
      : `Before spending minutes on this, the run stopped to ask, because ${because}:`;
  return [head, ...questions.map((q, i) => `${i + 1}. ${q}`)].join('\n');
}

/**
 * The user turn, when the reader is answering a clarify rather than asking
 * cold.
 *
 * One exchange arrives as two HTTP requests, and the thread should read as one
 * exchange. Nothing is invented: the reader typed the question in the first
 * request and the replies in the second, and this puts them in one row under
 * the numbers they were asked against. A skipped question is written as skipped
 * rather than closed up, for `parseClarifications`'s reason — the numbers are
 * the addressing.
 *
 * The QUESTION handed to the pipeline is untouched by this. What is composed
 * here is the record; the replies reach the pipeline as `clarifications`, a
 * field of their own, because a clarification folded into the question would
 * become a phrase the writer sees and the run's question would stop being the
 * one the reader typed.
 */
export function userBodyFor(question: string, clarifications: readonly string[]): string {
  if (!clarifications.some((c) => c.trim() !== '')) return question;
  const lines = clarifications.map((c, i) => `${i + 1}. ${c.trim() === '' ? '(not answered)' : c.trim()}`);
  return [question, '', 'Clarifications:', ...lines].join('\n');
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
  /**
   * Answers to a previous run's `ClarifyEvent`, in its order. Absent on every
   * request that is not the second half of a clarify round trip, which is
   * almost all of them.
   */
  readonly clarifications?: readonly string[];
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
  /**
   * Deep research. Typed as `DeepAnswerFn` because it is the only runner that
   * is promised the four extra channels; the other three are assignable to it
   * since `DeepAnswerDeps` is a subtype of what they take.
   */
  readonly deepAnswer?: DeepAnswerFn;
  readonly ports: AnswerPorts;
  /** Joins every `ai_usage_log` row this run writes to the message it paid for. */
  readonly runId: string;
  readonly now: () => Date;
  readonly newId: () => string;
  /**
   * The day's ledger, or the reason it refuses. Null means go.
   *
   * TAKES THE MODE, because one estimate for four modes was fine while three of
   * them cost roughly the same and stopped costing anything after 30 seconds.
   * See `estimatedCostCentsFor`.
   */
  readonly checkBudget: (mode: AnswerMode) => string | null;
  readonly noteCost: (costCents: number) => void;
}

/**
 * The runner this mode needs, or null when the caller did not supply one.
 *
 * Returns `DeepAnswerFn` for all four: the route composes ONE deps object per
 * request and hands it to whichever runner won, so the type has to be the one
 * that describes the widest deps. A `StreamAnswerFn` is assignable to it — a
 * function that accepts the narrower shape accepts the wider one — which is
 * what lets web, grounded and verified stay declared without the four channels
 * they must never use.
 */
function runnerFor(mode: AnswerMode, deps: AnswerDeps): DeepAnswerFn | null {
  if (mode === 'grounded') return deps.groundedAnswer ?? null;
  if (mode === 'verified') return deps.verifiedAnswer ?? null;
  if (mode === 'deep') return deps.deepAnswer ?? null;
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

  const refusal = deps.checkBudget(mode);
  if (refusal !== null) {
    send(sink, 'error_msg', `Refused by the daily budget: ${refusal}`);
    return;
  }

  const clarifications = params.clarifications ?? [];

  let release: () => void;
  try {
    release = deps.guard.begin(
      answerKey(params.threadId, question, params.clarifications ?? []),
      mode === 'deep' ? 'deep' : 'fast',
    );
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
  // Recorded as well as relayed, because this one decides what is PERSISTED.
  // Taken from the wire rather than from the runner's return value on purpose:
  // what the reader was shown and what the thread stores are then the same
  // object, and they cannot come to disagree the way a second field would.
  let clarify: ClarifyEvent | null = null;

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
    // Straight to the wire and nowhere else: `message.answer` has no field
    // these belong in, so this frame is live-only and the header says so.
    onUnused: (e: UnusedEvent) => send(sink, 'unused', e),
    // The four deep-mode frames, relayed under the names `DEEP_EVENTS` lists
    // and carrying `events.ts`'s payloads unchanged. No mode but deep calls
    // them; see `DeepRelays` for why the other runners are not even told they
    // exist.
    clarifications,
    onPlan: (e: PlanEvent) => send(sink, 'plan', e),
    onStep: (e: StepEvent) => send(sink, 'step', e),
    onReflect: (e: ReflectEvent) => send(sink, 'reflect', e),
    onClarify: (e: ClarifyEvent) => {
      clarify = e;
      send(sink, 'clarify', e);
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
      // The replies to a previous clarify go in the RECORD beside the question
      // they answer, so one exchange spread over two requests reads back as
      // one. The pipeline gets them as `clarifications`, not as question text.
      body: userBodyFor(question, clarifications),
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
      //
      // A run that stopped to ask stores the questions instead, and only when
      // it wrote no prose: a pipeline that asked and then answered anyway is
      // recorded by what it answered, because that is what the reader read.
      body: clarify !== null && result.text.trim() === '' ? clarifyBody(clarify) : bodyFor(result),
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

/**
 * WHAT THE DAY MUST HAVE ROOM FOR BEFORE A RUN IS ADMITTED.
 *
 * For web, grounded and verified this stays the small generous guess above: the
 * pre-flight exists to refuse a run on a day that is ALREADY spent, not to
 * predict a bill, and those three finish in seconds.
 *
 * A DEEP RUN CANNOT USE THAT NUMBER, and using it would be the quiet failure
 * this whole file is written against. A day with 5c of headroom would admit a
 * run worth some multiple of that, spend it over four minutes, and report the
 * overrun afterwards — the ceiling would have been consulted and then exceeded,
 * which is worse than not having one, because the log says it was checked.
 *
 * So deep mode is admitted against THE LARGEST BILL THE TOKEN CEILING CAN
 * PRODUCE, not against a guess:
 *
 *   - `callGroq` bounds a run at `maxRunTokens` per budget state;
 *   - `createAsk` and `createAskStream` hold one state EACH (see `ask.ts`), and
 *     `runAnswer` builds one of each per request, so a request can reach
 *     2 x maxRunTokens before the chokepoint stops it;
 *   - priced entirely at the strong model's OUTPUT rate, which no run achieves
 *     — prompt tokens are 4x cheaper — so this over-estimates on purpose.
 *     Over-estimating costs us a run we could have afforded; under-estimating
 *     costs money, and only one of those is recoverable.
 *
 * At the shipped defaults (100k tokens, gpt-oss-120b at 60c/Mtok out) that is
 * 12c, against roughly 0.17c for a fast answer. `estimateCostCents` is imported
 * rather than reproduced: a price written down twice is a price that is wrong
 * in one of the two places, and `groq.ts`'s table already had that bug once at
 * a factor of ten.
 *
 * AND THE LARGER OF THAT AND THE PIPELINE'S OWN CAP. `deep.ts` declares
 * `DEFAULT_DEEP_BUDGET.maxCostCents` — the line past which the loop stops
 * itself — and taking the max means the day is never asked to admit a run for
 * less than the run has already said it may spend. Read rather than restated,
 * so raising the pipeline's cap raises what the door demands, in the same
 * commit, without anybody remembering to.
 *
 * THIS IS AN ADMISSION CHECK AND NOTHING MORE. It does not bound what the run
 * spends once it is running. `runAnswer` says what does.
 */
export function estimatedCostCentsFor(mode: AnswerMode, limits: BudgetLimits): number {
  if (mode !== 'deep') return ESTIMATED_ANSWER_COST_CENTS;
  const tokenCeiling = Math.ceil(estimateCostCents(MODELS.strong, 0, 2 * limits.maxRunTokens));
  return Math.max(DEFAULT_DEEP_BUDGET.maxCostCents, tokenCeiling);
}

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
  clarifications: readonly string[] = [],
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

  // Undefined when the id is unknown — the pipeline then plans exactly as it
  // did before this was threaded, which is asserted by test.
  const pack = packById(DEFAULT_PACK_ID);
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

  /*
   * WHAT ACTUALLY BOUNDS A MINUTES-LONG RUN, once it is past the door.
   *
   * Written here because this is where the ports are built, and stated in full
   * because a deep mode shipped on the assumption that the fast-mode guards
   * transfer is a bill nobody sees coming. Three ceilings apply, in two places,
   * and NONE of them is the `AnswerGuard` or the pre-flight above:
   *
   *  - BOUNDED, by the pipeline. `DEFAULT_DEEP_BUDGET` — 5 steps, 10c of model
   *    spend, four minutes of wall clock, 40 spans — checked BEFORE each step,
   *    never mid-step. So the real overshoot is one step's worth past the cap,
   *    and `stoppedBecause` says which cap ended the run rather than leaving it
   *    to look like the plan was finished.
   *  - BOUNDED, at the chokepoint. Groq tokens. Each port holds one
   *    `BudgetState` for the whole request (one `runId`), so `maxRunTokens`
   *    accumulates across every model call the run makes. This is the outer
   *    bound and it does not depend on the pipeline being correct — which is
   *    why the admission estimate is derived from it. Note the shape of that
   *    ending, though: a run stopped by the token ceiling returns `null` from
   *    `ask`, which is indistinguishable from a run whose model went away.
   *  - BOUNDED, but not in cents. Search-provider calls: `maxSteps` x
   *    `DEFAULT_DEEP_LIMITS.maxQueries` is roughly ten searches, against a fast
   *    answer's four. Tavily and Exa are billed per call and pass through no
   *    ceiling in this repo at all, so this spend is bounded in COUNT and
   *    invisible to `TMOS_MAX_DAILY_COST_CENTS`. §6 of the plan notes that a
   *    flat per-request search fee often dominates token cost; deep mode is
   *    where that stops being a note.
   *
   * NOT BOUNDED: the day's dollar ledger between admission and completion.
   * `noteCost` runs once, at the end, so a four-minute run is invisible to the
   * next admission check for four minutes. `MAX_CONCURRENT_DEEP` is the whole
   * mitigation and it is a small one.
   *
   * Two fixes were considered and rejected rather than forgotten. Charging the
   * estimate to the day at admission and the actual at the end double-counts
   * permanently, and the in-memory ledger would then disagree with
   * `ai_usage_log`, which is the table the ceiling is rebuilt from on boot — a
   * fix that makes tomorrow's ceiling wrong. And a deadline enforced by
   * throwing out of a relay callback would stop a run only if the pipeline let
   * a callback throw propagate; a ceiling that might not be a ceiling is worse
   * than a documented gap. Both want a shared `BudgetState` at the chokepoint —
   * a serial change to `AskConfig`, which `budget-boot.ts` has named since
   * Part 2 and which is still the one fix that would make the day real.
   */

  await runAnswerStream(
    res,
    {
      question,
      threadId,
      mode,
      // A clarification answers a question only deep mode asks. Carrying one
      // into a mode that never asked would put lines in the stored turn that
      // nothing requested, and hand a planner text it has no use for.
      clarifications: mode === 'deep' ? clarifications : [],
    },
    {
      store: PG_STORE,
      guard: GUARD,
      streamAnswer: STREAM_ANSWER,
      // Retrieval, generation, and — third — the resolution of a follow-up
      // into a standalone question, which is what the retrieval is run against.
      // Named here rather than left to the default so that the one place
      // history is allowed to matter is visible at the wiring.
      groundedAnswer: groundedRunner(
        (q) => retrieveGrounded(q, createPostgresGroundedReader()),
        GROUNDED_ANSWER,
        RESOLVE_FOLLOW_UP,
      ),
      verifiedAnswer: VERIFIED_ANSWER,
      // Rejects until `packages/research/src/deep.ts` lands. Wired anyway, so
      // that the swap is one identifier and so that `?mode=deep` fails by
      // saying the feature does not exist — not by quietly answering a
      // minutes-of-research question with a 20-second web pass.
      deepAnswer: DEEP_ANSWER,
      ports: {
        ask: createAsk(askConfig),
        askStream: createAskStream(askConfig),
        search: providers,
        read: createResearchReader(),
        /**
         * WHOSE INTERESTS THE QUERIES SERVE.
         *
         * Live, 2026-08-31: "Should we run a snow-removal campaign in Toronto
         * this October?" planned four queries about municipal policy, read
         * eight City of Toronto PDFs, and reported the winter-maintenance
         * budget. The gate behaved correctly and refused to pretend — but an
         * honest answer to the wrong question is still the wrong answer, and
         * nothing downstream can recover from evidence that was never about
         * the subject.
         *
         * The pack has carried this sentence all along; it reached T1 triage
         * and never the planner, which is the stage that decides what gets
         * read at all. Grounded mode already used it.
         */
        subject: pack?.subject,
      },
      runId,
      now: () => new Date(),
      newId: randomUUID,
      checkBudget: (asked) =>
        refuseForBudget(budget, limits, estimatedCostCentsFor(asked, limits), new Date()),
      noteCost: (costCents) => noteSpend(budget, runId, costCents, new Date()),
    },
  );

  res.end();
}
