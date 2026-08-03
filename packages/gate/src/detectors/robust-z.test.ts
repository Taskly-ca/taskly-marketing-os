import { describe, it, expect } from 'vitest';
import {
  MAD_SCALE,
  ROBUST_Z_THRESHOLD,
  mad,
  median,
  normalTwoSidedP,
  robustScale,
  robustZDetector,
  robustZScore,
  weekdayRobustZDetector,
} from './robust-z.js';
import type { Observation } from './types.js';

/** 2026-01-01 is a Thursday, so day(i) has UTC weekday (4 + i) % 7. */
const day = (i: number): string => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);

const series = (values: readonly number[]): Observation[] =>
  values.map((value, i) => ({ at: day(i), value }));

const at = (i: number, value: number): Observation => ({ at: day(i), value });

/** What a naive mean/σ detector would have said. Present so the robust tests
 *  prove a difference rather than merely asserting a number. */
function classicalZ(value: number, xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return (value - mean) / Math.sqrt(variance);
}

describe('robust-z / summary statistics', () => {
  it('computes medians for odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('computes the MAD and is unmoved by a single wild point', () => {
    expect(mad([1, 2, 3, 4, 5])).toBe(1);
    expect(mad([1, 2, 3, 4, 5_000_000])).toBe(1);
  });

  it('reports which scale estimator it used', () => {
    expect(robustScale([8, 12, 9, 11, 10]).kind).toBe('mad');
    // MAD collapses (majority identical) but a mean absolute deviation survives.
    expect(robustScale([10, 10, 10, 10, 10, 10, 10, 12]).kind).toBe('mean-ad');
    // Perfectly constant: no dispersion estimate exists at all.
    expect(robustScale([10, 10, 10, 10]).kind).toBe('none');
  });

  it('gives a two-sided normal p-value consistent with the 3.5 cutoff', () => {
    expect(normalTwoSidedP(0)).toBeCloseTo(1, 6);
    expect(normalTwoSidedP(1.959964)).toBeCloseTo(0.05, 4);
    expect(normalTwoSidedP(ROBUST_Z_THRESHOLD)).toBeLessThan(1e-3);
    expect(normalTwoSidedP(ROBUST_Z_THRESHOLD)).toBeGreaterThan(1e-4);
    expect(normalTwoSidedP(-4)).toBe(normalTwoSidedP(4));
  });
});

