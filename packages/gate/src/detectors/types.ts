/**
 * Shared contract for change detectors.
 *
 * Sizing note that drives every choice in this directory: most per-entity daily
 * counts here will be UNDER 26, and standard detectors approach random
 * performance below that threshold. So count data uses Poisson/negative-binomial
 * tails, not Gaussian z-scores, and seasonal decomposition (STL/Prophet) is not
 * used at all — it needs at least two full seasonal cycles to mean anything.
 */

export interface Observation {
  /** ISO date (day granularity is enough for everything we watch). */
  at: string;
  value: number;
}

export interface DetectionInput {
  /** Newest observation — the one being judged. */
  current: Observation;
  /** Trailing history, oldest first. Callers pass what they have; detectors
   *  must degrade gracefully rather than throw on a short series. */
  history: readonly Observation[];
}

export interface Detection {
  /** Detector identity, for the event log and for per-detector precision stats. */
  detector: string;
  fired: boolean;
  /** Raw p-value where the detector has one; null for non-statistical rules.
   *  Required for the Benjamini–Hochberg pass — we run N detectors × M entities
   *  every day, which is a multiple-testing problem, not N independent tests. */
  pValue: number | null;
  /** Signed magnitude, for ranking once significance is established. */
  score: number;
  detail: string;
}

export interface Detector {
  readonly name: string;
  /** Minimum history length below which this detector must abstain rather than
   *  guess. Abstaining is a `fired: false` with a stated reason. */
  readonly minHistory: number;
  run(input: DetectionInput): Detection;
}

export const abstain = (detector: string, detail: string): Detection => ({
  detector,
  fired: false,
  pValue: null,
  score: 0,
  detail,
});
