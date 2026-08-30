/**
 * THE WIRE CONTRACT between the answer pipeline and any surface that renders it.
 *
 * Written before the three pieces that use it — the streaming pipeline, the
 * route, and the browser — because they are built in parallel and a contract
 * discovered by each of them separately is three contracts.
 *
 * ── WHY SENTENCES ARE NUMBERED ON THE WIRE ─────────────────────────────────
 *
 * Prose streams as `delta`, and a verdict about that prose arrives later as
 * `sentence`. The obvious design — stream raw text, have the browser split it
 * into sentences, and index verdicts by position — fails the first time the two
 * splitters disagree about "Inc." or "$1.5m." A verdict landing on the wrong
 * sentence is worse than no verdict: it marks a checked claim unchecked, or an
 * unchecked one confirmed.
 *
 * So the SERVER owns sentence boundaries. Every `delta` names the sentence it
 * belongs to, the browser accumulates text per index, and a `sentence` verdict
 * targets that index unambiguously. The client never splits anything.
 *
 * ── WHY A MARKER IS A SPAN, NOT A DOCUMENT ─────────────────────────────────
 *
 * `[3]` resolves to a span in the citable universe — one specific quote we have
 * already proved is verbatim on a page we fetched — not merely to a document.
 * Citing a document says "this is somewhere on that page"; citing a span says
 * "these exact words are, and here they are". The second is checkable by a
 * reader in one glance and is the whole point of the attribute-first design.
 */

/** A document this run actually retrieved. Emitted before any prose. */
export interface SourceEvent {
  /** 1-based, stable for the run. What a span points back to. */
  readonly i: number;
  readonly url: string;
  readonly title: string;
  /** Rendered on the source card; also what a favicon is fetched for. */
  readonly domain: string;
}

/** One proven-verbatim quote. `id` is the number that appears in the prose. */
export interface SpanEvent {
  readonly id: number;
  readonly sourceIndex: number;
  readonly quote: string;
}

/** A chunk of prose, tagged with the sentence it belongs to. */
export interface DeltaEvent {
  readonly n: number;
  readonly text: string;
}

/**
 * The verdict on a completed sentence.
 *
 * `flagged` is not "false" — it is "we could not confirm this from the spans it
 * cites", which is a different and weaker statement. The UI must not render it
 * as a lie, and `why` is what keeps that distinction legible.
 */
export interface SentenceEvent {
  readonly n: number;
  readonly verdict: 'confirmed' | 'flagged';
  readonly why?: string;
}

export type AnswerPhase =
  | 'planning'
  | 'searching'
  | 'reading'
  | 'attributing'
  | 'writing'
  | 'checking'
  | 'done';

export interface StatusEvent {
  readonly phase: AnswerPhase;
  readonly detail?: string;
}

export interface DoneEvent {
  readonly costCents: number;
  readonly threadId: string | null;
  readonly messageId: string | null;
  /** Sentences that never reached `confirmed`. Surfaced, never swallowed. */
  readonly flagged: number;
}

/**
 * The event names as they appear on the wire.
 *
 * `error_msg`, not `error`: SSE reserves `error` for transport failures on
 * `EventSource`, and an application error sent under that name is swallowed by
 * `onerror` with no payload — the failure becomes a silent disconnect.
 */
export const ANSWER_EVENTS = [
  'status', 'source', 'span', 'delta', 'sentence', 'done', 'error_msg',
] as const;

export type AnswerEventName = (typeof ANSWER_EVENTS)[number];

/* ── conversation ─────────────────────────────────────────────────────────── */

/**
 * ONE PRIOR TURN, as a follow-up needs to see it.
 *
 * Defined here with the wire contract rather than inside the pipeline because
 * three pieces built in parallel have to agree on it: the planner that resolves
 * "and in Vancouver?" against it, the route that loads it out of Postgres, and
 * the browser that shows the thread it came from.
 *
 * WHY THE ANSWER IS CARRIED AS RENDERED TEXT, MARKERS INCLUDED. The temptation
 * is to strip `[1]` before feeding history back to a model — it is noise to a
 * planner. But a follow-up like "where did that price come from?" is ABOUT the
 * marker, and a history that has quietly deleted it cannot answer. The planner
 * is told what the markers mean instead.
 *
 * WHY SOURCES RIDE ALONG. A follow-up on the same subject should not re-search
 * the web from nothing: the pages that answered the last question usually
 * answer this one, and re-fetching them costs a search call, eight fetches and
 * a 2s-per-host floor to arrive back at the same documents. Carrying them lets
 * the planner decide whether new retrieval is needed at all.
 */
export interface ConversationTurn {
  readonly question: string;
  /** The assistant's answer as it was rendered, `[N]` markers intact. */
  readonly answer: string;
  /** URLs read for that turn, so a follow-up can reuse rather than re-fetch. */
  readonly sourceUrls: readonly string[];
}
