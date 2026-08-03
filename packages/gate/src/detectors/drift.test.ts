import { describe, it, expect } from 'vitest';
import {
  CUSUM_H_SIGMA,
  CUSUM_K_SIGMA,
  EWMA_LAMBDA,
  cusum,
  cusumDetector,
  ewma,
  ewmaDetector,
  splitBaseline,
} from './drift.js';
import { MAD_SCALE } from './robust-z.js';
import type { Observation } from './types.js';

const day = (i: number): string => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
const series = (values: readonly number[]): Observation[] =>
  values.map((value, i) => ({ at: day(i), value }));
const at = (i: number, value: number): Observation => ({ at: day(i), value });

/** Seven in-control days: median 10, MAD 1, so sigma = 1.4826. */
const STABLE_BASELINE = [10, 11, 9, 10, 11, 9, 10];
const SIGMA = MAD_SCALE; // MAD of STABLE_BASELINE is exactly 1

describe('drift / baseline split', () => {
  it('never lets the drift contaminate the baseline it is measured against', () => {
    const split = splitBaseline([...STABLE_BASELINE, 11, 12, 13, 14, 15, 16, 17]);
    expect(split.baseline).toEqual(STABLE_BASELINE);
    expect(split.monitor).toEqual([11, 12, 13, 14, 15, 16, 17]);
  });

  it('keeps at least seven baseline points on longer histories', () => {
    const split = splitBaseline(Array.from({ length: 40 }, (_, i) => i));
    expect(split.baseline.length).toBe(20);
    expect(split.monitor.length).toBe(20);
  });
});

describe('EWMA', () => {
  it('tracks a slow ramp past the control limit', () => {
    const monitor = [11, 12, 13, 14, 15, 16, 17, 18];
    const r = ewma(STABLE_BASELINE, monitor);
    expect(r).not.toBeNull();
    expect(r!.center).toBe(10);
    // limit = L * sigma * sqrt(lambda / (2 - lambda))
    expect(r!.limit).toBeCloseTo(3 * SIGMA * Math.sqrt(EWMA_LAMBDA / (2 - EWMA_LAMBDA)), 10);
    expect(r!.statistic).toBeCloseTo(15.3003, 3);
    expect(r!.score).toBeGreaterThan(1);
  });

  it('stays quiet on an in-control series', () => {
    const r = ewma(STABLE_BASELINE, [10, 9, 11, 10, 11, 9, 10, 10]);
    expect(Math.abs(r!.score)).toBeLessThan(1);
  });

  it('has no scale estimate on a constant series', () => {
    expect(ewma([5, 5, 5, 5, 5, 5, 5], [5, 5, 6, 7])).toBeNull();
  });
});

describe('CUSUM', () => {
  it('accumulates a small persistent shift that a Shewhart 3-sigma rule misses', () => {
    const shifted = [12, 12, 12, 12, 12, 12, 12, 12];
    // The shift itself is only ~1.35 sigma — invisible to a per-point 3-sigma rule.
    expect(Math.abs(12 - 10) / SIGMA).toBeLessThan(3);

    const r = cusum(STABLE_BASELINE, shifted);
    expect(r).not.toBeNull();
    expect(r!.h).toBeCloseTo(CUSUM_H_SIGMA * SIGMA, 10);
    expect(r!.high).toBeCloseTo(8 * (2 - CUSUM_K_SIGMA * SIGMA), 8);
    expect(r!.low).toBe(0);
    expect(r!.score).toBeGreaterThan(1);
  });

  it('detects a downward shift on the low arm with a negative score', () => {
    const r = cusum(STABLE_BASELINE, [8, 8, 8, 8, 8, 8, 8, 8]);
    expect(r!.low).toBeGreaterThan(r!.h);
    expect(r!.score).toBeLessThan(-1);
  });

  it('resets to zero on in-control data instead of drifting up', () => {
    const r = cusum(STABLE_BASELINE, [10, 9, 11, 10, 11, 9, 10, 10]);
    expect(r!.high).toBe(0);
    expect(r!.low).toBe(0);
    expect(r!.score).toBe(0);
  });
});

describe('drift detectors', () => {
  const rampHistory = series([...STABLE_BASELINE, 11, 12, 13, 14, 15, 16, 17]);
  const stableHistory = series([...STABLE_BASELINE, 10, 9, 11, 10, 11, 9, 10]);

  it('both abstain when history is shorter than minHistory', () => {
    const history = series([10, 11, 9, 10, 11]);
    for (const detector of [ewmaDetector, cusumDetector]) {
      const d = detector.run({ current: at(5, 40), history });
      expect(history.length).toBeLessThan(detector.minHistory);
      expect(d.fired).toBe(false);
      expect(d.pValue).toBeNull();
      expect(d.score).toBe(0);
      expect(d.detail).toMatch(/histor/i);
    }
  });

  it('both abstain when the baseline has zero dispersion', () => {
    const history = series(Array.from({ length: 14 }, () => 7));
    for (const detector of [ewmaDetector, cusumDetector]) {
      const d = detector.run({ current: at(14, 50), history });
      expect(d.fired).toBe(false);
      expect(d.detail).toMatch(/dispersion/i);
    }
  });

  it('EWMA fires on the ramp and not on the stable series', () => {
    expect(ewmaDetector.run({ current: at(14, 18), history: rampHistory }).fired).toBe(true);
    expect(ewmaDetector.run({ current: at(14, 10), history: stableHistory }).fired).toBe(false);
  });

  it('CUSUM fires on the ramp and not on the stable series', () => {
    expect(cusumDetector.run({ current: at(14, 18), history: rampHistory }).fired).toBe(true);
    expect(cusumDetector.run({ current: at(14, 10), history: stableHistory }).fired).toBe(false);
  });

  it('reports a NULL p-value — these are control-chart rules, not tests', () => {
    // This is exactly the case the FDR pass has to let through unchanged.
    for (const detector of [ewmaDetector, cusumDetector]) {
      const d = detector.run({ current: at(14, 18), history: rampHistory });
      expect(d.fired).toBe(true);
      expect(d.pValue).toBeNull();
      expect(Math.abs(d.score)).toBeGreaterThanOrEqual(1);
    }
  });

  it('normalises score so that 1.0 is exactly the firing threshold', () => {
    const d = cusumDetector.run({ current: at(14, 10), history: stableHistory });
    expect(d.fired).toBe(false);
    expect(Math.abs(d.score)).toBeLessThan(1);
  });
});
