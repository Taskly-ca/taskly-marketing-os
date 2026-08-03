/**
 * Robust z — the workhorse detector.
 *
 * A standard z-score divides by the standard deviation, and the standard
 * deviation is computed from the same window that contains the anomaly. One
 * large outlier inflates sigma enough to hide everything after it — the
 * detector is blinded by exactly the event it exists to find. The median and
 * the median absolute deviation have a 50% breakdown point, so half the window
 * can be garbage before the estimate moves.
 *
 *     z = |x - median| / (1.4826 * MAD)
 *
 * 1.4826 makes the MAD a consistent estimator of sigma for Gaussian data, so
 * the familiar cutoffs still mean what they normally mean. We fire at 3.5
 * (Iglewicz & Hoaglin's modified z-score cutoff).
 *
 * Two baselines are exported:
 *   - `robustZDetector`      — flat trailing baseline.
 *   - `weekdayRobustZDetector` — median of the SAME WEEKDAY over a trailing
 *     4-8 weeks. Weekly seasonality is the single largest false-positive source
 *     in daily marketing counts, and this handles it without fitting anything.
 *     Seasonal decomposition (STL/Prophet) is not an option here: it needs at
 *     least two full seasonal cycles of clean history, which we do not have.
 *
 * The p-value is a two-sided normal tail on the robust z. It is approximate —
 * the MAD is not sigma for non-Gaussian data — and it exists so the detection
 * can enter the Benjamini-Hochberg pass alongside the exact count tails, not as
 * a claim about the true false-positive rate. The FIRE decision uses the 3.5
 * cutoff, not the p-value.
 */
import { abstain } from './types.js';
import type { Detection, DetectionInput, Detector, Observation } from './types.js';

/** Makes the MAD a consistent estimator of sigma under normality. */
export const MAD_SCALE = 1.4826;

/** Same job for the mean absolute deviation — the fallback when MAD hits 0. */
export const MEAN_AD_SCALE = 1.2533;

/** Iglewicz & Hoaglin's modified z cutoff. */
export const ROBUST_Z_THRESHOLD = 3.5;

/** Two weeks. Below this the median itself is too jumpy to be a baseline. */
export const ROBUST_Z_MIN_HISTORY = 14;

/** Four weeks — the minimum that yields four same-weekday observations. */
export const WEEKDAY_MIN_HISTORY = 28;

/** Trailing same-weekday window: at most 8 weeks (older than that is a
 *  different business), at least 4 (fewer and the median is a coin flip). */
export const WEEKDAY_WINDOW_MAX = 8;
export const WEEKDAY_WINDOW_MIN = 4;

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const hi = sorted[mid];
  if (hi === undefined) return Number.NaN;
  if (sorted.length % 2 === 1) return hi;
  const lo = sorted[mid - 1];
  return lo === undefined ? hi : (lo + hi) / 2;
}

/** Median absolute deviation from the median. Unscaled. */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Mean absolute deviation from the median. Unscaled. */
export function meanAbsoluteDeviation(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const m = median(xs);
  return xs.reduce((acc, x) => acc + Math.abs(x - m), 0) / xs.length;
}

export type ScaleKind = 'mad' | 'mean-ad' | 'none';

export interface RobustScale {
  center: number;
  /** Already multiplied by its consistency constant. 0 when kind is 'none'. */
  scale: number;
  kind: ScaleKind;
}

/**
 * Centre and spread, with the MAD = 0 case handled explicitly rather than by
 * dividing by zero. MAD collapses whenever more than half the window shares one
 * value — routine for low-volume counts sitting at 0. We then fall back to the
 * scaled mean absolute deviation, which only collapses if the series is
 * PERFECTLY constant. At that point there is no dispersion estimate to be had
 * and the honest answer is to abstain, not to report an infinite z.
 */
export function robustScale(xs: readonly number[]): RobustScale {
  const center = median(xs);
  const m = mad(xs);
  if (m > 0) return { center, scale: m * MAD_SCALE, kind: 'mad' };

  const meanAd = meanAbsoluteDeviation(xs);
  if (meanAd > 0) return { center, scale: meanAd * MEAN_AD_SCALE, kind: 'mean-ad' };

  return { center, scale: 0, kind: 'none' };
}