describe('robust-z detector', () => {
  it('abstains rather than guessing when history is shorter than minHistory', () => {
    const history = series([10, 12, 9, 11, 10]);
    const d = robustZDetector.run({ current: at(5, 90), history });
    expect(history.length).toBeLessThan(robustZDetector.minHistory);
    expect(d.fired).toBe(false);
    expect(d.pValue).toBeNull();
    expect(d.score).toBe(0);
    expect(d.detail).toMatch(/histor/i);
  });

  it('survives a contaminating outlier that blinds a mean/σ detector', () => {
    // One 150 in an otherwise ~10 series inflates σ to ~37 and hides everything.
    const values = [8, 12, 9, 11, 10, 13, 7, 10, 12, 9, 11, 8, 10, 150];
    const history = series(values);
    const d = robustZDetector.run({ current: at(14, 25), history });

    expect(Math.abs(classicalZ(25, values))).toBeLessThan(1);
    expect(d.fired).toBe(true);
    expect(d.score).toBeGreaterThan(ROBUST_Z_THRESHOLD);
    expect(d.pValue).not.toBeNull();
    expect(d.pValue!).toBeLessThan(1e-6);
  });

  it('does not fire on an ordinary value in the same contaminated series', () => {
    const values = [8, 12, 9, 11, 10, 13, 7, 10, 12, 9, 11, 8, 10, 150];
    const d = robustZDetector.run({ current: at(14, 11), history: series(values) });
    expect(d.fired).toBe(false);
    expect(Math.abs(d.score)).toBeLessThan(ROBUST_Z_THRESHOLD);
  });

  it('detects a drop with a negative score', () => {
    const values = [40, 42, 39, 41, 40, 38, 41, 40, 42, 39, 40, 41, 39, 40];
    const d = robustZDetector.run({ current: at(14, 5), history: series(values) });
    expect(d.fired).toBe(true);
    expect(d.score).toBeLessThan(-ROBUST_Z_THRESHOLD);
  });

  it('abstains on a perfectly constant series instead of dividing by zero', () => {
    const history = series(Array.from({ length: 14 }, () => 10));
    const d = robustZDetector.run({ current: at(14, 500), history });
    expect(d.fired).toBe(false);
    expect(d.pValue).toBeNull();
    expect(Number.isFinite(d.score)).toBe(true);
    expect(d.score).toBe(0);
    expect(d.detail).toMatch(/dispersion/i);
  });

  it('falls back to the scaled mean absolute deviation when the MAD is zero', () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 12, 10, 10];
    const d = robustZDetector.run({ current: at(14, 20), history: series(values) });
    expect(robustScale(values).kind).toBe('mean-ad');
    expect(d.fired).toBe(true);
    expect(d.detail).toMatch(/mean-ad/);
  });

  it('exposes the scale it used so callers can audit a firing', () => {
    const z = robustZScore(25, [8, 12, 9, 11, 10, 13, 7, 10, 12, 9, 11, 8, 10, 150]);
    expect(z).not.toBeNull();
    expect(z!.center).toBe(10);
    expect(z!.scale).toBeCloseTo(1.5 * MAD_SCALE, 6);
    expect(z!.kind).toBe('mad');
  });
});

describe('same-weekday robust-z', () => {
  // Nine weeks where Sunday runs at ~5 and every other day at ~40 — ordinary
  // weekly seasonality, the single most common false-positive source.
  const seasonal = Array.from({ length: 66 }, (_, i) => {
    const weekday = (4 + i) % 7;
    return { at: day(i), value: weekday === 0 ? 5 + (i % 3) - 1 : 40 + (i % 5) - 2 };
  });
  // day(66) is a Sunday.
  const sundayIndex = 66;

  it('day(66) really is a Sunday', () => {
    expect(new Date(`${day(sundayIndex)}T00:00:00Z`).getUTCDay()).toBe(0);
  });

  it('suppresses the weekly-seasonality false positive the flat baseline fires on', () => {
    const current = at(sundayIndex, 5); // a perfectly normal Sunday
    expect(robustZDetector.run({ current, history: seasonal }).fired).toBe(true);

    const weekday = weekdayRobustZDetector.run({ current, history: seasonal });
    expect(weekday.fired).toBe(false);
    expect(weekday.detail).toMatch(/weekday/i);
  });

  it('catches a real Sunday spike that the flat baseline calls normal', () => {
    const current = at(sundayIndex, 40); // a weekday-sized Sunday
    expect(robustZDetector.run({ current, history: seasonal }).fired).toBe(false);

    const weekday = weekdayRobustZDetector.run({ current, history: seasonal });
    expect(weekday.fired).toBe(true);
    expect(weekday.score).toBeGreaterThan(ROBUST_Z_THRESHOLD);
  });

  it('abstains below four weeks of history — it cannot fit a weekday baseline', () => {
    const history = seasonal.slice(0, 20);
    const d = weekdayRobustZDetector.run({ current: at(20, 40), history });
    expect(d.fired).toBe(false);
    expect(d.pValue).toBeNull();
    expect(d.detail).toMatch(/histor/i);
  });

  it('abstains when the date cannot be parsed', () => {
    const d = weekdayRobustZDetector.run({
      current: { at: 'not-a-date', value: 40 },
      history: seasonal,
    });
    expect(d.fired).toBe(false);
    expect(d.detail).toMatch(/date/i);
  });
});
