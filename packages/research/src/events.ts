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

/**
 * Where a source came from, which decides how a reader can check it.
 *
 * `web` opens in a tab. The other three cannot, and saying so is the point:
 * a Brain passage and a competitor page are both evidence, and a reader who
 * cannot tell them apart cannot judge the answer. An internal citation is
 * stronger in one way — it was verified when it was written, not by this run —
 * and weaker in another: it is us citing ourselves.
 */
export type SourceKind =
  /** A page fetched from the open web this run. */
  | 'web'
  /** The world model — a value read off a competitor's own page, with the
   *  sentence it came from, on the date we read it. */
  | 'world'
  /** A Taskly document. What we believe, decided or published. */
  | 'brain'
  /** The prediction ledger — a forecast, with the probability we put on it. */
  | 'ledger';

/** A document this run actually retrieved. Emitted before any prose. */
export interface SourceEvent {
  /** 1-based, stable for the run. What a span points back to. */
  readonly i: number;
  /**
   * An openable URL for `web` and `world`; for `brain` and `ledger` a locator
   * that is NOT a link — a Brain path with its section, or a ledger row.
   * `kind` is what tells a renderer which it is holding. Never fabricate an
   * http URL for an internal record to make a card look uniform.
   */
  readonly url: string;
  readonly title: string;
  /** Rendered on the source card. For an internal source this is the origin
   *  in words ("world model", "brain"), not a hostname. */
  readonly domain: string;
  /** Absent means `web` — every source emitted before 2026-08-31 was one. */
  readonly kind?: SourceKind;
  /** When the underlying observation was made, for a `world` or `ledger` row.
   *  A competitor fact from June and one from today are not equal evidence. */
  readonly observedAt?: string;
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

/* ── deep research ────────────────────────────────────────────────────────── */

/**
 * A MULTI-MINUTE RUN NEEDS A DIFFERENT WIRE, AND THE REASON IS NOT COSMETIC.
 *
 * A fast answer's staging works because the whole thing is over in 30 seconds:
 * a status line, sources, then prose. Two to four minutes of that same status
 * line is indistinguishable from a hang, and the honest fix is not a nicer
 * spinner — it is showing the work. So a deep run publishes its PLAN, then
 * reports each step against it, then what each step actually found.
 *
 * The reader has to be able to abandon a run that is going wrong at minute one
 * rather than discovering it at minute four, and that is only possible if the
 * plan is visible before the searching starts.
 */

/** One sub-question the run intends to answer. Published before any retrieval. */
export interface PlanStep {
  /** 1-based. Stable for the run — a replan revises `question`, never `n`. */
  readonly n: number;
  readonly question: string;
  /** Why this step earns a slot. A step nobody can justify is a step to cut. */
  readonly why: string;
}

/** The whole plan, emitted once before step one and again after any revision. */
export interface PlanEvent {
  readonly steps: readonly PlanStep[];
  /** Set when this replaces an earlier plan, saying what changed and why. */
  readonly revisedBecause?: string;
}

/**
 * Progress on one step.
 *
 * `found` is the count of NEW proven spans this step added — not documents read
 * and not results returned. A step that read nine pages and proved nothing is
 * the single most useful thing a watching reader can be told, and a "9 sources"
 * counter would hide exactly that.
 */
export interface StepEvent {
  readonly n: number;
  readonly state: 'running' | 'done' | 'skipped';
  readonly detail?: string;
  readonly found?: number;
}

/**
 * The reflection between steps — what is still open, and whether to continue.
 *
 * Published because it is the run's own reasoning about its own progress, and a
 * reader deciding whether to let it keep spending deserves to see it. `stop`
 * carries the reason: "the plan is answered" and "the budget cap ended it" are
 * different outcomes and an answer that cannot tell you which is a worse answer.
 */
export interface ReflectEvent {
  readonly after: number;
  readonly stillOpen: readonly string[];
  readonly note: string;
  readonly stop?: string;
}

/**
 * Questions asked BEFORE any retrieval, when the request is too broad to spend
 * minutes on.
 *
 * The ordering is a finding, not a preference. "Knowing but Not Showing"
 * (arXiv:2605.25284) reports that models can judge ambiguity correctly when
 * asked directly, but default to guessing in normal QA mode — and that handing
 * the model retrieved context makes it LESS likely to ask, not more, because
 * context reads as confidence. So ambiguity is decided before the first search,
 * or in practice it is never decided at all.
 *
 * The stream ENDS after this event. Answering is a new request carrying the
 * replies, which keeps the transport one-directional; SSE has no upstream
 * channel and inventing one for a question asked at most once per run would be
 * a lot of machinery for a rare moment.
 */
export interface ClarifyEvent {
  readonly questions: readonly string[];
  /** Why the run stopped to ask, in the reader's terms. */
  readonly because: string;
}

export const DEEP_EVENTS = ['plan', 'step', 'reflect', 'clarify'] as const;
export type DeepEventName = (typeof DEEP_EVENTS)[number];
