import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMemoryPredicateStore,
  proposePredicate,
  recordOccurrence,
  evaluatePromotion,
  promotePredicate,
  resolveAlias,
  validateValue,
  normalizePredicateName,
  PROMOTION_MIN_OCCURRENCES,
  PROMOTION_MIN_DISTINCT_SOURCES,
} from './predicates.js';
import type { PredicateDef, PredicateStore } from './predicates.js';
import type { FactRow } from './types.js';

const AUG4 = '2026-08-04T00:00:00.000Z';

const def = (over: Partial<PredicateDef> = {}): PredicateDef => ({
  predicate: 'hourly_rate_cents',
  entityType: 'competitor',
  datatype: 'num',
  unit: 'cents',
  cardinality: 'one',
  status: 'active',
  description: 'Advertised hourly rate.',
  aliases: [],
  supersededBy: null,
  occurrences: 0,
  subjective: false,
  distinctSources: [],
  ...over,
});

let store: PredicateStore;
beforeEach(() => {
  store = createMemoryPredicateStore();
});

describe('predicates are DATA — a new attribute proposes a row, it does not fail', () => {
  it('creates a proposed row instead of inventing a column or dropping the value', async () => {
    const { def: d, created } = await proposePredicate(store, {
      predicate: 'Minimum Callout Fee',
      entityType: 'competitor',
      datatype: 'num',
      unit: 'cents',
      description: 'Minimum charge to show up.',
      sourceId: 'src_a',
    });
    expect(created).toBe(true);
    expect(d.status).toBe('proposed');
    expect(d.predicate).toBe('minimum_callout_fee');
    expect(d.occurrences).toBe(1);
    expect(await store.get('minimum_callout_fee')).not.toBeNull();
  });

  it('carries the subjectivity flag, so conflict typing reads metadata not a name list', async () => {
    const { def: objective } = await proposePredicate(store, {
      predicate: 'callout_fee_cents',
      entityType: 'competitor',
      datatype: 'num',
      unit: 'cents',
      description: 'Minimum charge.',
      sourceId: 'src_a',
    });
    expect(objective.subjective).toBe(false); // objectivity is never claimed by omission

    const { def: opinion } = await proposePredicate(store, {
      predicate: 'trustpilot_rating',
      entityType: 'competitor',
      datatype: 'num',
      unit: 'stars',
      description: 'Public rating.',
      subjective: true,
      sourceId: 'src_a',
    });
    expect(opinion.subjective).toBe(true);

    // This is exactly the callback `classifyConflict` expects.
    const isSubjective = async (p: string): Promise<boolean | undefined> =>
      (await store.get(p))?.subjective;
    expect(await isSubjective('trustpilot_rating')).toBe(true);
    expect(await isSubjective('callout_fee_cents')).toBe(false);
    expect(await isSubjective('never_seen')).toBeUndefined();
  });

  it('normalizes the name so one attribute does not mint three predicates', () => {
    expect(normalizePredicateName(' Hourly-Rate  Cents ')).toBe('hourly_rate_cents');
    expect(normalizePredicateName('hourly_rate_cents')).toBe('hourly_rate_cents');
  });

  it('folds a re-proposal into the existing row instead of duplicating it', async () => {
    const p = {
      predicate: 'minimum_callout_fee',
      entityType: 'competitor',
      datatype: 'num' as const,
      unit: 'cents',
      description: 'Minimum charge to show up.',
      sourceId: 'src_a',
    };
    await proposePredicate(store, p);
    const again = await proposePredicate(store, { ...p, sourceId: 'src_b' });
    expect(again.created).toBe(false);
    expect(again.def.occurrences).toBe(2);
    expect(again.def.distinctSources).toEqual(['src_a', 'src_b']);
    expect(await store.all()).toHaveLength(1);
  });

  it('resolves a proposal that arrives under a known alias', async () => {
    await store.upsert(def({ predicate: 'hourly_rate_cents', aliases: ['hourly_rate'] }));
    const { def: d, created } = await proposePredicate(store, {
      predicate: 'hourly rate',
      entityType: 'competitor',
      datatype: 'num',
      description: 'dup',
      sourceId: 'src_a',
    });
    expect(created).toBe(false);
    expect(d.predicate).toBe('hourly_rate_cents');
  });
});

