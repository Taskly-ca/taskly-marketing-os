/**
 * Basis display — what an answer RESTS ON, never how confident a model feels.
 *
 * This is the single most consequential rendering decision in the system, so
 * the reasoning is here rather than in a design doc nobody reads.
 *
 * A model's self-reported confidence is not a weak signal — it is close to an
 * unrelated one. Measured calibration error for verbalised confidence sits
 * around 0.5, and the internal circuit producing "I am 87% sure" is largely
 * independent of the circuit producing the answer. So "87% confident" is a
 * number that looks like evidence, cannot be checked, and moves a reader's
 * trust without earning it. Printing it is worse than printing nothing, because
 * nothing at least prompts the reader to ask.
 *
 * A basis is different: it is a claim about provenance, and provenance is
 * checkable. "Two independent sources" can be audited. "87%" cannot.
 *
 * Consequence, enforced below: no surface in this system may render a
 * confidence percentage, a star rating, or a 0–1 score as if it were certainty.
 * `domain_score` exists for RANKING and must never be shown as confidence.
 */
import type { Basis } from '@tmos/contracts';

export interface BasisDisplay {
  basis: Basis;
  /** What the reader sees. Deliberately a noun phrase, not an adjective. */
  label: string;
  /** One line: where this answer came from. */
  meaning: string;
  /** What the reader may legitimately DO with it — the part that changes
   *  behaviour, and the reason a category beats a number. */
  action: string;
  /**
   * Strength order, 3 = strongest. For SORTING and for choosing the weaker of
   * two bases when combining. Never render this number.
   */
  rank: 0 | 1 | 2 | 3;
}

const DISPLAY: Record<Basis, Omit<BasisDisplay, 'basis'>> = {
  verified_metric: {
    label: 'Verified metric',
    meaning: 'Measured by our own instrumentation.',
    action: 'Safe to act on directly.',
    rank: 3,
  },
  governed_query: {
    label: 'Governed query',
    meaning: 'A typed query over the world model — the same query returns the same answer.',
    action: 'Safe to act on. Re-runnable if you want to check it.',
    rank: 2,
  },
  inferred_from_sources: {
    label: 'Inferred from sources',
    meaning:
      'Read out of source documents by a model. The sources are cited; the reading is not measured.',
    action: 'Check the cited span before anything expensive depends on it.',
    rank: 1,
  },
  exploratory_unverified: {
    label: 'Exploratory',
    meaning: 'An ad-hoc query or an unverified line of thought. Not a governed number.',
    action: 'Use to decide what to look at next. Never quote it as a fact.',
    rank: 0,
  },
};

export const basisDisplay = (basis: Basis): BasisDisplay => ({ basis, ...DISPLAY[basis] });

/**
 * Rendered label, including the independent-source count where it is the whole
 * point of the category.
 *
 * The count must be INDEPENDENT sources after copy-chain collapse. Ten outlets
 * republishing one press release is "1 source", and rendering it as 10 is the
 * exact mechanism by which a single fabricated claim becomes "widely reported".
 */
export function renderBasis(basis: Basis, independentSources?: number): string {
  const d = basisDisplay(basis);
  if (basis !== 'inferred_from_sources' || independentSources === undefined) return d.label;
  if (independentSources <= 0) return 'Inferred — no independent source';
  return `Inferred from ${independentSources} independent source${independentSources === 1 ? '' : 's'}`;
}

/**
 * Combining bases takes the WEAKEST, always.
 *
 * A conclusion resting on a verified metric and an exploratory guess is an
 * exploratory conclusion — the strong leg does not carry the weak one. Taking
 * the max here would let one solid number launder everything attached to it.
 */
export function weakestBasis(bases: readonly Basis[]): Basis {
  if (bases.length === 0) return 'exploratory_unverified';
  return bases.reduce((weakest, b) =>
    basisDisplay(b).rank < basisDisplay(weakest).rank ? b : weakest,
  );
}

/** Basis alone does not decide display prominence — stakes do. A high-stakes
 *  exploratory finding still needs to be seen; it just must not look certain. */
export const mayQuoteAsFact = (basis: Basis): boolean => basisDisplay(basis).rank >= 2;

/* ── the guard ────────────────────────────────────────────────────────────── */

/**
 * Patterns that present a model's feeling as a measurement.
 *
 * Bare percentages are NOT matched — "prices rose 12%" is a fact about the
 * world and must survive. Only percentages attached to certainty language are
 * caught, which is the difference between reporting a number and claiming one.
 */
const CONFIDENCE_PATTERNS: RegExp[] = [
  /\b\d{1,3}(?:\.\d+)?\s?%\s*(?:confiden\w+|certain\w*|sure|likelihood|probability)\b/gi,
  /\b(?:confiden\w+|certainty|sureness)\s*[:=]?\s*\d{1,3}(?:\.\d+)?\s?%/gi,
  /\b(?:confiden\w+|certainty)\s*[:=]\s*(?:0?\.\d+|1\.0+)\b/gi,
  /\bconfidence\s+(?:score|level|rating)\b/gi,
  /\b\d(?:\.\d)?\s?\/\s?5\s*(?:stars?|confiden\w*)\b/gi,
  // No \b — a word boundary requires a word character, and ★ is not one, so
  // `\b★` never matches a string that starts with a star.
  /[★⭐]{1,5}/g,
];

export interface ConfidenceLeak {
  match: string;
  index: number;
}

export function findConfidenceNumbers(text: string): ConfidenceLeak[] {
  const out: ConfidenceLeak[] = [];
  for (const re of CONFIDENCE_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      out.push({ match: m[0], index: m.index ?? 0 });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Throws when rendered text presents confidence as a number.
 *
 * A throw rather than a return, for the same reason the honesty gate throws: a
 * check whose result can be ignored will eventually be ignored, and this one
 * guards a property that is invisible once shipped — nobody reading "87%
 * confident" can tell it is meaningless.
 */
export function assertNoConfidenceNumber(text: string): void {
  const leaks = findConfidenceNumbers(text);
  if (leaks.length === 0) return;
  throw new Error(
    `basis display violated — confidence rendered as a number: ${leaks
      .map((l) => `"${l.match}"`)
      .join(', ')}. Show what the answer rests on (see basisDisplay), not how sure a model feels.`,
  );
}
