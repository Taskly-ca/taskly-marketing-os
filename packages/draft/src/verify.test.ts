/**
 * The gate on a recommendation.
 *
 * A marketing recommendation is the highest-leverage place in this system for
 * an unsupported claim to escape: it is the output a human acts on, and the one
 * least likely to be checked back against a source.
 */
import { describe, expect, it } from 'vitest';

import { basisForEvidence, stripEvidenceRefs, verifyRecommendations } from './verify.js';
import type { Evidence } from './types.js';

const ev = (id: number, kind: Evidence['kind']): Evidence => ({
  id, kind, text: `evidence ${id}`, source: 'https://example.com',
});
const observed = [ev(1, 'finding'), ev(2, 'fact')];
const ours = [ev(3, 'season'), ev(4, 'brain'), ev(5, 'forecast')];
const all = [...observed, ...ours];

const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'Open Tasker recruiting for snow removal in Scarborough',
  reasoning: 'The window opens before supply exists',
  falsifier: 'Fewer than 10 approved snow Taskers by 1 November',
  evidence: [1],
  horizon: '8 weeks',
  ...over,
});

describe('basisForEvidence', () => {
  it('needs something observed in the world to exceed exploratory', () => {
    expect(basisForEvidence(observed)).toBe('inferred_from_sources');
    expect(basisForEvidence([ev(1, 'fact')])).toBe('inferred_from_sources');
  });

  it('rates our own calendar and our own documents as exploratory', () => {
    // Sensible-sounding and entirely self-referential. Nothing outside the
    // company was consulted, so nothing outside the company supports it.
    expect(basisForEvidence(ours)).toBe('exploratory_unverified');
  });

  it('can never reach verified_metric — a "should" is not a measurement', () => {
    expect(basisForEvidence(all)).not.toBe('verified_metric');
  });
});

describe('verifyRecommendations', () => {
  it('keeps a well-formed recommendation and derives its basis', () => {
    const r = verifyRecommendations([rec()], all);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]?.basis).toBe('inferred_from_sources');
    expect(r.kept[0]?.evidence).toEqual([1]);
  });

  it('drops one with no falsifier — a proposal nobody can be wrong about', () => {
    const r = verifyRecommendations([rec({ falsifier: '  ' })], all);
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/falsifier/);
  });

  it('drops one citing no evidence', () => {
    const r = verifyRecommendations([rec({ evidence: [] })], all);
    expect(r.dropped[0]?.why).toBe('no evidence cited');
  });

  it('drops one citing an evidence number that does not exist', () => {
    // An out-of-range index is the unambiguous signal that the support was
    // invented rather than used.
    const r = verifyRecommendations([rec({ evidence: [99] })], all);
    expect(r.dropped[0]?.why).toMatch(/does not exist/);
  });

  it('drops causal language, because nothing here has a control group', () => {
    const r = verifyRecommendations(
      [rec({ reasoning: 'Their price cut caused our bookings to fall' })],
      all,
    );
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/causal/);
  });

  it('drops a banned trust claim even in an internal draft', () => {
    // Where a phrase like this enters a campaign two weeks later, with nobody
    // remembering it was never checked.
    const r = verifyRecommendations(
      [rec({ action: 'Promote that all our taskers are background-checked' })],
      all,
    );
    expect(r.dropped[0]?.why).toMatch(/honesty gate/);
  });

  it('ranks observed-world proposals above self-referential ones', () => {
    const r = verifyRecommendations(
      [rec({ action: 'A', evidence: [3] }), rec({ action: 'B', evidence: [1] })],
      all,
    );
    expect(r.kept[0]?.action).toBe('B');
  });

  it('deduplicates a repeated evidence id rather than double-counting it', () => {
    const r = verifyRecommendations([rec({ evidence: [1, 1, 1] })], all);
    expect(r.kept[0]?.evidence).toEqual([1]);
  });
});

describe('figures must be carried by the evidence cited', () => {
  const priced: Evidence[] = [
    { id: 1, kind: 'fact', text: 'TaskRabbit offers snow removal', source: 'https://t.com' },
    { id: 2, kind: 'brain', text: 'Snow: single driveway $49, double $69, full property $95', source: 'pricing.md' },
  ];

  it('drops a recommendation whose prices are in the file but not in what it cites', () => {
    // The exact first-live-draft failure: real numbers, real evidence, wrong
    // citation — and invisible to a reader who follows the links.
    const r = verifyRecommendations(
      [rec({ action: 'List snow removal at $49, $69 and $95', evidence: [1] })],
      priced,
    );
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/49/);
  });

  it('keeps it once the evidence carrying the prices is cited', () => {
    const r = verifyRecommendations(
      [rec({ action: 'List snow removal at $49, $69 and $95', evidence: [1, 2] })],
      priced,
    );
    expect(r.kept).toHaveLength(1);
  });

  it('lets a falsifier propose a threshold it cannot source', () => {
    // "Wrong if bookings stay under 5%" sets a target; it asserts nothing.
    // Demanding a citation would stop the model setting thresholds at all.
    const r = verifyRecommendations(
      [rec({ action: 'List snow removal', evidence: [1], falsifier: 'Below 5% of bookings by 2026-12-15' })],
      priced,
    );
    expect(r.kept).toHaveLength(1);
  });
});

describe('stripEvidenceRefs — the check that nearly ate every draft', () => {
  it('removes inline citation markers', () => {
    expect(stripEvidenceRefs('demand is open (22) and moves start (24)')).not.toMatch(/22|24/);
    expect(stripEvidenceRefs('per the plan (evidence 44, 46)')).not.toMatch(/44|46/);
  });

  it('removes square-bracket markers — the form the evidence file itself uses', () => {
    // The file numbers entries as [22], so this is the shape the model copies
    // most often. Handling only parentheses dropped a good recommendation.
    expect(stripEvidenceRefs('demand is open [22] and moves start [24]')).not.toMatch(/22|24/);
    expect(stripEvidenceRefs('per the plan [44, 46]')).not.toMatch(/44|46/);
  });

  it('keeps a figure that merely happens to be in brackets', () => {
    // "(a 20% lift)" is a claim wearing brackets, not a reference.
    expect(stripEvidenceRefs('we expect (a 20% lift)')).toMatch(/20/);
  });

  it('does not fuse a citation list into one invented number', () => {
    // "(44,46)" became "4446" when commas were stripped globally — a figure
    // that appears nowhere, reported as an invented claim.
    const r = verifyRecommendations(
      [rec({ reasoning: 'the plan calls for this (44,46)', evidence: [1] })],
      [ev(1, 'fact')],
    );
    expect(r.kept).toHaveLength(1);
  });

  it('still treats a real thousands-separated number as a figure', () => {
    const r = verifyRecommendations(
      [rec({ action: 'Target 1,200 taskers', evidence: [1] })],
      [ev(1, 'fact')],
    );
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/1200/);
  });
});
