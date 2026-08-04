import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryFactStore, resetFactIds } from './fact/memory-store.js';
import { goldenRecord, defaultRuleFor } from './golden.js';
import type { FactRow, FactStore, FactValue } from './fact/types.js';

const ENTITY = 'ent_jiffy';
const AT = '2026-08-10T00:00:00.000Z';

type NewFact = Omit<FactRow, 'factId'>;

const fact = (over: Partial<NewFact> & { value: FactValue }): NewFact => ({
  entityId: ENTITY,
  predicate: 'hourly_rate_cents',
  valid: { from: '2026-07-01T00:00:00.000Z', to: null },
  asserted: { from: '2026-07-01T00:00:00.000Z', to: null },
  sourceId: 'src_a',
  observedAt: '2026-07-01T00:00:00.000Z',
  confidence: 0.5,
  method: 'scrape',
  evidence: {},
  supersedes: null,
  status: 'active',
  ...over,
});

let store: ReturnType<typeof createMemoryFactStore>;
beforeEach(() => {
  resetFactIds();
  store = createMemoryFactStore();
});

const add = (over: Partial<NewFact> & { value: FactValue }) => store.insert(fact(over));

/** Same data, opposite row order. A survivorship rule that changes its answer
 *  when the store hands rows back in a different order is not deterministic. */
const reversed = (s: FactStore): FactStore => ({
  ...s,
  forEntity: async (id) => (await s.forEntity(id)).reverse(),
  forPredicate: async (id, p) => (await s.forPredicate(id, p)).reverse(),
});

describe('mostRecent — latest valid.from wins', () => {
  it('picks the newest value and says so', async () => {
    await add({
      value: { datatype: 'num', num: 9900 },
      valid: { from: '2026-07-01T00:00:00.000Z', to: null },
    });
    await add({
      value: { datatype: 'num', num: 11900 },
      valid: { from: '2026-08-01T00:00:00.000Z', to: null },
    });

    const golden = await goldenRecord(store, ENTITY, AT, {
      byPredicate: { hourly_rate_cents: 'mostRecent' },
    });
    const field = golden.get('hourly_rate_cents')!;
    expect(field.value).toEqual({ datatype: 'num', num: 11900 });
    expect(field.rule).toBe('mostRecent');
    expect(field.why).toMatch(/mostRecent: valid from 2026-08-01/);
  });
});

describe('mostReliable — highest source reliability wins', () => {
  const reliabilityOf = (sourceId: string) => (sourceId === 'src_registry' ? 0.92 : 0.15);

  it('beats a newer value from a worse source', async () => {
    await add({
      value: { datatype: 'num', num: 9900 },
      sourceId: 'src_registry',
      valid: { from: '2026-07-01T00:00:00.000Z', to: null },
    });
    await add({
      value: { datatype: 'num', num: 4900 },
      sourceId: 'src_farm',
      valid: { from: '2026-08-01T00:00:00.000Z', to: null },
    });

    const golden = await goldenRecord(store, ENTITY, AT, {
      byPredicate: { hourly_rate_cents: 'mostReliable' },
      reliabilityOf,
    });
    const field = golden.get('hourly_rate_cents')!;
    expect(field.value).toEqual({ datatype: 'num', num: 9900 });
    expect(field.sourceId).toBe('src_registry');
    expect(field.why).toMatch(/reliability 0\.92/);
  });

  it('says out loud when it had no reliability function to work with', async () => {
    // Silently scoring every source at zero would look like a considered
    // answer. The record has to admit the rule could not run.
    await add({ value: { datatype: 'num', num: 9900 } });
    await add({
      value: { datatype: 'num', num: 4900 },
      valid: { from: '2026-08-01T00:00:00.000Z', to: null },
    });

    const golden = await goldenRecord(store, ENTITY, AT, {
      byPredicate: { hourly_rate_cents: 'mostReliable' },
    });
    expect(golden.get('hourly_rate_cents')!.why).toMatch(/no reliabilityOf supplied/);
  });
});

