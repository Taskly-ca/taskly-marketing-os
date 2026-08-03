/**
 * Exact count tails — Poisson and negative binomial.
 *
 * Almost every per-entity daily series here is a COUNT, and most of them run
 * under 26 per day. A Gaussian is the wrong model twice over at that volume:
 * it is symmetric (the tails of a count distribution are not), and it is
 * continuous over a support that is discrete and floored at zero. The practical
 * consequence is over-firing at the bottom of the range — two events on a
 * 0.3/day series is 3.6 "sigma" and completely unremarkable (p = 0.037).
 *
 * So: estimate the rate from trailing counts, then read the real tail.
 *   spike -> P(X >= observed)
 *   drop  -> P(X <= observed)
 *
 * Model choice is by dispersion. Poisson forces variance = mean; real counts
 * are usually burstier than that, and forcing a Poisson onto bursty data
 * manufactures p-values around 1e-10 for things that happen every other week.
 * When the sample variance meaningfully exceeds the mean we switch to a
 * negative binomial (method of moments on the same two moments) and say so in
 * `detail`. The margin is deliberate: at n < 26 the sample variance is itself
 * noisy, so a bare `variance > mean` test flips on coin-flip noise.
 *
 * Distributions are implemented here — log-gamma by the Lanczos approximation,
 * tails by direct recursive summation. No dependencies, no network, no
 * filesystem. Summation always runs over the SMALLER tail and complements when
 * the requested one is the larger, which avoids both the cancellation of
 * `1 - cdf` on tiny tails and the underflow of a pmf far from the mode.
 */
import { abstain } from './types.js';
import type { Detection, DetectionInput, Detector } from './types.js';

/** One week. The rate is estimable from very little; the whole point of this
 *  module is that it works where a Gaussian scale estimate does not. */
export const COUNT_MIN_HISTORY = 7;

/** Per-detection significance. The panel-wide error rate is the FDR pass's job. */
export const COUNT_TAIL_ALPHA = 0.01;

/** variance/mean above this selects the negative binomial. */
export const OVERDISPERSION_RATIO = 1.25;

/** Jeffreys' prior on a Poisson rate contributes half an event. Without this
 *  floor an all-zero history yields lambda = 0 and a p-value of exactly 0. */
const JEFFREYS_PSEUDO_EVENTS = 0.5;

/** Guard on the tail summations. Nothing we watch comes near this. */
const MAX_TAIL_TERMS = 100_000;

/** Relative size at which a further term stops changing the answer. */
const TAIL_EPS = 1e-17;