export interface RobustZ extends RobustScale {
  /** Signed. Positive = above baseline. */
  z: number;
}

/** null when the baseline has no dispersion at all. */
export function robustZScore(value: number, baseline: readonly number[]): RobustZ | null {
  const s = robustScale(baseline);
  if (s.kind === 'none' || !Number.isFinite(s.scale) || s.scale <= 0) return null;
  return { ...s, z: (value - s.center) / s.scale };
}

/**
 * Complementary error function — Numerical Recipes' Chebyshev fit. Fractional
 * error below 1.2e-7 everywhere, which is far finer than the ordering
 * resolution Benjamini-Hochberg needs. Implemented here so the package keeps
 * zero dependencies.
 */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
}

/** P(|Z| > |z|) for a standard normal. */
export function normalTwoSidedP(z: number): number {
  if (!Number.isFinite(z)) return 0;
  return Math.min(1, Math.max(0, erfc(Math.abs(z) / Math.SQRT2)));
}

const format = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function judge(name: string, value: number, baseline: readonly number[], where: string): Detection {
  const r = robustZScore(value, baseline);
  if (r === null) {
    return abstain(
      name,
      `zero dispersion in the ${where} baseline (constant series) — no scale estimate, so no z`,
    );
  }
  const direction = r.z >= 0 ? 'above' : 'below';
  return {
    detector: name,
    fired: Math.abs(r.z) >= ROBUST_Z_THRESHOLD,
    pValue: normalTwoSidedP(r.z),
    score: r.z,
    detail:
      `${format(value)} is ${Math.abs(r.z).toFixed(2)} robust-z ${direction} the ${where} ` +
      `median ${format(r.center)} (scale ${r.scale.toFixed(3)} via ${r.kind}, n=${baseline.length})`,
  };
}

export const robustZDetector: Detector = {
  name: 'robust-z',
  minHistory: ROBUST_Z_MIN_HISTORY,
  run(input: DetectionInput): Detection {
    if (input.history.length < ROBUST_Z_MIN_HISTORY) {
      return abstain(
        'robust-z',
        `history of ${input.history.length} < ${ROBUST_Z_MIN_HISTORY} required — abstaining`,
      );
    }
    return judge(
      'robust-z',
      input.current.value,
      input.history.map((o) => o.value),
      'trailing',
    );
  },
};

/** UTC weekday, or null if the stamp is not a parseable date. UTC deliberately:
 *  a local-time reading would shift a day's bucket with the server's timezone. */
function utcWeekday(iso: string): number | null {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t).getUTCDay();
}

/** The trailing same-weekday values, oldest first, capped at WEEKDAY_WINDOW_MAX. */
export function sameWeekdayBaseline(
  current: Observation,
  history: readonly Observation[],
): number[] | null {
  const weekday = utcWeekday(current.at);
  if (weekday === null) return null;
  const matches: number[] = [];
  for (const o of history) {
    if (utcWeekday(o.at) === weekday) matches.push(o.value);
  }
  return matches.slice(-WEEKDAY_WINDOW_MAX);
}

/**
 * Same-weekday baseline. Compares a Tuesday to the median of the last 4-8
 * Tuesdays. This costs history (one point per week instead of per day) and buys
 * immunity to the weekday/weekend cycle that otherwise fires every Saturday.
 */
export const weekdayRobustZDetector: Detector = {
  name: 'robust-z-weekday',
  minHistory: WEEKDAY_MIN_HISTORY,
  run(input: DetectionInput): Detection {
    const name = 'robust-z-weekday';
    if (input.history.length < WEEKDAY_MIN_HISTORY) {
      return abstain(
        name,
        `history of ${input.history.length} < ${WEEKDAY_MIN_HISTORY} required — abstaining`,
      );
    }
    const baseline = sameWeekdayBaseline(input.current, input.history);
    if (baseline === null) {
      return abstain(name, `unparseable date "${input.current.at}" — cannot pick a weekday`);
    }
    if (baseline.length < WEEKDAY_WINDOW_MIN) {
      return abstain(
        name,
        `only ${baseline.length} same-weekday observations, ${WEEKDAY_WINDOW_MIN} required — abstaining`,
      );
    }
    return judge(name, input.current.value, baseline, 'same-weekday');
  },
};