describe('promotion needs DISTINCT sources, not raw count', () => {
  const propose = (sourceId: string) =>
    proposePredicate(store, {
      predicate: 'callout_fee_cents',
      entityType: 'competitor',
      datatype: 'num',
      unit: 'cents',
      description: 'Minimum charge to show up.',
      sourceId,
    });

  it('BLOCKS promotion when one chatty source supplies every occurrence', async () => {
    await propose('src_loud');
    await propose('src_loud');
    await propose('src_loud');
    await propose('src_loud');

    const d = (await store.get('callout_fee_cents'))!;
    expect(d.occurrences).toBeGreaterThanOrEqual(PROMOTION_MIN_OCCURRENCES);
    expect(d.distinctSources).toEqual(['src_loud']);

    const verdict = evaluatePromotion(d);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/distinct source/i);

    const attempt = await promotePredicate(store, 'callout_fee_cents');
    expect(attempt.promoted).toBe(false);
    expect((await store.get('callout_fee_cents'))!.status).toBe('proposed');
  });

  it('promotes once the attribute recurs across distinct sources', async () => {
    await propose('src_a');
    await propose('src_b');
    await propose('src_c');

    const d = (await store.get('callout_fee_cents'))!;
    expect(d.distinctSources.length).toBeGreaterThanOrEqual(PROMOTION_MIN_DISTINCT_SOURCES);
    expect(evaluatePromotion(d).eligible).toBe(true);

    const out = await promotePredicate(store, 'callout_fee_cents');
    expect(out.promoted).toBe(true);
    expect(out.def.status).toBe('active');
  });

  it('never demotes an already-active predicate through the promotion path', async () => {
    await store.upsert(def({ predicate: 'hourly_rate_cents', status: 'active' }));
    const verdict = evaluatePromotion((await store.get('hourly_rate_cents'))!);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/not proposed/i);
  });

  it('counts an occurrence without re-proposing the whole definition', async () => {
    await propose('src_a');
    const d = await recordOccurrence(store, 'callout_fee_cents', 'src_b');
    expect(d.occurrences).toBe(2);
    expect(d.distinctSources).toEqual(['src_a', 'src_b']);
  });
});

describe('the occurrence ledger only ever grows, as it does in Postgres', () => {
  // 007 replaced "seen N times" with a `predicate_occurrence` ledger, and
  // `predicate_occurrence_sync` recomputes `predicate_def.occurrences` from
  // `sum(count)` after every write — so the adapter never writes that column at
  // all. This store used to take both derived fields verbatim, which made two
  // writes possible here that the database ignores. Both silently move
  // `evaluatePromotion`'s answer, and only in the fake.

  it('refuses to roll the total backwards when handed a stale definition', async () => {
    const stale = await store.upsert(def({ occurrences: 5, distinctSources: ['src_a'] }));
    expect(stale.occurrences).toBe(5);

    // Someone else counted two more sightings; we then write back the copy we
    // read before they did.
    await recordOccurrence(store, 'hourly_rate_cents', 'src_a');
    await recordOccurrence(store, 'hourly_rate_cents', 'src_a');
    const written = await store.upsert(stale);

    expect(written.occurrences).toBe(7);
    expect((await store.get('hourly_rate_cents'))?.occurrences).toBe(7);
  });

  it('refuses to un-see a source that is already in the ledger', async () => {
    await store.upsert(def({ occurrences: 2, distinctSources: ['src_a', 'src_b'] }));
    const written = await store.upsert(def({ occurrences: 2, distinctSources: ['src_a'] }));

    expect(written.distinctSources).toEqual(['src_a', 'src_b']);
    expect(evaluatePromotion({ ...written, status: 'proposed', occurrences: 3 }).eligible).toBe(
      true,
    );
  });

  it('counts a NEW source as a sighting even when the caller asked for no increase', async () => {
    // `reconcileOccurrences` writes a ledger row worth 1 for every source it has
    // not seen, whatever the requested delta was, so the total moves anyway.
    await store.upsert(def({ occurrences: 1, distinctSources: ['src_a'] }));
    const written = await store.upsert(def({ occurrences: 1, distinctSources: ['src_a', 'src_b'] }));

    expect(written.occurrences).toBe(2);
    expect(written.distinctSources).toEqual(['src_a', 'src_b']);
  });

  it('still lets the definition itself be rewritten in place', async () => {
    await store.upsert(def({ predicate: 'rate_cents' })); // the replacement, first
    await store.upsert(def({ occurrences: 3, distinctSources: ['src_a', 'src_b'] }));
    const rewritten = await store.upsert(
      def({
        occurrences: 3,
        distinctSources: ['src_a', 'src_b'],
        description: 'Rewritten.',
        status: 'deprecated',
        supersededBy: 'rate_cents',
      }),
    );

    expect(rewritten.description).toBe('Rewritten.');
    expect(rewritten.status).toBe('deprecated');
    expect(rewritten.supersededBy).toBe('rate_cents');
    expect(rewritten.occurrences).toBe(3);
  });
});