const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** log Gamma(x) for x > 0. Lanczos g=7, n=9 — ~15 significant digits. */
export function logGamma(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return Number.NaN;
  if (x < 0.5) {
    // Reflection: Gamma(x) * Gamma(1-x) = pi / sin(pi x)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS[0] ?? 0;
  for (let i = 1; i < LANCZOS.length; i++) a += (LANCZOS[i] ?? 0) / (z + i);
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

export type CountModelKind = 'poisson' | 'negative-binomial';

export interface CountFit {
  kind: CountModelKind;
  mean: number;
  variance: number;
  /** Negative-binomial dispersion (the "size" parameter). null for Poisson. */
  r: number | null;
  /** variance / mean. 1 is Poisson; above 1 is bursty. */
  dispersionRatio: number;
}

export function fitCountModel(counts: readonly number[]): CountFit {
  const n = counts.length;
  const sum = counts.reduce((a, b) => a + b, 0);
  const rawMean = n === 0 ? 0 : sum / n;
  const floor = n === 0 ? JEFFREYS_PSEUDO_EVENTS : JEFFREYS_PSEUDO_EVENTS / n;
  const mean = Math.max(rawMean, floor);
  const variance = n < 2 ? 0 : counts.reduce((acc, x) => acc + (x - rawMean) ** 2, 0) / (n - 1);
  const dispersionRatio = mean > 0 ? variance / mean : 0;

  if (dispersionRatio > OVERDISPERSION_RATIO && variance > mean) {
    // Method of moments: var = mu + mu^2 / r  =>  r = mu^2 / (var - mu).
    // Clamped so a wildly bursty window cannot produce a degenerate r.
    const r = Math.min(1e6, Math.max(0.01, mean ** 2 / (variance - mean)));
    return { kind: 'negative-binomial', mean, variance, r, dispersionRatio };
  }
  return { kind: 'poisson', mean, variance, r: null, dispersionRatio };
}

/** A discrete distribution expressed the only two ways the tail sums need it. */
interface DiscreteModel {
  mean: number;
  logPmf(k: number): number;
  /** pmf(j) / pmf(j-1), for j >= 1. */
  ratio(j: number): number;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** P(X >= k) by direct summation upward. Accurate when the tail is small. */
function sumUp(m: DiscreteModel, k: number): number {
  let term = Math.exp(m.logPmf(k));
  if (!Number.isFinite(term)) return 0;
  let total = term;
  for (let j = k + 1; j < k + MAX_TAIL_TERMS; j++) {
    term *= m.ratio(j);
    total += term;
    if (term <= total * TAIL_EPS) break;
  }
  return clamp01(total);
}

/** P(X <= k) by direct summation downward. Accurate when the tail is small. */
function sumDown(m: DiscreteModel, k: number): number {
  if (k < 0) return 0;
  let term = Math.exp(m.logPmf(k));
  if (!Number.isFinite(term)) return 0;
  let total = term;
  for (let j = k; j >= 1; j--) {
    term /= m.ratio(j);
    total += term;
    if (term <= total * TAIL_EPS) break;
  }
  return clamp01(total);
}

/** P(X >= k). */
function upperTail(m: DiscreteModel, k: number): number {
  if (k <= 0) return 1;
  const ki = Math.ceil(k);
  if (ki > MAX_TAIL_TERMS) return 0;
  // On the near side of the mean the upper tail is the LARGE one; take the
  // complement of the small one so no significant digits are lost.
  return ki <= m.mean ? clamp01(1 - sumDown(m, ki - 1)) : sumUp(m, ki);
}

/** P(X <= k). */
function lowerTail(m: DiscreteModel, k: number): number {
  if (k < 0) return 0;
  const ki = Math.floor(k);
  if (ki > MAX_TAIL_TERMS) return 1;
  return ki >= m.mean ? clamp01(1 - sumUp(m, ki + 1)) : sumDown(m, ki);
}

const poissonModel = (lambda: number): DiscreteModel => ({
  mean: lambda,
  logPmf: (k) => k * Math.log(lambda) - lambda - logGamma(k + 1),
  ratio: (j) => lambda / j,
});

/** NB parameterised by mean and dispersion r, so var = mean + mean^2 / r. */
const negBinomialModel = (mean: number, r: number): DiscreteModel => {
  const p = r / (r + mean); // "success" probability
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  return {
    mean,
    logPmf: (k) => logGamma(k + r) - logGamma(r) - logGamma(k + 1) + r * logP + k * logQ,
    ratio: (j) => ((j - 1 + r) / j) * (1 - p),
  };
};

const poissonUsable = (lambda: number): boolean => Number.isFinite(lambda) && lambda > 0;
const nbUsable = (mean: number, r: number): boolean =>
  Number.isFinite(mean) && Number.isFinite(r) && mean > 0 && r > 0;

/** P(X >= k) for a Poisson with rate lambda. */
export function poissonTailUpper(k: number, lambda: number): number {
  if (!poissonUsable(lambda)) return k <= 0 ? 1 : 0;
  return upperTail(poissonModel(lambda), k);
}

/** P(X <= k) for a Poisson with rate lambda. */
export function poissonTailLower(k: number, lambda: number): number {
  if (k < 0) return 0;
  if (!poissonUsable(lambda)) return 1;
  return lowerTail(poissonModel(lambda), k);
}

/** P(X >= k) for a negative binomial with the given mean and dispersion. */
export function negBinomialTailUpper(k: number, mean: number, r: number): number {
  if (!nbUsable(mean, r)) return k <= 0 ? 1 : 0;
  return upperTail(negBinomialModel(mean, r), k);
}

/** P(X <= k) for a negative binomial with the given mean and dispersion. */
export function negBinomialTailLower(k: number, mean: number, r: number): number {
  if (k < 0) return 0;
  if (!nbUsable(mean, r)) return 1;
  return lowerTail(negBinomialModel(mean, r), k);
}

export function tailUpper(fit: CountFit, k: number): number {
  return fit.kind === 'poisson'
    ? poissonTailUpper(k, fit.mean)
    : negBinomialTailUpper(k, fit.mean, fit.r ?? 1);
}

export function tailLower(fit: CountFit, k: number): number {
  return fit.kind === 'poisson'
    ? poissonTailLower(k, fit.mean)
    : negBinomialTailLower(k, fit.mean, fit.r ?? 1);
}

const isCount = (x: number): boolean => Number.isFinite(x) && x >= 0 && Number.isInteger(x);

export const countTailsDetector: Detector = {
  name: 'count-tails',
  minHistory: COUNT_MIN_HISTORY,
  run(input: DetectionInput): Detection {
    const name = 'count-tails';
    if (input.history.length < COUNT_MIN_HISTORY) {
      return abstain(
        name,
        `history of ${input.history.length} < ${COUNT_MIN_HISTORY} required — abstaining`,
      );
    }
    const counts = input.history.map((o) => o.value);
    const observed = input.current.value;
    if (!counts.every(isCount) || !isCount(observed)) {
      return abstain(
        name,
        'series is not non-negative integer counts — this detector does not apply',
      );
    }

    const fit = fitCountModel(counts);
    const spike = observed >= fit.mean;
    const p = Math.max(spike ? tailUpper(fit, observed) : tailLower(fit, observed), 1e-300);
    const model =
      fit.kind === 'poisson'
        ? `poisson λ=${fit.mean.toFixed(2)}`
        : `negative binomial (overdispersed, var/mean=${fit.dispersionRatio.toFixed(1)}) ` +
          `μ=${fit.mean.toFixed(2)} r=${(fit.r ?? 0).toFixed(3)}`;

    return {
      detector: name,
      fired: p <= COUNT_TAIL_ALPHA,
      pValue: p,
      // Signed -log10(p): magnitude for ranking, sign for direction.
      score: (spike ? 1 : -1) * -Math.log10(p),
      detail:
        `${model} · P(X ${spike ? '≥' : '≤'} ${observed}) = ${p.toExponential(2)} ` +
        `over n=${counts.length}`,
    };
  },
};
