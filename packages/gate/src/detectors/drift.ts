/**
 * Slow drift — EWMA and CUSUM.
 *
 * Robust-z and the count tails judge one point against a baseline, so they see
 * a spike and miss a slide: a series that moves 1 sigma and STAYS there never
 * produces a single surprising day, and the baseline quietly follows it down.
 * Both charts here integrate over time instead, which is what makes them
 * sensitive to shifts far smaller than any per-point rule can reach.
 *
 *   EWMA  S_t = lambda*x_t + (1-lambda)*S_{t-1}, lambda = 0.25. Var(S) settles
 *         at sigma^2 * lambda/(2-lambda), so the control limit is
 *         L * sigma * sqrt(lambda/(2-lambda)) with L = 3.
 *   CUSUM C+_t = max(0, C+_{t-1} + (x_t - centre) - k) and its mirror, with the
 *         textbook k = 0.5 sigma (tuned for a 1-sigma shift) and decision
 *         interval h = 5 sigma. That pair is the standard ARL compromise.
 *
 * Two deliberate choices:
 *
 * 1. The baseline is the FIRST half of the history and the chart runs over the
 *    rest. A drift that is allowed into its own baseline cancels itself out.
 * 2. Centre and sigma are the robust ones (median, scaled MAD) from
 *    `robust-z.ts`, for the same reason they are robust there — a single
 *    outlier in the reference window otherwise sets the control limits.
 *
 * Both charts are prone to FALSE POSITIVES on complex anomaly shapes: a
 * transient that decays, a level shift that reverts, a seasonal ramp. They
 * accumulate evidence and cannot tell "moved" from "moving". That is precisely
 * why nothing here promotes on its own — see `fdr.ts` for the panel-wide
 * Benjamini-Hochberg pass, the 2-of-3 persistence rule, and the hysteresis band
 * that stops a chart hovering at its limit from re-firing every day.
 *
 * Neither reports a p-value. A control-chart limit is an ARL design point, not
 * a calibrated tail probability, and dressing one up as a p-value would poison
 * the FDR pass it feeds. They emit `pValue: null` and pass through unchanged.
 */
import { abstain } from './types.js';
import type { Detection, DetectionInput, Detector } from './types.js';
import { robustScale } from './robust-z.js';

/** Memory of the EWMA. 0.25 weights roughly the last week of a daily series. */
export const EWMA_LAMBDA = 0.25;

/** Control-limit width in EWMA standard deviations. */
export const EWMA_L = 3;

/** CUSUM slack, in sigmas. Half the shift we want to catch. */
export const CUSUM_K_SIGMA = 0.5;

/** CUSUM decision interval, in sigmas. */
export const CUSUM_H_SIGMA = 5;

/** Enough for a 7-point reference window plus 7 monitored points. */
export const DRIFT_MIN_HISTORY = 14;

/** Never fit a control limit on fewer points than this. */
export const MIN_BASELINE = 7;

export interface BaselineSplit {
  /** Reference window — assumed in control. */
  baseline: number[];
  /** Everything after it, which is what the chart runs over. */
  monitor: number[];
}

export function splitBaseline(values: readonly number[]): BaselineSplit {
  const n = values.length;
  const size = Math.min(Math.max(MIN_BASELINE, Math.floor(n / 2)), Math.max(0, n - 1));
  return { baseline: values.slice(0, size), monitor: values.slice(size) };
}

export interface EwmaResult {
  /** The smoothed statistic after the last monitored point. */
  statistic: number;
  center: number;
  sigma: number;
  /** Distance from centre at which the chart fires. */
  limit: number;
  /** Signed and normalised: |score| >= 1 is a firing. */
  score: number;
}

export function ewma(
  baseline: readonly number[],
  monitor: readonly number[],
  lambda: number = EWMA_LAMBDA,
  L: number = EWMA_L,
): EwmaResult | null {
  const s = robustScale(baseline);
  if (s.kind === 'none' || !(s.scale > 0)) return null;

  let statistic = s.center;
  for (const x of monitor) statistic = lambda * x + (1 - lambda) * statistic;

  const limit = L * s.scale * Math.sqrt(lambda / (2 - lambda));
  return {
    statistic,
    center: s.center,
    sigma: s.scale,
    limit,
    score: (statistic - s.center) / limit,
  };
}

