/**
 * "WHAT SHOULD WE WORK ON?" — the question the whole system was built toward
 * and the one it has never answered.
 *
 * Every layer below this produces EVIDENCE: a competitor's page changed, a
 * sitemap gained two services, a season opens in eight weeks, a Brain document
 * states our positioning. None of it tells anyone what to do on Monday, and the
 * gap between "40 facts" and "a decision" is the gap this closes.
 *
 * ── THE FAILURE MODE THIS IS DESIGNED AGAINST ──────────────────────────────
 *
 * A model handed a competitor fact and a brand document will write a confident
 * weekly marketing plan. It will do this with two facts or with two hundred,
 * and the plans are indistinguishable — same register, same certainty, same
 * five bullet points. That output is worse than no output, because it launders
 * a guess through a system whose entire claim is that it does not guess.
 *
 * Three rules hold it down, and all three are load-bearing:
 *
 *  1. **Every recommendation names the evidence it rests on**, by index, and a
 *     recommendation citing nothing is deleted. Not softened — deleted.
 *
 *  2. **The basis is DERIVED from that evidence, never chosen by the model.**
 *     `basisFor` already does this for Brain retrieval and the reasoning is
 *     identical: a model asked how confident it is answers a different question
 *     than the one being asked. A recommendation can never exceed
 *     `inferred_from_sources`, because a recommendation IS an inference — there
 *     is no such thing as a measured "should".
 *
 *  3. **A falsifier is required.** The prediction ledger made `falsifier` NOT
 *     NULL for exactly this reason: a proposal nobody can be wrong about is
 *     astrology, and it is the cheapest thing in the world to generate.
 *
 * And the fourth, which is really a consequence: **an empty draft is a valid
 * draft.** A quiet week where nothing was observed should produce nothing, the
 * way the digest produces QUIET. A system that always finds five things to do
 * is a system whose output carries no information.
 */
import type { Basis } from '@tmos/contracts';

/** Where a piece of evidence came from, and therefore what it can support. */
export type EvidenceKind =
  /** A verified competitor change that survived the adversarial verifier. */
  | 'finding'
  /** A value read off a competitor's own page and stored in the world model. */
  | 'fact'
  /** A window we wrote in a calendar. Real, scheduled, and not an observation. */
  | 'season'
  /** An open forecast. What we EXPECT — evidence about us, not about the world. */
  | 'forecast'
  /** A Taskly document. What we believe, decided or published. */
  | 'brain';

export interface Evidence {
  /** 1-based, and what a recommendation cites. Stable within one draft. */
  readonly id: number;
  readonly kind: EvidenceKind;
  /** One line, as it will be shown under the recommendation that cites it. */
  readonly text: string;
  /** A URL, or a Brain path with its section. What a reader opens to check. */
  readonly source: string;
  readonly observedAt?: string;
}

export interface Recommendation {
  /** Imperative and specific enough to start. "Explore X" is not an action. */
  readonly action: string;
  /** Why it follows — the reasoning, not a restatement of the evidence. */
  readonly reasoning: string;
  /** What would show this was the wrong call. Required, never generated empty. */
  readonly falsifier: string;
  /** Evidence ids. Non-empty by construction — the gate drops the rest. */
  readonly evidence: readonly number[];
  /** When this stops being actionable. Seasons make this real, not decorative. */
  readonly horizon: string;
  /** Derived from the cited evidence. Never the model's opinion of itself. */
  readonly basis: Basis;
}

export interface DroppedRecommendation {
  readonly action: string;
  readonly why: string;
}

export interface Draft {
  readonly generatedAt: string;
  /** Empty when nothing was observed. The honest output for a quiet week. */
  readonly recommendations: readonly Recommendation[];
  readonly dropped: readonly DroppedRecommendation[];
  readonly evidence: readonly Evidence[];
  /** Said plainly when there is nothing to say, instead of padding. */
  readonly note: string;
  readonly costCents: number;
}

export interface AskPort {
  ask(system: string, user: string, maxTokens: number): Promise<{ text: string; costCents: number } | null>;
}
