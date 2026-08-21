/**
 * The `PredicateStore` conformance suite.
 *
 * Two things are deliberately NOT asserted, and both are consequences of the
 * Postgres side rather than looseness:
 *
 *   · `all()` is checked as a SUPERSET. The memory store starts empty; the real
 *     `predicate_def` is a live semantic layer with rows in it already. A case
 *     that asserted an exact set would pass forever in memory and fail on the
 *     first real database.
 *   · `distinctSources` is compared SORTED. The memory store returns encounter
 *     order; the adapter orders by `first_seen`, which is `now()` — frozen for a
 *     whole transaction, so every row in a test ties and the tiebreak is a uuid.
 *
 * The promotion case is the load-bearing one. `occurrences` is a trigger-owned
 * column and `distinctSources` is a second table, so `upsert` cannot store what
 * it is handed — it has to reconcile a ledger. That case is what proves the
 * reconciliation produces the same PROMOTION VERDICT as the memory store, which
 * is the only thing about those two fields the system actually acts on.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import {
  evaluatePromotion,
  promotePredicate,
  proposePredicate,
  recordOccurrence,
  resolveAlias,
  type PredicateDef,
  type PredicateStore,
} from '@tmos/world';

import type { ConformanceCase } from './conformance.js';

/**
 * `predicate_occurrence.source_id` is a foreign key to `source`, so the live
 * harness has to supply real ids; the memory store takes any string.
 */
export interface PredicateStoreFixtures {
  readonly entityType: string;
  readonly sourceA: string;
  readonly sourceB: string;
}

export type PredicateStoreCase = ConformanceCase<PredicateStore, PredicateStoreFixtures>;

/** Prefixed so a live run cannot collide with a predicate the system really uses. */
const RATE = 'tmos_conf_hourly_rate';
const OLD = 'tmos_conf_old_name';
const NEW = 'tmos_conf_new_name';

const def = (fx: PredicateStoreFixtures, over: Partial<PredicateDef> = {}): PredicateDef => ({
  predicate: RATE,
  entityType: fx.entityType,
  datatype: 'num',
  unit: 'cents_per_hour',
  cardinality: 'one',
  status: 'proposed',
  description: 'What the competitor charges per hour, in cents.',
  aliases: ['Hourly Rate', 'rate_per_hour'],
  supersededBy: null,
  occurrences: 0,
  subjective: false,
  distinctSources: [],
  ...over,
});

const sorted = (values: readonly string[]): string[] => [...values].sort();

