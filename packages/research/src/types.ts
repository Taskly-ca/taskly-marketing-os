/**
 * ASK IT A QUESTION — the capability every other part of TMOS assumed away.
 *
 * Everything built so far is a FIXED pipeline: known sources, known questions,
 * known competitors, on a schedule. That is the right shape for "what changed
 * overnight" and it is the wrong shape for "should we launch a snow-removal
 * campaign in October", which is the question a founder actually has. There was
 * no door for a question at all.
 *
 * ── WHY THIS IS NOT A CHATBOT, AND THE DISTINCTION IS THE WHOLE DESIGN ──────
 *
 * A model asked a marketing question answers it. It always answers it. It will
 * describe the Toronto home-services market in confident paragraphs whether or
 * not it has read a single page about it, and there is no way for the reader to
 * tell those two cases apart. That failure is not a hallucination bug to be
 * tuned away — it is what a language model is for, and pointing one at a
 * strategy question is how you get a plan built on nothing.
 *
 * So the model here is never the source. It does two narrow jobs — turn a
 * question into search queries, and turn RETRIEVED TEXT into cited points — and
 * every claim it produces is checked against the documents this run actually
 * fetched. A point whose evidence cannot be found is dropped, not softened.
 *
 * The honest consequence, stated up front because it will happen: **some
 * questions come back mostly empty.** That is the system working. An answer
 * with three cited points and four dropped ones is worth more than eight
 * fluent ones, because you can act on the three.
 */

/** One result from a search provider, before anything has been read. */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  /** The provider's own extract. Never citeable — we cite what WE fetched. */
  readonly snippet: string;
  readonly publishedAt?: string | null;
  readonly provider: string;
}

/** A document this run actually retrieved. The only thing a claim may cite. */
export interface ReadDoc {
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

export interface Citation {
  readonly url: string;
  /** Lifted from `ReadDoc.text`, verbatim. Checked, not trusted. */
  readonly span: string;
}

export interface Point {
  readonly claim: string;
  readonly citations: readonly Citation[];
}

/** Why a point did not survive. Shown to the reader — a gate whose refusals are
 *  invisible teaches nobody anything, and looks like a thin model. */
export interface Dropped {
  readonly claim: string;
  readonly why: string;
}

export interface ResearchAnswer {
  readonly question: string;
  readonly summary: string;
  readonly points: readonly Point[];
  readonly dropped: readonly Dropped[];
  /** Sub-questions the retrieved documents could not answer. Naming the hole is
   *  the difference between a short answer and a misleading one. */
  readonly unanswered: readonly string[];
  readonly sources: readonly ReadDoc[];
  readonly queries: readonly string[];
  readonly costCents: number;
}

/* ── ports ────────────────────────────────────────────────────────────────── */

export interface SearchPort {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchHit[]>;
}

/** Reads a URL, or returns null. MUST enforce robots.txt — the transport gate
 *  is the same one the collectors use, and a research path that routed around
 *  it would make the honest-crawler promise false for the whole system. */
export interface ReadPort {
  read(url: string): Promise<ReadDoc | null>;
}

export interface AskResult {
  readonly text: string;
  readonly costCents: number;
}

/** The only way to spend money on a model. Implemented over `@tmos/shared/llm`
 *  so the daily ceiling, the killswitch and the usage log all still apply. */
export interface AskPort {
  ask(system: string, user: string, maxTokens: number): Promise<AskResult | null>;
}

/**
 * The same door, held open.
 *
 * Deliberately a SEPARATE interface rather than an optional method on
 * `AskPort`: `packages/draft/src/types.ts` declares its own structurally
 * identical copy of `AskPort`, so widening this one silently makes every
 * `AskPort` implementation in the repo — including draft's — wrong at once,
 * and TypeScript reports it at the implementations rather than here. Two
 * narrow ports cost one extra name; one wide port costs two packages.
 *
 * `onDelta` receives the answer as it is written. It is a SIDE CHANNEL for
 * display only — the returned `AskResult.text` is still the whole answer and is
 * still what anything downstream parses or verifies. Nothing that reaches a
 * reader as a claim may be assembled from the deltas alone: the stream can die
 * halfway and a half-answer reads exactly like a whole one.
 */
export interface AskStreamPort {
  askStream(
    system: string,
    user: string,
    maxTokens: number,
    onDelta: (text: string) => void,
  ): Promise<AskResult | null>;
}
