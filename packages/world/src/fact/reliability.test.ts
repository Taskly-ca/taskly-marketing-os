import { describe, it, expect } from 'vitest';
import {
  WEAK_PRIOR,
  DEFAULT_CREDIBLE_MASS,
  UNRATED_SOURCE_RELIABILITY,
  updateReliability,
  posteriorMean,
  credibleInterval,
  reliabilityScore,
  rootsOf,
  collapseCopyChains,
  corroborationScore,
} from './reliability.js';
import type { DerivesEdge, SourceClaim } from './reliability.js';

describe('Beta-Bernoulli posterior', () => {
  it('adds observations to the prior', () => {
    const p = updateReliability(WEAK_PRIOR, { correct: 7, incorrect: 3 });
    expect(p).toEqual({ alpha: 8, beta: 4 });
  });

  it('accumulates across updates the same way as one batch', () => {
    const stepwise = updateReliability(
      updateReliability(WEAK_PRIOR, { correct: 3, incorrect: 1 }),
      { correct: 4, incorrect: 2 },
    );
    expect(stepwise).toEqual(updateReliability(WEAK_PRIOR, { correct: 7, incorrect: 3 }));
  });

  it('refuses negative or non-finite counts', () => {
    expect(() => updateReliability(WEAK_PRIOR, { correct: -1, incorrect: 0 })).toThrow(/negative/);
    expect(() => updateReliability(WEAK_PRIOR, { correct: NaN, incorrect: 0 })).toThrow();
  });

  it('reproduces the closed form for the uniform prior', () => {
    // Beta(1,1) is uniform, so its CDF is the identity and its quantiles are p.
    const ci = credibleInterval(WEAK_PRIOR, 0.9);
    expect(ci.lo).toBeCloseTo(0.05, 4);
    expect(ci.hi).toBeCloseTo(0.95, 4);
    expect(posteriorMean(WEAK_PRIOR)).toBeCloseTo(0.5, 10);
  });

  it('narrows the interval as evidence accumulates', () => {
    const thin = credibleInterval(updateReliability(WEAK_PRIOR, { correct: 9, incorrect: 1 }));
    const thick = credibleInterval(updateReliability(WEAK_PRIOR, { correct: 900, incorrect: 100 }));
    expect(thick.hi - thick.lo).toBeLessThan(thin.hi - thin.lo);
    expect(thin.lo).toBeLessThan(
      posteriorMean(updateReliability(WEAK_PRIOR, { correct: 9, incorrect: 1 })),
    );
  });
});

describe('reliabilityScore uses the LOWER credible bound — the whole point', () => {
  const novice = updateReliability(WEAK_PRIOR, { correct: 1, incorrect: 0 });
  const veteran = updateReliability(WEAK_PRIOR, { correct: 190, incorrect: 10 });

  it('a 1/1 source does NOT outrank a 190/200 source', () => {
    expect(reliabilityScore(novice)).toBeLessThan(reliabilityScore(veteran));
  });

  it('the naive alternatives rank them wrongly — which is why we use neither', () => {
    // Raw success rate: 1/1 is "100% reliable" and beats 190/200 outright.
    expect(1 / 1).toBeGreaterThan(190 / 200);
    // The posterior mean shrinks that one, but a short perfect run still wins:
    // 20/20 ⇒ 0.955 against the veteran's 0.946. The lower bound does not.
    const shortPerfect = updateReliability(WEAK_PRIOR, { correct: 20, incorrect: 0 });
    expect(posteriorMean(shortPerfect)).toBeGreaterThan(posteriorMean(veteran));
    expect(reliabilityScore(shortPerfect)).toBeLessThan(reliabilityScore(veteran));
  });

  it('pins the numbers quoted in the module comment', () => {
    // Documented constants are load-bearing: a comment nobody checks is a lie
    // waiting to happen. These are the values the header claims.
    const at = (correct: number, incorrect: number): number =>
      reliabilityScore(updateReliability(WEAK_PRIOR, { correct, incorrect }));
    expect(at(1, 0)).toBeCloseTo(0.22, 2);
    expect(at(20, 0)).toBeCloseTo(0.87, 2);
    expect(at(190, 10)).toBeCloseTo(0.92, 2);
  });

  it('stays inside [0,1] and rises with corroborated evidence', () => {
    const s1 = reliabilityScore(updateReliability(WEAK_PRIOR, { correct: 5, incorrect: 0 }));
    const s2 = reliabilityScore(updateReliability(WEAK_PRIOR, { correct: 50, incorrect: 0 }));
    expect(s1).toBeGreaterThanOrEqual(0);
    expect(s2).toBeLessThanOrEqual(1);
    expect(s2).toBeGreaterThan(s1);
  });

  it('punishes a source that has been refuted', () => {
    const wrong = updateReliability(WEAK_PRIOR, { correct: 20, incorrect: 80 });
    const right = updateReliability(WEAK_PRIOR, { correct: 80, incorrect: 20 });
    expect(reliabilityScore(wrong)).toBeLessThan(reliabilityScore(right));
    expect(DEFAULT_CREDIBLE_MASS).toBeGreaterThan(0.5);
  });
});

/* ── copy chains ─────────────────────────────────────────────────────────── */

const claim = (sourceId: string, observedAt = '2026-08-04T00:00:00.000Z'): SourceClaim => ({
  sourceId,
  observedAt,
});

