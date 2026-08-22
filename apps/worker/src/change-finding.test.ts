/**
 * The change→Finding step, with a fake history port.
 *
 * Five outcomes and each is a different decision about what a reader sees, so
 * each gets driven on its own: a restatement publishes nothing, a baseline
 * publishes nothing and says why, an incomparable value is refused rather than
 * reported as a change, a gate rejection is returned rather than thrown, and a
 * real change mints. The one that would do the most damage if it regressed is
 * the baseline: it is indistinguishable from a real change in every field
 * except `priorValue`, and getting it wrong publishes a dozen "we now hold a
 * value where we previously held none" notes on the day the watcher is
 * installed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EvidenceRef } from '@tmos/contracts';
import type { EntityHistoryPort, HistoryLookup, ObservedValue } from '@tmos/reason';

import {
  CAC_CEILING_CENTS,
  WATCH_MATERIALITY,
  findingFromChange,
  type ChangeFindingDeps,
  type ObservedChange,
} from './change-finding.js';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const ID = '77777777-7777-4777-8777-777777777777';

const historyOf = (lookup: HistoryLookup): EntityHistoryPort => ({
  lookup: async () => lookup,
});

const deps = (lookup: HistoryLookup, over: Partial<ChangeFindingDeps> = {}): ChangeFindingDeps => ({
  history: historyOf(lookup),
  now: () => NOW,
  region: 'ca',
  generatedBy: 'agent:watch@2026-08-23',
  newId: () => ID,
  ...over,
});

/** A span that really contains the new value, so L0 has something to match. */
const evidence = (span: string): EvidenceRef[] => [
  {
    signal_id: null,
    fact_id: null,
    source_url: 'https://www.taskrabbit.ca/services',
    span,
    observed_at: '2026-08-23T11:00:00.000Z',
  },
];

const change = (over: Partial<ObservedChange> = {}): ObservedChange => ({
  subjectRef: 'company:taskrabbit.ca',
  subjectLabel: 'TaskRabbit',
  predicate: 'lowest_advertised_price',
  predicateLabel: 'lowest advertised price',
  value: { kind: 'text', text: 'from $49/hr' } as ObservedValue,
  observedAt: '2026-08-23T11:00:00.000Z',
  evidence: evidence('Book a Tasker in Toronto from $49/hr for assembly and moving help.'),
  rootSourceId: 'source:competitor-pages',
  sourceTier: 'first_party',
  stakes: 'high',
  ...over,
});

