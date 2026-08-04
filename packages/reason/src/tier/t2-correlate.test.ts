import { describe, it, expect } from 'vitest';
import {
  correlate,
  assembleFinding,
  scoreVerdict,
  NOVELTY,
  STAKES_WEIGHT,
  T2_WEIGHTS,
} from './t2-correlate.js';
import type {
  CollapseCopyChainsPort,
  CorrelateInput,
  DerivesEdgeLike,
  EntityHistoryPort,
  HistoryLookup,
  T2Verdict,
} from './t2-correlate.js';
import { assertL0 } from '../verify/l0.js';
import { findingSchema } from '@tmos/contracts';
import type { EvidenceRef } from '@tmos/contracts';

const PRICING = 'https://jiffyondemand.com/pricing';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ev = (span: string, url = PRICING): EvidenceRef => ({
  signal_id: uuid(900),
  fact_id: null,
  source_url: url,
  span,
  observed_at: '2026-08-04T00:00:00.000Z',
});

const history = (lookup: HistoryLookup | (() => never)): EntityHistoryPort => ({
  async lookup() {
    return typeof lookup === 'function' ? lookup() : lookup;
  },
});

const UNKNOWN: HistoryLookup = { entityKnown: false, current: null };
const held = (num: number, observedAt: string): HistoryLookup => ({
  entityKnown: true,
  current: { value: { kind: 'num', num }, observedAt },
});

/**
 * A faithful stand-in for `@tmos/world`'s `collapseCopyChains` — reason does not
 * depend on world, and what is under test here is our counting of roots and its
 * effect on the score, not world's traversal.
 */
const collapse: CollapseCopyChainsPort = (claims, edges) => {
  const parent = new Map<string, string>(
    edges.map((e: DerivesEdgeLike) => [e.sourceId, e.derivesFrom]),
  );
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    while (parent.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parent.get(cur)!;
    }
    return cur;
  };
  const groups = new Map<string, string[]>();
  for (const c of claims) {
    const root = rootOf(c.sourceId);
    groups.set(root, [...(groups.get(root) ?? []), c.sourceId]);
  }
  return [...groups.keys()].map((root) => ({ roots: [root] }));
};

const input = (over: Partial<CorrelateInput> = {}): CorrelateInput => ({
  subjectRef: 'company:jiffy',
  predicate: 'price.hourly_rate_cents',
  observation: { value: { kind: 'num', num: 6000 }, observedAt: '2026-08-04T00:00:00.000Z' },
  evidence: [ev('Jiffy now charges 6000 cents an hour.')],
  materiality: 0.7,
  stakes: 'medium',
  corroboration: { kind: 'roots', roots: ['jiffy_site'] },
  labels: { subject: 'Jiffy', predicate: 'hourly rate' },
  ...over,
});