describe('mostConfident — highest extraction confidence wins', () => {
  it('prefers the confident older row over a shaky newer one', async () => {
    await add({ value: { datatype: 'num', num: 9900 }, confidence: 0.95 });
    await add({
      value: { datatype: 'num', num: 4900 },
      confidence: 0.31,
      valid: { from: '2026-08-01T00:00:00.000Z', to: null },
    });

    const golden = await goldenRecord(store, ENTITY, AT, {
      byPredicate: { hourly_rate_cents: 'mostConfident' },
    });
    const field = golden.get('hourly_rate_cents')!;
    expect(field.value).toEqual({ datatype: 'num', num: 9900 });
    expect(field.why).toMatch(/mostConfident: 0\.95/);
  });
});

describe('mostFrequent — plurality across INDEPENDENT sources', () => {
  const address = (text: string, sourceId: string) =>
    add({ predicate: 'address', value: { datatype: 'text', text }, sourceId });

  it('collapses a copy chain, so three blogs quoting one release count once', async () => {
    await address('12 King St W', 'src_1');
    await address('12 King St W', 'src_2');
    await address('99 Bay St', 'src_press');
    await address('99 Bay St', 'src_blog_a');
    await address('99 Bay St', 'src_blog_b');

    // Naive voting would hand this to the copied value, 3–2.
    const golden = await goldenRecord(store, ENTITY, AT, {
      byPredicate: { address: 'mostFrequent' },
      independentRootOf: (s) => (s.startsWith('src_blog') ? 'src_press' : s),
    });
    const field = golden.get('address')!;
    expect(field.value).toEqual({ datatype: 'text', text: '12 King St W' });
    expect(field.why).toMatch(/2 of 3 independent source\(s\) agree/);
  });
});

describe('longestHeld — a stable value is not overwritten by a fresh scrape', () => {
  it('beats mostRecent where the recent row is more likely an error than a change', async () => {
    // A founding year does not change. A scrape that suddenly reports the year
    // we started tracking the company is an extraction bug, and mostRecent
    // would launder it into the golden record.
    await add({
      predicate: 'founded_year',
      value: { datatype: 'num', num: 1998 },
      valid: { from: '2019-01-01T00:00:00.000Z', to: null },
      sourceId: 'src_registry',
    });
    await add({
      predicate: 'founded_year',
      value: { datatype: 'num', num: 2019 },
      valid: { from: '2026-08-09T00:00:00.000Z', to: null },
      sourceId: 'src_scrape',
    });

    const recent = await goldenRecord(store, ENTITY, AT, {
      byPredicate: { founded_year: 'mostRecent' },
    });
    expect(recent.get('founded_year')!.value).toEqual({ datatype: 'num', num: 2019 });

    const held = await goldenRecord(store, ENTITY, AT, {
      byPredicate: { founded_year: 'longestHeld' },
    });
    const field = held.get('founded_year')!;
    expect(field.value).toEqual({ datatype: 'num', num: 1998 });
    expect(field.why).toMatch(/longestHeld: held 2778d vs 1d/);
  });
});

describe('ties resolve deterministically and the record says how', () => {
  const tied = async (s: ReturnType<typeof createMemoryFactStore>) => {
    await s.insert(fact({ value: { datatype: 'num', num: 100 }, sourceId: 'src_1' }));
    await s.insert(fact({ value: { datatype: 'num', num: 200 }, sourceId: 'src_2' }));
  };

  it('gives the same answer whichever order the rows arrive in', async () => {
    await tied(store);
    const rules = { byPredicate: { hourly_rate_cents: 'mostRecent' as const } };

    const forward = await goldenRecord(store, ENTITY, AT, rules);
    const backward = await goldenRecord(reversed(store), ENTITY, AT, rules);

    expect(forward.get('hourly_rate_cents')!.factId).toBe(
      backward.get('hourly_rate_cents')!.factId,
    );
    expect(forward.get('hourly_rate_cents')!.why).toMatch(
      /tied .*broken by confidence then fact id/,
    );
  });
});

