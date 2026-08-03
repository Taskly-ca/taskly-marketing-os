import { describe, it, expect } from 'vitest';
import {
  COUNT_TAIL_ALPHA,
  countTailsDetector,
  fitCountModel,
  logGamma,
  negBinomialTailUpper,
  poissonTailLower,
  poissonTailUpper,
  tailUpper,
} from './count-tails.js';
import type { Observation } from './types.js';

const day = (i: number): string => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
const series = (values: readonly number[]): Observation[] =>
  values.map((value, i) => ({ at: day(i), value }));
const at = (i: number, value: number): Observation => ({ at: day(i), value });

/** The Gaussian a naive detector would have used on the same counts. */
function classicalZ(value: number, xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return (value - mean) / Math.sqrt(variance);
}

describe('count-tails / distributions', () => {
  it('computes log-gamma accurately enough for factorials', () => {
    expect(Math.exp(logGamma(1))).toBeCloseTo(1, 10);
    expect(Math.exp(logGamma(5))).toBeCloseTo(24, 8); // 4!
    expect(Math.exp(logGamma(11))).toBeCloseTo(3_628_800, 2); // 10!
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
  });

  it('matches hand-computed Poisson tails', () => {
    // P(X >= 1 | 1) = 1 - e^-1
    expect(poissonTailUpper(1, 1)).toBeCloseTo(1 - Math.E ** -1, 12);
    // P(X <= 1 | 8) = e^-8 (1 + 8)
    expect(poissonTailLower(1, 8)).toBeCloseTo(9 * Math.exp(-8), 12);
    // P(X >= 2 | 0.3)
    expect(poissonTailUpper(2, 0.3)).toBeCloseTo(1 - 1.3 * Math.exp(-0.3), 12);
    expect(poissonTailUpper(0, 4)).toBeCloseTo(1, 12);
    expect(poissonTailLower(0, 4)).toBeCloseTo(Math.exp(-4), 12);
  });

  it('keeps Poisson tails asymmetric — the whole reason not to use a z-score', () => {
    // Same distance from the mean either side, wildly different probabilities.
    expect(poissonTailUpper(8, 4)).not.toBeCloseTo(poissonTailLower(0, 4), 3);
  });

  it('gives the negative binomial a heavier tail than the Poisson of equal mean', () => {
    const p = poissonTailUpper(20, 4);
    const nb = negBinomialTailUpper(20, 4, 0.25);
    expect(nb).toBeGreaterThan(p * 1_000);
    expect(nb).toBeLessThan(1);
  });

  it('keeps every tail inside [0, 1]', () => {
    for (const k of [0, 1, 3, 10, 40]) {
      for (const lambda of [0.05, 1, 5, 30]) {
        expect(poissonTailUpper(k, lambda)).toBeGreaterThanOrEqual(0);
        expect(poissonTailUpper(k, lambda)).toBeLessThanOrEqual(1);
        expect(poissonTailLower(k, lambda)).toBeGreaterThanOrEqual(0);
        expect(poissonTailLower(k, lambda)).toBeLessThanOrEqual(1);
        expect(poissonTailUpper(k, lambda) + poissonTailLower(k - 1, lambda)).toBeCloseTo(1, 8);
      }
    }
  });
});

