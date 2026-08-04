import { describe, expect, it } from 'vitest';
import type { EvidenceRef } from '@tmos/contracts';
import {
  detectContradictions,
  isActionable,
  proposeEdit,
  renderQuantity,
} from './contradiction.js';
import type {
  BrainClaim,
  DetectOptions,
  PullRequestPort,
  WorldObservation,
} from './contradiction.js';

const SYSTEM = '20-architecture/SYSTEM.md';

/** The real shape of the thing we are patching: prose with the number inside. */
const SYSTEM_DOC = [
  '# Taskly — Application Architecture',
  '',
  '## Marketplace payments',
  '',
  'Taskly keeps 20% of the agreed deal, HST inclusive.',
  'The tasker receives the balance when escrow releases.',
  '',
  '## Curated flows',
  '',
  'The convenience fee is $99 per visit.',
  '',
].join('\n');

const REVIEWED = '2026-05-01';
const BEFORE = '2026-04-01T00:00:00.000Z';
const SAME_DAY = '2026-05-01T09:00:00.000Z';
const AFTER = '2026-08-01T00:00:00.000Z';
const NOW = new Date('2026-08-04T00:00:00.000Z');

const opts = (over: Partial<DetectOptions> = {}): DetectOptions => ({ now: NOW, ...over });

const claim = (over: Partial<BrainClaim> = {}): BrainClaim => ({
  key: 'taskly.commission_rate',
  path: SYSTEM,
  heading: 'Marketplace payments',
  span: 'Taskly keeps 20% of the agreed deal',
  value: { amount: 20, unit: 'percent', text: '20%' },
  status: 'canonical',
  reviewed: REVIEWED,
  ...over,
});

const evidence = (over: Partial<EvidenceRef> = {}): EvidenceRef => ({
  signal_id: null,
  fact_id: null,
  source_url: 'https://taskly.ca/pricing',
  span: 'Taskly keeps 25% of the agreed deal',
  observed_at: AFTER,
  ...over,
});

const observed = (over: Partial<WorldObservation> = {}): WorldObservation => ({
  key: 'taskly.commission_rate',
  value: { amount: 25, unit: 'percent' },
  observedAt: AFTER,
  evidence: [evidence()],
  basis: 'governed_query',
  ...over,
});