describe('resolveAlias', () => {
  it('resolves an exact name and an alias to the same canonical row', async () => {
    await store.upsert(def({ aliases: ['hourly_rate', 'rate_per_hour'] }));
    expect((await resolveAlias(store, 'hourly_rate_cents'))!.via).toBe('exact');
    const viaAlias = await resolveAlias(store, 'Rate Per Hour');
    expect(viaAlias!.via).toBe('alias');
    expect(viaAlias!.canonical.predicate).toBe('hourly_rate_cents');
  });

  it('follows supersededBy to the replacement', async () => {
    // The replacement is written FIRST: `predicate_def.superseded_by` is a
    // foreign key onto the same table, so a forward reference is a state
    // Postgres cannot hold — and the store now refuses it too.
    await store.upsert(def({ predicate: 'hourly_rate_cents' }));
    await store.upsert(
      def({ predicate: 'hourly_rate', status: 'deprecated', supersededBy: 'hourly_rate_cents' }),
    );
    const r = await resolveAlias(store, 'hourly_rate');
    expect(r!.canonical.predicate).toBe('hourly_rate_cents');
    expect(r!.chain).toEqual(['hourly_rate', 'hourly_rate_cents']);
    expect(r!.cycle).toBe(false);
  });

  it('TERMINATES on a supersededBy cycle and flags it', async () => {
    // A cycle is REACHABLE in Postgres, but only the way the foreign key
    // allows: `a` with no pointer, then `b` pointing at `a`, then `a`
    // re-pointed at `b`. Writing both forward references straight off — what
    // this test used to do — is a sequence the database would have refused, so
    // it proved termination against a state that could not exist.
    await store.upsert(def({ predicate: 'a_rate' }));
    await store.upsert(def({ predicate: 'b_rate', supersededBy: 'a_rate' }));
    await store.upsert(def({ predicate: 'a_rate', supersededBy: 'b_rate' }));
    const r = await resolveAlias(store, 'a_rate');
    expect(r).not.toBeNull();
    expect(r!.cycle).toBe(true);
    expect(r!.chain).toEqual(['a_rate', 'b_rate']);
  });

  it('refuses a supersededBy that points at no row — superseded_by is a foreign key', async () => {
    // 001: `superseded_by text references predicate_def(predicate)`. It is the
    // only foreign key in this module whose target table the fake holds, so it
    // is the only one it can enforce — and a dangling pointer that Postgres
    // rejects outright used to be storable here. `resolveAlias` still handles
    // one defensively (another writer, an older row), but this store can no
    // longer mint it.
    await expect(
      store.upsert(def({ predicate: 'old_rate', supersededBy: 'never_written' })),
    ).rejects.toThrow(/foreign key onto predicate_def/);
    expect(await store.get('old_rate')).toBeNull();
  });

  it('returns null for an unknown name rather than guessing one', async () => {
    expect(await resolveAlias(store, 'not_a_predicate')).toBeNull();
  });
});

describe('validateValue', () => {
  const factRow = (over: Partial<FactRow> = {}): FactRow => ({
    factId: 'f_a',
    entityId: 'ent_jiffy',
    predicate: 'hourly_rate_cents',
    value: { datatype: 'num', num: 9900 },
    valid: { from: AUG4, to: null },
    asserted: { from: AUG4, to: null },
    sourceId: 'src_a',
    observedAt: AUG4,
    confidence: 0.7,
    method: 'scrape',
    evidence: {},
    supersedes: null,
    status: 'active',
    ...over,
  });

  it('rejects a datatype the predicate does not declare', () => {
    const r = validateValue(def(), { datatype: 'text', text: '99' });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain('datatype_mismatch');
  });

  it('rejects a numeric predicate with no unit — that is how 99 becomes dollars', () => {
    const r = validateValue(def({ unit: null }), { datatype: 'num', num: 9900 });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain('missing_unit');
  });

  it('accepts a well-formed value', () => {
    const r = validateValue(def(), { datatype: 'num', num: 9900 });
    expect(r.ok).toBe(true);
    expect(r.problems).toHaveLength(0);
  });

  it('a `one` predicate with a second live value is a CONFLICT, not an overwrite', () => {
    const r = validateValue(
      def({ cardinality: 'one' }),
      { datatype: 'num', num: 11900 },
      { existing: [factRow()], at: AUG4 },
    );
    expect(r.ok).toBe(false);
    const problem = r.problems.find((p) => p.code === 'cardinality_conflict');
    expect(problem).toBeDefined();
    expect(problem!.factIds).toEqual(['f_a']);
  });

  it('does not fire cardinality on a restatement of the same value', () => {
    const r = validateValue(
      def({ cardinality: 'one' }),
      { datatype: 'num', num: 9900 },
      { existing: [factRow()], at: AUG4 },
    );
    expect(r.ok).toBe(true);
  });

  it('does not fire cardinality on rows we no longer assert, or outside the instant', () => {
    const retracted = factRow({ factId: 'f_dead', status: 'retracted' });
    const elsewhere = factRow({
      factId: 'f_old',
      valid: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
    });
    const r = validateValue(
      def({ cardinality: 'one' }),
      { datatype: 'num', num: 11900 },
      { existing: [retracted, elsewhere], at: AUG4 },
    );
    expect(r.ok).toBe(true);
  });

  it('allows many values at one instant for a `many` predicate', () => {
    const r = validateValue(
      def({ predicate: 'service_area', datatype: 'text', unit: null, cardinality: 'many' }),
      { datatype: 'text', text: 'Scarborough' },
      { existing: [factRow({ value: { datatype: 'text', text: 'Etobicoke' } })], at: AUG4 },
    );
    expect(r.ok).toBe(true);
  });

  it('warns — but does not fail — on a deprecated predicate', () => {
    const r = validateValue(def({ status: 'deprecated', supersededBy: 'hourly_rate_micros' }), {
      datatype: 'num',
      num: 9900,
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain('deprecated_predicate');
    expect(r.warnings[0]!.message).toMatch(/hourly_rate_micros/);
  });
});
