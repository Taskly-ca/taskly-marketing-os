import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HYSTERESIS,
  DEFAULT_Q,
  PERSISTENCE_2_OF_3,
  benjaminiHochberg,
  hysteresisRun,
  hysteresisStep,
  passesPersistence,
} from './fdr.js';
import type { Detection } from './types.js';

const fired = (pValue: number | null, detector = 'test'): Detection => ({
  detector,
  fired: true,
  pValue,
  score: 4,
  detail: 'synthetic',
});

const quiet = (pValue: number | null): Detection => ({
  detector: 'test',
  fired: false,
  pValue,
  score: 0,
  detail: 'synthetic',
});

/** Deterministic LCG — the panel tests must not flake. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('Benjamini–Hochberg', () => {
  // Benjamini & Hochberg 1995, the Needleman et al. p-values. The published
  // answer is 4 rejections at q = 0.05 (Bonferroni would find 3).
  const BH_1995 = [
    0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.324, 0.4262, 0.5719,
    0.6528, 0.759, 1.0,
  ];

  it('reproduces the published 1995 worked example', () => {
    const r = benjaminiHochberg(
      BH_1995.map((p) => fired(p)),
      0.05,
    );
    expect(r.tested).toBe(15);
    expect(r.threshold).toBeCloseTo(0.0095, 12);
    expect(r.survivors.length).toBe(4);
    expect(r.survivors.map((d) => d.pValue)).toEqual([0.0001, 0.0004, 0.0019, 0.0095]);
  });

  it('is a step-UP procedure — it rejects everything below the largest passing rank', () => {
    // 0.11 fails its own rank-2 threshold but sits below the rank-5 cutoff, so
    // the step-up procedure must still reject it. A naive per-rank scan would not.
    const ps = [0.01, 0.11, 0.12, 0.15, 0.2, 0.9, 0.9, 0.9, 0.9, 0.9];
    const r = benjaminiHochberg(
      ps.map((p) => fired(p)),
      0.5,
    );
    expect(r.threshold).toBeCloseTo(0.2, 12);
    expect(r.survivors.length).toBe(5);
    expect(r.survivors.map((d) => d.pValue)).toContain(0.11);
  });

  it('rejects everything when nothing clears the cutoff', () => {
    const r = benjaminiHochberg([fired(0.4), fired(0.6), fired(0.9)], 0.05);
    expect(r.threshold).toBeNull();
    expect(r.survivors).toEqual([]);
    expect(r.decisions.every((d) => d.outcome === 'rejected')).toBe(true);
  });

  it('passes NULL p-values through unchanged — they are not statistical tests', () => {
    const drift = fired(null, 'ewma');
    const r = benjaminiHochberg([drift, fired(0.4), fired(0.6), fired(0.9)], 0.05);
    expect(r.tested).toBe(3); // the null does not enlarge the family
    expect(r.survivors).toEqual([drift]);
    expect(r.decisions[0]!.outcome).toBe('passthrough');
  });

  it('counts non-fired detections in the family but never promotes them', () => {
    const r = benjaminiHochberg([quiet(0.0001), fired(0.0002)], 0.05);
    expect(r.tested).toBe(2); // conditioning the family on "fired" would bias it
    expect(r.survivors.length).toBe(1);
    expect(r.survivors[0]!.pValue).toBe(0.0002);
    expect(r.decisions[0]!.outcome).toBe('not-fired');
  });

  it('is fail-closed on a malformed p-value', () => {
    const r = benjaminiHochberg([fired(Number.NaN), fired(-1), fired(2), fired(0.0001)], 0.05);
    expect(r.survivors.length).toBe(1);
    expect(r.survivors[0]!.pValue).toBe(0.0001);
  });

  it('rejects a nonsensical q', () => {
    expect(() => benjaminiHochberg([fired(0.01)], 0)).toThrow(RangeError);
    expect(() => benjaminiHochberg([fired(0.01)], 1.5)).toThrow(RangeError);
  });

  it('handles an empty panel', () => {
    const r = benjaminiHochberg([], DEFAULT_Q);
    expect(r.tested).toBe(0);
    expect(r.threshold).toBeNull();
    expect(r.survivors).toEqual([]);
  });

  it('controls the false-discovery rate on a synthetic daily panel', () => {
    // 200 days. Each day: 190 null entities (p ~ U(0,1)) and 10 real movers.
    // This is the shape of the real problem — N detectors x M entities, daily.
    const PANELS = 200;
    const NULLS = 190;
    const SIGNALS = 10;
    const q = 0.1;
    const rng = makeRng(20260803);

    let bhFdp = 0;
    let bhPower = 0;
    let naiveFdp = 0;
    let naiveFalseCount = 0;

    for (let panel = 0; panel < PANELS; panel++) {
      const nulls = Array.from({ length: NULLS }, () => fired(rng(), 'null'));
      const signals = Array.from({ length: SIGNALS }, () => fired(1e-6 * rng(), 'signal'));
      const r = benjaminiHochberg([...nulls, ...signals], q);

      const falseDiscoveries = r.survivors.filter((d) => d.detector === 'null').length;
      bhFdp += r.survivors.length === 0 ? 0 : falseDiscoveries / r.survivors.length;
      bhPower += r.survivors.filter((d) => d.detector === 'signal').length / SIGNALS;

      // What shipping every detector's own alpha = 0.05 uncorrected would give.
      const naiveFalse = nulls.filter((d) => (d.pValue ?? 1) <= 0.05).length;
      naiveFalseCount += naiveFalse;
      naiveFdp += naiveFalse / (naiveFalse + SIGNALS);
    }

    // The BH guarantee is on the EXPECTED false-discovery proportion; the bound
    // here is (m0/m) * q = 0.095, and 1.5x that is generous slack for 200 draws.
    expect(bhFdp / PANELS).toBeLessThan(q * 1.5);
    // ...and it must not buy that by refusing to detect anything.
    expect(bhPower / PANELS).toBeGreaterThan(0.99);
    // Uncorrected, roughly half of every day's alert list would be noise.
    expect(naiveFdp / PANELS).toBeGreaterThan(0.4);
    expect(bhFdp / PANELS).toBeLessThan(naiveFdp / PANELS / 3);
    expect(naiveFalseCount / PANELS).toBeGreaterThan(5);
  });
});

describe('persistence (2-of-3)', () => {
  it('uses a 2-of-3 rule by default', () => {
    expect(PERSISTENCE_2_OF_3).toEqual({ of: 3, need: 2 });
  });

  it('rejects a one-off spike', () => {
    expect(passesPersistence([false, false, true])).toBe(false);
    expect(passesPersistence([true, false, false])).toBe(false);
    expect(passesPersistence([false, true, false])).toBe(false);
  });

  it('accepts a sustained signal', () => {
    expect(passesPersistence([false, true, true])).toBe(true);
    expect(passesPersistence([true, false, true])).toBe(true);
    expect(passesPersistence([true, true, false])).toBe(true);
    expect(passesPersistence([true, true, true])).toBe(true);
  });

  it('only looks at the last three windows', () => {
    expect(passesPersistence([true, true, true, false, false, true])).toBe(false);
    expect(passesPersistence([false, false, false, true, false, true])).toBe(true);
  });

  it('cannot promote before enough windows exist', () => {
    expect(passesPersistence([])).toBe(false);
    expect(passesPersistence([true])).toBe(false);
    expect(passesPersistence([true, true])).toBe(true);
  });

  it('supports a stricter rule', () => {
    expect(passesPersistence([true, true, false, true], { of: 4, need: 3 })).toBe(true);
    expect(passesPersistence([true, false, false, true], { of: 4, need: 3 })).toBe(false);
    expect(() => passesPersistence([true], { of: 2, need: 3 })).toThrow(RangeError);
  });
});

describe('hysteresis', () => {
  it('defaults to a fire band strictly above the clear band', () => {
    expect(DEFAULT_HYSTERESIS.fireAt).toBeGreaterThan(DEFAULT_HYSTERESIS.clearAt);
  });

  it('stops a signal oscillating at the boundary from re-firing', () => {
    const flapping = [1.05, 0.95, 1.02, 0.9, 1.1];
    const risingEdges = (states: readonly boolean[]): number =>
      states.filter((s, i) => s && !(states[i - 1] ?? false)).length;

    // A bare threshold at 1.0 re-fires three separate times on the same episode.
    expect(risingEdges(flapping.map((s) => s >= 1))).toBe(3);
    // With hysteresis it is one episode, which is what it actually is.
    expect(risingEdges(hysteresisRun(flapping))).toBe(1);
    expect(hysteresisRun(flapping)).toEqual([true, true, true, true, true]);
  });

  it('does clear once the signal genuinely falls below the clear threshold', () => {
    expect(hysteresisRun([1.05, 0.95, 0.5, 0.9, 1.05])).toEqual([true, true, false, false, true]);
  });

  it('needs the full fire threshold to start, not the clear threshold', () => {
    expect(hysteresisStep(0.8, false)).toBe(false);
    expect(hysteresisStep(0.8, true)).toBe(true);
    expect(hysteresisStep(1.0, false)).toBe(true);
    expect(hysteresisStep(0.5, true)).toBe(false);
  });

  it('works on signed scores by magnitude — a drop is as real as a spike', () => {
    expect(hysteresisStep(-1.4, false)).toBe(true);
    expect(hysteresisStep(-0.7, true)).toBe(true);
    expect(hysteresisStep(-0.3, true)).toBe(false);
  });

  it('refuses a band with no gap — that is just a threshold wearing a hat', () => {
    expect(() => hysteresisStep(1, false, { fireAt: 1, clearAt: 1 })).toThrow(RangeError);
    expect(() => hysteresisStep(1, false, { fireAt: 1, clearAt: 1.2 })).toThrow(RangeError);
  });

  it('treats a non-finite score as inactive rather than latching forever', () => {
    expect(hysteresisStep(Number.NaN, true)).toBe(false);
  });
});