describe('every field traces back to evidence', () => {
  it('carries a factId that resolves in the store, for every predicate', async () => {
    await add({ value: { datatype: 'num', num: 9900 } });
    await add({ predicate: 'city', value: { datatype: 'text', text: 'Toronto' } });
    await add({ predicate: 'parent', value: { datatype: 'entity', entityId: 'ent_parent' } });

    const golden = await goldenRecord(store, ENTITY, AT, {});
    expect([...golden.keys()].sort()).toEqual(['city', 'hourly_rate_cents', 'parent']);

    for (const [predicate, field] of golden) {
      const row = await store.byId(field.factId);
      expect(row, `${predicate} points at a fact that does not exist`).not.toBeNull();
      expect(row!.value).toEqual(field.value);
      expect(row!.sourceId).toBe(field.sourceId);
      expect(field.why.length).toBeGreaterThan(0);
    }
  });
});

describe('the candidate set is the bitemporal one', () => {
  it('ignores retracted rows and beliefs we have already closed', async () => {
    const live = await add({ value: { datatype: 'num', num: 9900 } });
    // Both of these are NEWER, so mostRecent would hand them the field if the
    // candidate set were not filtered by what we currently believe.
    await add({
      value: { datatype: 'num', num: 100 },
      status: 'retracted',
      valid: { from: '2026-08-01T00:00:00.000Z', to: null },
      asserted: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-09T00:00:00.000Z' },
    });
    await add({
      value: { datatype: 'num', num: 200 },
      valid: { from: '2026-08-02T00:00:00.000Z', to: null },
      asserted: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-09T00:00:00.000Z' },
    });

    const golden = await goldenRecord(store, ENTITY, AT, {});
    expect(golden.get('hourly_rate_cents')!.factId).toBe(live.factId);
  });

  it('ignores rows whose valid range does not cover the instant asked about', async () => {
    await add({
      value: { datatype: 'num', num: 9900 },
      valid: { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
    });
    const golden = await goldenRecord(store, ENTITY, AT, {});
    expect(golden.has('hourly_rate_cents')).toBe(false);
  });

  it('reconstructs what we believed THEN when assertedAt is given', async () => {
    // The July row was our belief until Aug 20, when we corrected it.
    await add({
      value: { datatype: 'num', num: 9900 },
      asserted: { from: '2026-07-01T00:00:00.000Z', to: '2026-08-20T00:00:00.000Z' },
    });
    await add({
      value: { datatype: 'num', num: 9500 },
      asserted: { from: '2026-08-20T00:00:00.000Z', to: null },
    });

    const now = await goldenRecord(store, ENTITY, AT, {});
    expect(now.get('hourly_rate_cents')!.value).toEqual({ datatype: 'num', num: 9500 });

    const then = await goldenRecord(store, ENTITY, AT, { assertedAt: '2026-08-10T00:00:00.000Z' });
    expect(then.get('hourly_rate_cents')!.value).toEqual({ datatype: 'num', num: 9900 });
  });
});

describe('defaultRuleFor', () => {
  it('is a fallback per datatype, not a claim about any predicate', () => {
    expect(defaultRuleFor('num')).toBe('mostRecent');
    expect(defaultRuleFor('text')).toBe('mostFrequent');
    expect(defaultRuleFor('entity')).toBe('mostReliable');
    expect(defaultRuleFor('json')).toBe('mostRecent');
  });

  it('is what an unconfigured predicate falls back to', async () => {
    await add({ value: { datatype: 'num', num: 9900 } });
    await add({
      value: { datatype: 'num', num: 11900 },
      valid: { from: '2026-08-01T00:00:00.000Z', to: null },
    });
    const golden = await goldenRecord(store, ENTITY, AT, {});
    expect(golden.get('hourly_rate_cents')!.rule).toBe('mostRecent');
  });
});