export interface CusumResult {
  /** Upward accumulation. */
  high: number;
  /** Downward accumulation (positive-valued). */
  low: number;
  center: number;
  sigma: number;
  /** Slack per step. */
  k: number;
  /** Decision interval. */
  h: number;
  /** Signed and normalised: |score| >= 1 is a firing. */
  score: number;
}

export function cusum(
  baseline: readonly number[],
  monitor: readonly number[],
  kSigma: number = CUSUM_K_SIGMA,
  hSigma: number = CUSUM_H_SIGMA,
): CusumResult | null {
  const s = robustScale(baseline);
  if (s.kind === 'none' || !(s.scale > 0)) return null;

  const k = kSigma * s.scale;
  const h = hSigma * s.scale;
  let high = 0;
  let low = 0;
  for (const x of monitor) {
    const dev = x - s.center;
    high = Math.max(0, high + dev - k);
    low = Math.max(0, low - dev - k);
  }
  const magnitude = Math.max(high, low);
  const sign = high >= low ? 1 : -1;
  return { high, low, center: s.center, sigma: s.scale, k, h, score: (sign * magnitude) / h };
}

interface Prepared {
  baseline: number[];
  monitor: number[];
}

function prepare(input: DetectionInput): Prepared {
  const split = splitBaseline(input.history.map((o) => o.value));
  return { baseline: split.baseline, monitor: [...split.monitor, input.current.value] };
}

const shortHistory = (name: string, n: number): Detection =>
  abstain(name, `history of ${n} < ${DRIFT_MIN_HISTORY} required — abstaining`);

const noScale = (name: string): Detection =>
  abstain(name, 'zero dispersion in the reference window — no sigma, so no control limit');

export const ewmaDetector: Detector = {
  name: 'ewma',
  minHistory: DRIFT_MIN_HISTORY,
  run(input: DetectionInput): Detection {
    const name = 'ewma';
    if (input.history.length < DRIFT_MIN_HISTORY) {
      return shortHistory(name, input.history.length);
    }
    const { baseline, monitor } = prepare(input);
    const r = ewma(baseline, monitor);
    if (r === null) return noScale(name);

    return {
      detector: name,
      fired: Math.abs(r.score) >= 1,
      // Control-chart rule, not a statistical test. See the file header.
      pValue: null,
      score: r.score,
      detail:
        `EWMA(λ=${EWMA_LAMBDA}) at ${r.statistic.toFixed(2)} vs centre ${r.center.toFixed(2)} ` +
        `(limit ±${r.limit.toFixed(2)}, ${(Math.abs(r.score) * 100).toFixed(0)}% of it) over ` +
        `${monitor.length} points on a ${baseline.length}-point reference window`,
    };
  },
};

export const cusumDetector: Detector = {
  name: 'cusum',
  minHistory: DRIFT_MIN_HISTORY,
  run(input: DetectionInput): Detection {
    const name = 'cusum';
    if (input.history.length < DRIFT_MIN_HISTORY) {
      return shortHistory(name, input.history.length);
    }
    const { baseline, monitor } = prepare(input);
    const r = cusum(baseline, monitor);
    if (r === null) return noScale(name);

    const arm = r.score >= 0 ? 'upward' : 'downward';
    return {
      detector: name,
      fired: Math.abs(r.score) >= 1,
      // Control-chart rule, not a statistical test. See the file header.
      pValue: null,
      score: r.score,
      detail:
        `CUSUM ${arm} arm at ${Math.max(r.high, r.low).toFixed(2)} vs h=${r.h.toFixed(2)} ` +
        `(k=${r.k.toFixed(2)}, centre ${r.center.toFixed(2)}) over ${monitor.length} points ` +
        `on a ${baseline.length}-point reference window`,
    };
  },
};