export const PREDICATE_STORE_CONFORMANCE: readonly PredicateStoreCase[] = [
  {
    name: 'upsert then get round-trips every declared field',
    async run(store, fx) {
      const written = await store.upsert(def(fx));
      const read = await store.get(RATE);

      ok(read !== null, 'the predicate must be readable after upsert');
      strictEqual(read.predicate, RATE);
      strictEqual(read.entityType, fx.entityType);
      strictEqual(read.datatype, 'num');
      strictEqual(read.unit, 'cents_per_hour');
      strictEqual(read.cardinality, 'one');
      strictEqual(read.status, 'proposed');
      strictEqual(read.description, def(fx).description);
      deepStrictEqual(read.aliases, ['Hourly Rate', 'rate_per_hour']);
      strictEqual(read.supersededBy, null);
      strictEqual(read.subjective, false);
      deepStrictEqual(read, written, 'upsert must return exactly what get returns');
    },
  },

  {
    name: 'a null unit and a subjective flag survive the round trip',
    async run(store, fx) {
      await store.upsert(def(fx, { datatype: 'num', unit: null, subjective: true }));
      const read = await store.get(RATE);

      strictEqual(read?.unit, null);
      strictEqual(read?.subjective, true);
    },
  },

  {
    name: 'get normalizes the name it is given',
    async run(store, fx) {
      await store.upsert(def(fx));

      for (const spelling of ['TMOS Conf Hourly Rate', 'tmos-conf-hourly-rate', ' tmos_conf_hourly_rate ']) {
        strictEqual((await store.get(spelling))?.predicate, RATE, `${spelling} did not resolve`);
      }
    },
  },

  {
    name: 'upsert normalizes the name it stores',
    async run(store, fx) {
      const written = await store.upsert(def(fx, { predicate: 'TMOS Conf Hourly.Rate' }));

      strictEqual(written.predicate, RATE);
      strictEqual((await store.get(RATE))?.predicate, RATE);
    },
  },

  {
    name: 'get returns null for a predicate nobody has proposed',
    async run(store) {
      strictEqual(await store.get('tmos_conf_nothing_here'), null);
    },
  },

  {
    name: 'byAlias resolves through an alias, normalizing both sides',
    async run(store, fx) {
      await store.upsert(def(fx));

      strictEqual((await store.byAlias('hourly-rate'))?.predicate, RATE);
      strictEqual((await store.byAlias('Hourly Rate'))?.predicate, RATE);
      strictEqual(await store.byAlias('tmos_conf_not_an_alias'), null);
    },
  },

  {
    name: 'all() contains what was written, and a second upsert updates in place',
    async run(store, fx) {
      await store.upsert(def(fx));
      const afterFirst = await store.all();
      ok(
        afterFirst.some((d) => d.predicate === RATE),
        'all() must contain the predicate just written',
      );

      await store.upsert(def(fx, { description: 'Rewritten.', status: 'active' }));
      const afterSecond = await store.all();

      strictEqual(afterSecond.length, afterFirst.length, 'upsert must not add a second row');
      strictEqual((await store.get(RATE))?.description, 'Rewritten.');
      strictEqual((await store.get(RATE))?.status, 'active');
    },
  },

  {
    name: 'proposePredicate creates a proposed row with one occurrence from one source',
    async run(store, fx) {
      const { def: created, created: isNew } = await proposePredicate(store, {
        predicate: 'TMOS Conf Hourly Rate',
        entityType: fx.entityType,
        datatype: 'num',
        unit: 'cents_per_hour',
        description: 'proposed by an extractor',
        sourceId: fx.sourceA,
      });

      strictEqual(isNew, true);
      strictEqual(created.predicate, RATE);
      strictEqual(created.status, 'proposed');
      strictEqual(created.occurrences, 1);
      deepStrictEqual(created.distinctSources, [fx.sourceA]);
    },
  },

  {
    name: 'a repeat sighting by the same source moves the total, not the distinct set',
    async run(store, fx) {
      await store.upsert(def(fx, { occurrences: 1, distinctSources: [fx.sourceA] }));
      const after = await recordOccurrence(store, RATE, fx.sourceA);

      strictEqual(after.occurrences, 2);
      deepStrictEqual(after.distinctSources, [fx.sourceA]);
      strictEqual(
        evaluatePromotion(after).eligible,
        false,
        'one source repeating itself is not recurrence',
      );
    },
  },

  {
    name: 'promotion: three occurrences across two distinct sources',
    async run(store, fx) {
      await proposePredicate(store, {
        predicate: RATE,
        entityType: fx.entityType,
        datatype: 'num',
        unit: 'cents_per_hour',
        description: 'proposed by an extractor',
        sourceId: fx.sourceA,
      });
      await recordOccurrence(store, RATE, fx.sourceA);
      const third = await recordOccurrence(store, RATE, fx.sourceB);

      strictEqual(third.occurrences, 3, 'the total counts sightings, not sources');
      deepStrictEqual(sorted(third.distinctSources), sorted([fx.sourceA, fx.sourceB]));
      deepStrictEqual(evaluatePromotion(third), { eligible: true, reasons: [] });

      const { promoted, def: active } = await promotePredicate(store, RATE);
      strictEqual(promoted, true);
      strictEqual(active.status, 'active');
      strictEqual((await store.get(RATE))?.status, 'active');
    },
  },

  {
    name: 'resolveAlias follows supersededBy to the definition that means something now',
    async run(store, fx) {
      // The replacement is written FIRST: `predicate_def.superseded_by` is a
      // foreign key onto the same table, so a forward reference cannot exist in
      // Postgres even though the memory store would hold one happily.
      await store.upsert(def(fx, { predicate: NEW, aliases: [] }));
      await store.upsert(def(fx, { predicate: OLD, status: 'deprecated', supersededBy: NEW, aliases: ['legacy rate'] }));

      const resolved = await resolveAlias(store, 'Legacy Rate');
      strictEqual(resolved?.canonical.predicate, NEW);
      strictEqual(resolved?.via, 'alias');
      deepStrictEqual(resolved?.chain, [OLD, NEW]);
      strictEqual(resolved?.cycle, false);
    },
  },
];