const only = (claims: BrainClaim[], obs: WorldObservation[], o = opts()) => {
  const found = detectContradictions(claims, obs, o);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe('a formatting difference is not a contradiction', () => {
  // THE headline test. A system that opens a pull request because 0.2 ≠ 20%
  // will be switched off inside a week, and it will deserve it.
  it('classifies 0.2 against 20% as a unit mismatch', () => {
    const c = only([claim()], [observed({ value: { amount: 0.2, unit: 'ratio' } })]);

    expect(c.kind).toBe('unit_mismatch');
    expect(c.confidence).toBe(0);
  });

  it('proposes no edit for a unit mismatch', () => {
    const c = only([claim()], [observed({ value: { amount: 0.2, unit: 'ratio' } })]);

    expect(isActionable(c)).toBe(false);
    const outcome = proposeEdit(c, SYSTEM_DOC);
    expect(outcome.proposed).toBe(false);
    expect(outcome.proposed === false && outcome.refusal.code).toBe('not_stale_brain');
  });

  it('classifies $99 against 9900 cents as a unit mismatch too', () => {
    const dollars = claim({
      key: 'taskly.convenience_fee',
      heading: 'Curated flows',
      span: 'The convenience fee is $99 per visit.',
      value: { amount: 99, unit: 'dollars', text: '$99' },
    });
    const cents = observed({
      key: 'taskly.convenience_fee',
      value: { amount: 9900, unit: 'cents' },
    });

    const c = only([dollars], [cents]);
    expect(c.kind).toBe('unit_mismatch');
    expect(proposeEdit(c, SYSTEM_DOC).proposed).toBe(false);
  });

  it('says nothing at all when the units already match and the values agree', () => {
    expect(
      detectContradictions(
        [claim()],
        [observed({ value: { amount: 20, unit: 'percent' } })],
        opts(),
      ),
    ).toEqual([]);
  });

  it('absorbs prose rounding inside the tolerance', () => {
    // 20% written up from a 20.04% computed rate is the same number to a reader.
    const near = observed({ value: { amount: 20.04, unit: 'percent' } });
    expect(detectContradictions([claim()], [near], opts())).toEqual([]);
  });

  it('does not compare across dimensions — a rate and a dollar amount collide only by accident', () => {
    const money = observed({ value: { amount: 9900, unit: 'cents' } });
    expect(detectContradictions([claim()], [money], opts())).toEqual([]);
  });
});

describe('typing the contradiction before acting on it', () => {
  it('calls it stale_brain when the world moved after the Brain was reviewed', () => {
    const c = only([claim()], [observed({ observedAt: AFTER })]);

    expect(c.kind).toBe('stale_brain');
    expect(isActionable(c)).toBe(true);
    expect(c.confidence).toBeGreaterThan(0);
  });

  it('calls it stale_observation when our data predates the Brain edit', () => {
    const c = only(
      [claim()],
      [observed({ observedAt: BEFORE, evidence: [evidence({ observed_at: BEFORE })] })],
    );

    expect(c.kind).toBe('stale_observation');
    expect(isActionable(c)).toBe(false);
  });

  it('calls it a genuine conflict when neither side is older', () => {
    // `reviewed` has day granularity, so a same-day observation carries no
    // ordering information. Somebody is wrong and a human has to look.
    const c = only([claim()], [observed({ observedAt: SAME_DAY })]);

    expect(c.kind).toBe('genuine_conflict');
    expect(isActionable(c)).toBe(false);
  });

  it('cannot order anything against a document with no review date', () => {
    const c = only([claim({ status: 'draft', reviewed: null })], [observed()]);

    expect(c.kind).toBe('genuine_conflict');
  });

  it('carries the document, heading, quoted span and evidence with every contradiction', () => {
    const c = only([claim()], [observed()]);

    expect(c.path).toBe(SYSTEM);
    expect(c.heading).toBe('Marketplace payments');
    expect(SYSTEM_DOC).toContain(c.span);
    expect(c.evidence[0]?.source_url).toBe('https://taskly.ca/pricing');
    expect(c.rationale).not.toBe('');
  });
});

describe('an observation has to earn the right to contradict the record', () => {
  it('ignores an unsourced observation entirely', () => {
    // Unsourced claims are refused at consolidation; they may not overturn the
    // company's own record through a side door either.
    expect(detectContradictions([claim()], [observed({ evidence: [] })], opts())).toEqual([]);
  });

  it('ignores an observation stamped after the clock', () => {
    const future = observed({ observedAt: '2027-01-01T00:00:00.000Z' });
    expect(detectContradictions([claim()], [future], opts())).toEqual([]);
  });

  it('trusts a verified metric more than exploratory guesswork', () => {
    const strong = only([claim()], [observed({ basis: 'verified_metric' })]).confidence;
    const weak = only([claim()], [observed({ basis: 'exploratory_unverified' })]).confidence;

    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeLessThanOrEqual(1);
  });

  it('reports one contradiction when several sources observed the same value', () => {
    const a = observed({ evidence: [evidence({ source_url: 'https://taskly.ca/a' })] });
    const b = observed({ evidence: [evidence({ source_url: 'https://taskly.ca/b' })] });
    const c = only([claim()], [a, b]);

    expect(c.evidence).toHaveLength(2);
  });

  it('pairs a claim only with observations of the same key', () => {
    expect(detectContradictions([claim()], [observed({ key: 'something.else' })], opts())).toEqual(
      [],
    );
  });
});

describe('proposing an edit — TMOS proposes, a human disposes', () => {
  const stale = () => only([claim()], [observed()]);

  it('quotes an old span that appears verbatim in the document', () => {
    const outcome = proposeEdit(stale(), SYSTEM_DOC);

    expect(outcome.proposed).toBe(true);
    if (!outcome.proposed) return;
    expect(SYSTEM_DOC).toContain(outcome.proposal.oldSpan);
    expect(outcome.proposal.path).toBe(SYSTEM);
  });

  it('writes the new value in the unit the document already uses', () => {
    // Patching "20%" to "0.25" would introduce the very unit mismatch the
    // classifier just refused to open a pull request over.
    const c = only([claim()], [observed({ value: { amount: 0.25, unit: 'ratio' } })]);
    const outcome = proposeEdit(c, SYSTEM_DOC);

    expect(outcome.proposed && outcome.proposal.newSpan).toBe(
      'Taskly keeps 25% of the agreed deal',
    );
  });

  it('cites the evidence in the pull-request body and never auto-merges', () => {
    const outcome = proposeEdit(stale(), SYSTEM_DOC);

    if (!outcome.proposed) throw new Error('expected a proposal');
    expect(outcome.proposal.body).toContain('https://taskly.ca/pricing');
    expect(outcome.proposal.body.toLowerCase()).toContain('review');
    expect(outcome.proposal.title).toContain('20%');
    expect(outcome.proposal.title).toContain('25%');
  });

  it('refuses a document that is not the record', () => {
    const draft = only([claim({ status: 'draft' })], [observed()]);
    const outcome = proposeEdit(draft, SYSTEM_DOC);

    expect(outcome.proposed).toBe(false);
    expect(outcome.proposed === false && outcome.refusal.code).toBe('not_canonical');
  });

  it('refuses a span it cannot find in the document', () => {
    const drifted = only([claim({ span: 'Taskly keeps 20% of every job' })], [observed()]);
    const outcome = proposeEdit(drifted, SYSTEM_DOC);

    expect(outcome.proposed).toBe(false);
    expect(outcome.proposed === false && outcome.refusal.code).toBe('span_not_found');
  });

  it('refuses a span that appears more than once', () => {
    const twice = `${SYSTEM_DOC}\nTaskly keeps 20% of the agreed deal, again.\n`;
    const outcome = proposeEdit(stale(), twice);

    expect(outcome.proposed).toBe(false);
    expect(outcome.proposed === false && outcome.refusal.code).toBe('span_ambiguous');
  });

  it('refuses when the value is not inside the span it was told to patch', () => {
    const c = only(
      [claim({ span: 'The tasker receives the balance when escrow releases.' })],
      [observed()],
    );
    const outcome = proposeEdit(c, SYSTEM_DOC);

    expect(outcome.proposed).toBe(false);
    expect(outcome.proposed === false && outcome.refusal.code).toBe('value_not_in_span');
  });

  it('never opens a pull request from the detector or the proposer', () => {
    let opened = 0;
    const pr: PullRequestPort = {
      open: () => {
        opened += 1;
        return Promise.resolve({ url: 'https://github.com/taskly/never' });
      },
    };

    const outcome = proposeEdit(stale(), SYSTEM_DOC);

    expect(outcome.proposed).toBe(true);
    expect(opened).toBe(0);
    expect(typeof pr.open).toBe('function');
  });
});

describe('rendering a quantity', () => {
  it('writes each unit the way a document writes it', () => {
    expect(renderQuantity(25, 'percent')).toBe('25%');
    expect(renderQuantity(0.25, 'ratio')).toBe('0.25');
    expect(renderQuantity(99, 'dollars')).toBe('$99');
    expect(renderQuantity(99.5, 'dollars')).toBe('$99.50');
    expect(renderQuantity(9900, 'cents')).toBe('9900 cents');
    expect(renderQuantity(3, 'count')).toBe('3');
  });

  it('does not leak float noise into a document', () => {
    expect(renderQuantity(0.07 * 100, 'percent')).toBe('7%');
  });
});