describe('copy-chain collapse', () => {
  it('ten outlets republishing one press release count as ONE', () => {
    const outlets = Array.from({ length: 10 }, (_, i) => `outlet_${i}`);
    const edges: DerivesEdge[] = outlets.map((o) => ({ sourceId: o, derivesFrom: 'pr_wire' }));
    const claims = [claim('pr_wire'), ...outlets.map((o) => claim(o))];

    const collapsed = collapseCopyChains(claims, edges);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.roots).toEqual(['pr_wire']);
    expect(collapsed[0]!.absorbed).toHaveLength(11);
    // The originator, not whichever outlet happened to be crawled first.
    expect(collapsed[0]!.representative.sourceId).toBe('pr_wire');

    expect(corroborationScore(claims, edges, () => 0.8).independentRoots).toBe(1);
  });

  it('follows a chain of arbitrary depth', () => {
    const edges: DerivesEdge[] = Array.from({ length: 8 }, (_, i) => ({
      sourceId: `s${i + 1}`,
      derivesFrom: `s${i}`,
    }));
    expect(rootsOf('s8', edges)).toEqual(['s0']);
    expect(collapseCopyChains([claim('s8'), claim('s3')], edges)).toHaveLength(1);
  });

  it('collapses a diamond — two paths to the same root', () => {
    const edges: DerivesEdge[] = [
      { sourceId: 'd', derivesFrom: 'b' },
      { sourceId: 'd', derivesFrom: 'c' },
      { sourceId: 'b', derivesFrom: 'a' },
      { sourceId: 'c', derivesFrom: 'a' },
    ];
    expect(rootsOf('d', edges)).toEqual(['a']);
    expect(collapseCopyChains([claim('d'), claim('b'), claim('c')], edges)).toHaveLength(1);
  });

  it('TERMINATES on a cycle and collapses it to one deterministic root', () => {
    // A cites B cites A. A naive walk loops forever; this is the load-bearing case.
    const edges: DerivesEdge[] = [
      { sourceId: 'b_news', derivesFrom: 'a_news' },
      { sourceId: 'a_news', derivesFrom: 'b_news' },
    ];
    expect(rootsOf('a_news', edges)).toEqual(['a_news']);
    expect(rootsOf('b_news', edges)).toEqual(['a_news']);
    const collapsed = collapseCopyChains([claim('a_news'), claim('b_news')], edges);
    expect(collapsed).toHaveLength(1);
  });

  it('TERMINATES on a self-loop', () => {
    expect(rootsOf('x', [{ sourceId: 'x', derivesFrom: 'x' }])).toEqual(['x']);
  });

  it('escapes a cycle when one member has a real upstream', () => {
    const edges: DerivesEdge[] = [
      { sourceId: 'a', derivesFrom: 'b' },
      { sourceId: 'b', derivesFrom: 'a' },
      { sourceId: 'b', derivesFrom: 'root' },
    ];
    expect(rootsOf('a', edges)).toEqual(['root']);
  });

  it('keeps genuinely independent sources apart', () => {
    const claims = [claim('a'), claim('b'), claim('c')];
    expect(collapseCopyChains(claims, [])).toHaveLength(3);
    expect(corroborationScore(claims, []).independentRoots).toBe(3);
  });

  it('dedupes the same source claiming twice', () => {
    const collapsed = collapseCopyChains([claim('a'), claim('a', '2026-08-05T00:00:00.000Z')], []);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.absorbed).toEqual(['a']);
  });
});

describe('corroborationScore', () => {
  const rel = (table: Record<string, number>) => (id: string) => table[id] ?? 0.5;

  it('ten copies of one claim score exactly as much as the original alone', () => {
    // Naive counting is how one fabricated claim becomes "widely reported".
    const outlets = Array.from({ length: 10 }, (_, i) => `outlet_${i}`);
    const edges: DerivesEdge[] = outlets.map((o) => ({ sourceId: o, derivesFrom: 'pr_wire' }));
    const many = corroborationScore(
      [claim('pr_wire'), ...outlets.map((o) => claim(o))],
      edges,
      () => 0.8,
    );
    const one = corroborationScore([claim('pr_wire')], [], () => 0.8);
    expect(many.score).toBeCloseTo(one.score, 12);
    expect(many.score).toBeCloseTo(0.8, 12);
  });

  it('rewards genuinely independent roots, sub-additively', () => {
    const two = corroborationScore([claim('a'), claim('b')], [], () => 0.6);
    expect(two.independentRoots).toBe(2);
    expect(two.score).toBeCloseTo(1 - 0.4 * 0.4, 12); // 0.84 — not 1.2
    expect(two.score).toBeLessThan(1);
  });

  it('weighs each root by its own reliability', () => {
    const strong = corroborationScore([claim('a')], [], rel({ a: 0.95 }));
    const weak = corroborationScore([claim('a')], [], rel({ a: 0.15 }));
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it('gives an unrated source almost no corroborative weight', () => {
    const unrated = corroborationScore([claim('nobody_checked')], []);
    expect(unrated.score).toBeCloseTo(UNRATED_SOURCE_RELIABILITY, 12);
    expect(unrated.score).toBeLessThan(0.2);
  });

  it('scores an empty claim set at zero', () => {
    const none = corroborationScore([], []);
    expect(none.independentRoots).toBe(0);
    expect(none.score).toBe(0);
  });
});