const verdictOf = async (
  over: Partial<CorrelateInput>,
  lookup: HistoryLookup,
): Promise<T2Verdict> => {
  const r = await correlate(input(over), { history: history(lookup), collapse });
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.detail}`);
  return r.verdict;
};

describe('entity history diff', () => {
  it('calls an unseen subject new_entity', async () => {
    const v = await verdictOf({}, UNKNOWN);
    expect(v.classification).toBe('new_entity');
    expect(v.priorValue).toBeNull();
  });

  it('calls a newer, different value changed_value', async () => {
    const v = await verdictOf({}, held(4500, '2026-07-01T00:00:00.000Z'));
    expect(v.classification).toBe('changed_value');
    expect(v.priorValue).toEqual({ kind: 'num', num: 4500 });
  });

  it('calls an identical value restated — the case that must not reach a human', async () => {
    const v = await verdictOf({}, held(6000, '2026-07-01T00:00:00.000Z'));
    expect(v.classification).toBe('restated');
  });

  it('treats a disagreement at or behind what we hold as a contradiction, not a change', async () => {
    const v = await verdictOf(
      {
        observation: { value: { kind: 'num', num: 5000 }, observedAt: '2026-06-01T00:00:00.000Z' },
      },
      held(6000, '2026-07-01T00:00:00.000Z'),
    );
    expect(v.classification).toBe('contradicts');
  });

  it('compares text case- and whitespace-insensitively', async () => {
    const v = await verdictOf(
      {
        predicate: 'coverage.city',
        observation: {
          value: { kind: 'text', text: '  Ottawa ' },
          observedAt: '2026-08-04T00:00:00.000Z',
        },
      },
      {
        entityKnown: true,
        current: {
          value: { kind: 'text', text: 'ottawa' },
          observedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    );
    expect(v.classification).toBe('restated');
  });

  it('calls a known entity we hold no value for changed_value, with a null prior', async () => {
    const v = await verdictOf({}, { entityKnown: true, current: null });
    expect(v.classification).toBe('changed_value');
    expect(v.priorValue).toBeNull();
  });
});

describe('restated never promotes', () => {
  it('refuses promotion and floors the score even at maximum materiality', async () => {
    const v = await verdictOf(
      { materiality: 1, stakes: 'high' },
      held(6000, '2026-07-01T00:00:00.000Z'),
    );
    expect(v.promote).toBe(false);
    expect(v.score).toBe(0);
  });

  it('promotes the same item once the value actually moves', async () => {
    const v = await verdictOf(
      { materiality: 1, stakes: 'high' },
      held(4500, '2026-07-01T00:00:00.000Z'),
    );
    expect(v.promote).toBe(true);
    expect(v.score).toBeGreaterThan(0);
  });
});

describe('corroboration counts independent sources, not republications', () => {
  it('collapses ten copies of one press release to one', async () => {
    const wire = 'pr_wire';
    const outlets = Array.from({ length: 9 }, (_, i) => `outlet_${i}`);
    const v = await verdictOf(
      {
        corroboration: {
          kind: 'claims',
          claims: [{ sourceId: wire }, ...outlets.map((sourceId) => ({ sourceId }))],
          edges: outlets.map((sourceId) => ({ sourceId, derivesFrom: wire })),
        },
      },
      UNKNOWN,
    );
    expect(v.independentSources).toBe(1);
    expect(v.roots).toEqual([wire]);
  });

  it('counts two genuinely independent sources as two', async () => {
    const v = await verdictOf(
      {
        corroboration: {
          kind: 'claims',
          claims: [{ sourceId: 'jiffy_site' }, { sourceId: 'the_star' }],
          edges: [],
        },
      },
      UNKNOWN,
    );
    expect(v.independentSources).toBe(2);
    expect(v.components.corroboration).toBeGreaterThan(
      (await verdictOf({}, UNKNOWN)).components.corroboration,
    );
  });

  it('refuses to count at all with no way to collapse copy chains', async () => {
    const r = await correlate(
      input({ corroboration: { kind: 'claims', claims: [{ sourceId: 'a' }], edges: [] } }),
      { history: history(UNKNOWN) },
    );
    expect(r).toMatchObject({ ok: false, reason: 'no_collapse_port' });
  });
});

describe('the score is a ranking signal, not a threshold', () => {
  it('scales two different item types on one scale', async () => {
    const price = await verdictOf({}, held(4500, '2026-07-01T00:00:00.000Z'));
    const coverage = await verdictOf(
      {
        subjectRef: 'company:taskrabbit',
        predicate: 'coverage.city',
        observation: {
          value: { kind: 'text', text: 'Ottawa' },
          observedAt: '2026-08-04T00:00:00.000Z',
        },
        evidence: [ev('TaskRabbit has opened Ottawa.', 'https://taskrabbit.ca/cities')],
        labels: { subject: 'TaskRabbit', predicate: 'city coverage' },
      },
      {
        entityKnown: true,
        current: {
          value: { kind: 'text', text: 'Toronto' },
          observedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    );

    // Same components in, same score out: the score depends on the four
    // normalised dimensions and never on the predicate or the value's type.
    expect(coverage.score).toBe(price.score);
    for (const v of [price, coverage]) {
      expect(v.score).toBeGreaterThanOrEqual(0);
      expect(v.score).toBeLessThanOrEqual(1);
      for (const c of Object.values(v.components)) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('orders by materiality when everything else is equal', async () => {
    const lo = await verdictOf({ materiality: 0.2 }, held(4500, '2026-07-01T00:00:00.000Z'));
    const hi = await verdictOf({ materiality: 0.9 }, held(4500, '2026-07-01T00:00:00.000Z'));
    expect(hi.score).toBeGreaterThan(lo.score);
  });

  it('saturates corroboration, so a swarm of sources cannot outrank materiality alone', () => {
    const one = scoreVerdict({
      materiality: 0,
      classification: 'new_entity',
      independentSources: 1,
      stakes: 'low',
    });
    const fifty = scoreVerdict({
      materiality: 0,
      classification: 'new_entity',
      independentSources: 50,
      stakes: 'low',
    });
    expect(fifty.corroboration - one.corroboration).toBeLessThan(0.5);
  });

  it('keeps its weights normalised, so the score stays inside [0,1]', () => {
    const total = Object.values(T2_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(NOVELTY.restated).toBe(0);
    expect(STAKES_WEIGHT.high).toBe(1);
  });
});

describe('failure is reported, never guessed', () => {
  it('refuses a signal with no evidence at all', async () => {
    const r = await correlate(input({ evidence: [] }), { history: history(UNKNOWN), collapse });
    expect(r).toMatchObject({ ok: false, reason: 'no_evidence' });
  });

  it('reports a broken history lookup as retryable rather than inventing new_entity', async () => {
    const r = await correlate(input(), {
      history: history(() => {
        throw new Error('pg down');
      }),
      collapse,
    });
    expect(r).toMatchObject({ ok: false, reason: 'history_unavailable', retryable: true });
  });
});

describe('a Finding assembled by T2 must survive L0', () => {
  const assemble = (v: T2Verdict) =>
    assembleFinding(v, {
      id: uuid(1),
      createdAt: '2026-08-04T00:00:00.000Z',
      region: 'ca',
      generatedBy: 'agent:t2@1',
    });

  it('passes when the number in the claim comes from the cited span', async () => {
    const v = await verdictOf({}, held(4500, '2026-07-01T00:00:00.000Z'));
    const f = assemble(v);
    expect(findingSchema.safeParse(f).success).toBe(true);
    expect(assertL0({ claim: f.claim, evidence: f.evidence, retrievedUrls: [PRICING] }).ok).toBe(
      true,
    );
  });

  it('fails when the number does not, which is the fabrication we care about', async () => {
    const v = await verdictOf(
      {
        observation: { value: { kind: 'num', num: 7000 }, observedAt: '2026-08-04T00:00:00.000Z' },
        evidence: [ev('Jiffy now charges 6000 cents an hour.')],
      },
      held(4500, '2026-07-01T00:00:00.000Z'),
    );
    const r = assertL0({
      claim: assemble(v).claim,
      evidence: v.evidence,
      retrievedUrls: [PRICING],
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatchObject({ code: 'number_not_in_span', token: '7000' });
  });

  it('writes at causal rung 0 and never uses causal language', async () => {
    const v = await verdictOf({}, held(4500, '2026-07-01T00:00:00.000Z'));
    const f = assemble(v);
    expect(f.causal_rung).toBe(0);
    expect(f.basis).toBe('inferred_from_sources');
    expect(f.claim).not.toMatch(/caused|drove|led to|resulted in/i);
  });

  it('throws rather than ship a caller-supplied so_what that asserts causation', async () => {
    const v = await verdictOf({}, held(4500, '2026-07-01T00:00:00.000Z'));
    expect(() =>
      assembleFinding(v, {
        id: uuid(1),
        createdAt: '2026-08-04T00:00:00.000Z',
        region: 'ca',
        generatedBy: 'agent:t2@1',
        soWhat: 'Their discount caused our conversion drop.',
      }),
    ).toThrow(/causal language/i);
  });

  it('refuses to assemble a Finding from a restated signal', async () => {
    const v = await verdictOf({}, held(6000, '2026-07-01T00:00:00.000Z'));
    expect(() => assemble(v)).toThrow(/restated/i);
  });
});
