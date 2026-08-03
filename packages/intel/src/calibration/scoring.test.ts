import { describe, it, expect } from 'vitest';
import { brier, logScore, baselineScore, peerScore, decompose, meanBrier } from './scoring.js';
import { fitPlatt, applyPlatt, MIN_FIT_SAMPLES, identityModel } from './platt.js';

describe('proper scoring rules', () => {
  it('brier rewards confident correctness and punishes confident error', () => {
    expect(brier({ p: 0.9, outcome: 1 })).toBeCloseTo(0.01, 5);
    expect(brier({ p: 0.1, outcome: 1 })).toBeCloseTo(0.81, 5);
    expect(brier({ p: 0.5, outcome: 1 })).toBeCloseTo(0.25, 5);
  });

  it('log score punishes confident wrongness far harder than brier does', () => {
    const confidentWrong = logScore({ p: 0.02, outcome: 1 });
    const unsureWrong = logScore({ p: 0.45, outcome: 1 });
    expect(confidentWrong).toBeGreaterThan(unsureWrong * 4);
  });

  it('clamps so a 0/1 forecast never yields an infinite score', () => {
    expect(Number.isFinite(logScore({ p: 0, outcome: 1 }))).toBe(true);
    expect(Number.isFinite(logScore({ p: 1, outcome: 0 }))).toBe(true);
  });

  it('baseline is 0 at a coin flip, positive when better than chance', () => {
    expect(baselineScore({ p: 0.5, outcome: 1 })).toBeCloseTo(0, 6);
    expect(baselineScore({ p: 0.8, outcome: 1 })).toBeGreaterThan(0);
    expect(baselineScore({ p: 0.2, outcome: 1 })).toBeLessThan(0);
  });

  it('peer score is null with no peers and positive when beating them', () => {
    expect(peerScore({ p: 0.8, outcome: 1 }, [])).toBeNull();
    expect(peerScore({ p: 0.8, outcome: 1 }, [{ p: 0.5, outcome: 1 }])!).toBeGreaterThan(0);
  });
});

describe('Murphy decomposition — the diagnostic that matters', () => {
  it('identifies OVERCONFIDENCE as poor reliability', () => {
    // Always says 0.95; only half happen.
    const fs = Array.from({ length: 100 }, (_, i) => ({ p: 0.95, outcome: (i % 2) as 0 | 1 }));
    const d = decompose(fs);
    expect(d.reliability).toBeGreaterThan(0.15);
    expect(d.resolution).toBeCloseTo(0, 3); // never discriminates
  });

  it('identifies the startup failure mode: honest but useless (low resolution)', () => {
    const fs = Array.from({ length: 100 }, (_, i) => ({ p: 0.5, outcome: (i % 2) as 0 | 1 }));
    const d = decompose(fs);
    expect(d.reliability).toBeCloseTo(0, 3); // perfectly calibrated…
    expect(d.resolution).toBeCloseTo(0, 3); // …and carries no information
    expect(d.skill).toBeCloseTo(0, 3);
  });

  it('rewards a genuinely skilled forecaster with positive skill', () => {
    const fs = [
      ...Array.from({ length: 50 }, () => ({ p: 0.9, outcome: 1 as const })),
      ...Array.from({ length: 50 }, () => ({ p: 0.1, outcome: 0 as const })),
    ];
    const d = decompose(fs);
    expect(d.skill).toBeGreaterThan(0.8);
    expect(meanBrier(fs)).toBeLessThan(0.02);
  });

  it('satisfies the identity brier = reliability − resolution + uncertainty', () => {
    const fs = Array.from({ length: 200 }, (_, i) => ({
      p: [0.1, 0.35, 0.6, 0.85][i % 4]!,
      outcome: (i % 3 === 0 ? 1 : 0) as 0 | 1,
    }));
    const d = decompose(fs);
    expect(d.reliability - d.resolution + d.uncertainty).toBeCloseTo(d.brier, 6);
  });
});

describe('Platt scaling', () => {
  it('refuses to fit below the sample floor — identity, not a fake curve', () => {
    const few = Array.from({ length: MIN_FIT_SAMPLES - 1 }, (_, i) => ({
      p: 0.9,
      outcome: (i % 2) as 0 | 1,
    }));
    const m = fitPlatt(few);
    expect(m).toEqual(identityModel(MIN_FIT_SAMPLES - 1));
    expect(applyPlatt(m, 0.9)).toBeCloseTo(0.9, 6);
  });

  it('refuses to fit when every outcome is the same class', () => {
    const oneClass = Array.from({ length: 150 }, () => ({ p: 0.7, outcome: 1 as const }));
    expect(fitPlatt(oneClass).a).toBe(1);
  });

  it('pulls a systematically overconfident forecaster back toward reality', () => {
    // Says 0.9 but is right only ~60% of the time.
    const fs = Array.from({ length: 300 }, (_, i) => ({
      p: 0.9,
      outcome: (i % 10 < 6 ? 1 : 0) as 0 | 1,
    }));
    const model = fitPlatt(fs);
    const corrected = applyPlatt(model, 0.9);
    expect(corrected).toBeLessThan(0.9);
    expect(corrected).toBeGreaterThan(0.4);
  });
});