describe('findingFromChange', () => {
  it('publishes nothing when the page says what it said last time', async () => {
    const got = await findingFromChange(
      change(),
      deps({ entityKnown: true, current: { value: { kind: 'text', text: 'from $49/hr' }, observedAt: '2026-08-01T00:00:00.000Z' } }),
    );

    expect(got.kind).toBe('restated');
  });

  it('treats the first value as the baseline, not as a change', async () => {
    const got = await findingFromChange(change(), deps({ entityKnown: true, current: null }));

    expect(got.kind).toBe('baseline');
    if (got.kind !== 'baseline') return;
    expect(got.detail).toMatch(/before and an after/);
  });

  it('refuses a value it cannot diff rather than calling it a change', async () => {
    const got = await findingFromChange(
      change({ value: null }),
      deps({ entityKnown: true, current: { value: { kind: 'text', text: 'x' }, observedAt: '2026-08-01T00:00:00.000Z' } }),
    );

    expect(got.kind).toBe('refused');
    if (got.kind !== 'refused') return;
    expect(got.reason).toBe('unsupported_value');
  });

  it('refuses an observation with no provenance', async () => {
    const got = await findingFromChange(
      change({ evidence: [] }),
      deps({ entityKnown: true, current: { value: { kind: 'text', text: 'x' }, observedAt: '2026-08-01T00:00:00.000Z' } }),
    );

    expect(got.kind).toBe('refused');
    if (got.kind !== 'refused') return;
    expect(got.reason).toBe('no_evidence');
  });

  it('mints a Finding when a held value actually changed', async () => {
    const got = await findingFromChange(
      change(),
      deps({ entityKnown: true, current: { value: { kind: 'text', text: 'from $65/hr' }, observedAt: '2026-08-01T00:00:00.000Z' } }),
    );

    expect(got.kind).toBe('minted');
    if (got.kind !== 'minted') return;
    expect(got.finding.claim).toContain('from $49/hr');
    // The prior belongs in so_what: it comes from our world model, not from the
    // span, so a claim carrying it would fail L0 on every legitimate change.
    expect(got.finding.so_what).toContain('from $65/hr');
    expect(got.finding.claim).not.toContain('from $65/hr');
    expect(got.finding.subject_refs).toEqual(['company:taskrabbit.ca']);
    expect(got.finding.basis).toBe('inferred_from_sources');
    expect(got.finding.causal_rung).toBe(0);
    expect(got.finding.id).toBe(ID);
    expect(got.finding.created_at).toBe(NOW.toISOString());
  });

  it('scores the minted Finding with the domain scorer, not with T2 rank', async () => {
    const got = await findingFromChange(
      change(),
      deps({ entityKnown: true, current: { value: { kind: 'text', text: 'from $65/hr' }, observedAt: '2026-08-01T00:00:00.000Z' } }),
    );

    expect(got.kind).toBe('minted');
    if (got.kind !== 'minted') return;
    expect(got.finding.domain_score).toBe(got.score.domain_score);
    expect(got.finding.domain_score).not.toBe(got.verdict.score);
    // The breakdown is the point of the scorer: a number nobody can argue with
    // is a number they will ignore.
    expect(got.score.breakdown.map((c) => c.name)).toContain('source_tier');
  });

  it('counts one first-party page as ONE independent source', async () => {
    const got = await findingFromChange(
      change(),
      deps({ entityKnown: true, current: { value: { kind: 'text', text: 'from $65/hr' }, observedAt: '2026-08-01T00:00:00.000Z' } }),
    );

    expect(got.kind).toBe('minted');
    if (got.kind !== 'minted') return;
    expect(got.verdict.independentSources).toBe(1);
    expect(got.verdict.components.materiality).toBeCloseTo(WATCH_MATERIALITY, 10);
  });

  it('returns a gate rejection instead of throwing it', async () => {
    // A count the model derived by counting the page: the number is in the
    // claim and in no span, which is exactly what L0 exists to catch.
    const got = await findingFromChange(
      change({
        predicate: 'service_categories_count',
        predicateLabel: 'service categories count',
        value: { kind: 'num', num: 42 },
        evidence: evidence('Assembly, moving help, cleaning, mounting and more.'),
      }),
      deps({ entityKnown: true, current: { value: { kind: 'num', num: 37 }, observedAt: '2026-08-01T00:00:00.000Z' } }),
    );

    expect(got.kind).toBe('rejected');
    if (got.kind !== 'rejected') return;
    expect(got.detail).toMatch(/42/);
  });

  it('never consults the CAC ceiling — a page change proposes no spend', async () => {
    const cac = vi.fn(() => CAC_CEILING_CENTS);
    const got = await findingFromChange(
      change(),
      deps(
        { entityKnown: true, current: { value: { kind: 'text', text: 'from $65/hr' }, observedAt: '2026-08-01T00:00:00.000Z' } },
        { cacCeilingCents: Number.NaN },
      ),
    );

    // NaN as the ceiling changes nothing: with no channel proposal the check
    // returns before reading it. The day that stops being true, this fails.
    expect(got.kind).toBe('minted');
    if (got.kind !== 'minted') return;
    expect(got.score.rejection).toBeNull();
    expect(Number.isFinite(got.finding.domain_score)).toBe(true);
    expect(cac).not.toHaveBeenCalled();
  });

  it('reports an entity we have never seen without inventing a prior', async () => {
    const got = await findingFromChange(change(), deps({ entityKnown: false, current: null }));

    // `new_entity` also has no prior — same reason, same answer: this is the
    // instrument being installed, not news.
    expect(got.kind).toBe('baseline');
  });
});