describe('count-tails / model selection', () => {
  it('picks Poisson when the variance tracks the mean', () => {
    const counts = [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const fit = fitCountModel(counts);
    expect(fit.kind).toBe('poisson');
    expect(fit.r).toBeNull();
    expect(fit.mean).toBeCloseTo(0.3, 10);
  });

  it('picks the negative binomial when the data is overdispersed', () => {
    const bursty = [0, 0, 0, 0, 20, 0, 0, 0, 18, 0, 0, 0, 22, 0, 0, 0, 19, 0, 0, 0];
    const fit = fitCountModel(bursty);
    expect(fit.kind).toBe('negative-binomial');
    expect(fit.mean).toBeCloseTo(3.95, 10);
    expect(fit.dispersionRatio).toBeGreaterThan(10);
    expect(fit.r).not.toBeNull();
    expect(fit.r!).toBeGreaterThan(0);
    expect(fit.r!).toBeLessThan(1);
  });

  it('floors the rate so an all-zero history cannot produce a p-value of exactly 0', () => {
    const fit = fitCountModel(Array.from({ length: 14 }, () => 0));
    expect(fit.mean).toBeGreaterThan(0);
    expect(tailUpper(fit, 1)).toBeGreaterThan(0);
    expect(tailUpper(fit, 1)).toBeLessThan(0.1);
  });
});

describe('count-tails detector', () => {
  it('abstains when history is shorter than minHistory', () => {
    const history = series([0, 1, 0]);
    const d = countTailsDetector.run({ current: at(3, 9), history });
    expect(history.length).toBeLessThan(countTailsDetector.minHistory);
    expect(d.fired).toBe(false);
    expect(d.pValue).toBeNull();
    expect(d.detail).toMatch(/histor/i);
  });

  it('stays sane at n < 26 where a Gaussian would cry wolf', () => {
    // Twenty days of mostly-zero counts, then a 2. A Gaussian sees 3.6 sigma.
    // Poisson sees a one-in-27-days event, which across a daily panel is noise.
    const counts = [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(counts.length).toBeLessThan(26);
    expect(classicalZ(2, counts)).toBeGreaterThan(3);

    const d = countTailsDetector.run({ current: at(20, 2), history: series(counts) });
    expect(d.fired).toBe(false);
    expect(d.pValue).not.toBeNull();
    expect(d.pValue!).toBeGreaterThan(COUNT_TAIL_ALPHA);
    expect(d.pValue!).toBeCloseTo(1 - 1.3 * Math.exp(-0.3), 6);
    expect(d.detail).toMatch(/poisson/i);
  });

  it('does fire on a spike that is genuinely improbable at that rate', () => {
    const counts = [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const d = countTailsDetector.run({ current: at(20, 5), history: series(counts) });
    expect(d.fired).toBe(true);
    expect(d.pValue!).toBeLessThan(1e-4);
    expect(d.score).toBeGreaterThan(0);
    expect(d.detail).toMatch(/P\(X ≥ 5\)/);
  });

  it('fires on a collapse using the LOWER tail, with a negative score', () => {
    const counts = [8, 7, 9, 8, 10, 6, 8, 9, 7, 8, 9, 7, 8, 10, 6, 8, 9, 7, 8, 9];
    const d = countTailsDetector.run({ current: at(20, 1), history: series(counts) });
    expect(d.fired).toBe(true);
    expect(d.score).toBeLessThan(0);
    expect(d.pValue!).toBeLessThan(COUNT_TAIL_ALPHA);
    expect(d.detail).toMatch(/P\(X ≤ 1\)/);
  });

  it('does not scream at a bursty series — it switches to the negative binomial', () => {
    const bursty = [0, 0, 0, 0, 20, 0, 0, 0, 18, 0, 0, 0, 22, 0, 0, 0, 19, 0, 0, 0];
    const d = countTailsDetector.run({ current: at(20, 22), history: series(bursty) });

    // A Poisson fit on the same numbers would have called this a 1-in-10^8 day.
    expect(poissonTailUpper(22, 3.95)).toBeLessThan(1e-8);

    expect(d.detail).toMatch(/negative binomial/i);
    expect(d.detail).toMatch(/overdispers/i);
    expect(d.fired).toBe(false);
    expect(d.pValue!).toBeGreaterThan(COUNT_TAIL_ALPHA);
    expect(d.pValue!).toBeLessThan(0.3);
    expect(d.pValue!).toBeGreaterThan(poissonTailUpper(22, 3.95) * 1e6);
  });

  it('refuses non-count history rather than silently rounding it', () => {
    const d = countTailsDetector.run({
      current: at(20, 5),
      history: series([1, 2, -3, 4, 1, 0, 2, 1, 0, 1]),
    });
    expect(d.fired).toBe(false);
    expect(d.pValue).toBeNull();
    expect(d.detail).toMatch(/count/i);
  });
});
