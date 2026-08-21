/**
 * `PredicateStore` against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://... pnpm test:live
 *
 * Beyond the shared conformance array, three things here cannot be checked
 * anywhere else, and each corresponds to a decision made in the adapter:
 *
 *   · `normalizePredicateName` exists twice — once in TypeScript, once in SQL —
 *     and the second one is only justified because this test proves they agree.
 *   · `predicate_def.occurrences` is owned by 007's trigger. The adapter never
 *     writes it, so a def claiming a number the ledger does not support must
 *     come back with the ledger's number, not the caller's.
 *   · `predicate_occurrence.source_id` is a foreign key. The memory store's
 *     `distinctSources` is a list of arbitrary strings.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, sql } from '@tmos/db';
import { normalizePredicateName, type PredicateDef } from '@tmos/world';

import { MissingReferenceError } from '../errors.js';
import { PREDICATE_STORE_CONFORMANCE } from '../testing/predicate-store.conformance.js';
import { HAS_DATABASE, inRollback, seedPredicateFixtures } from '../testing/live.js';
import {
  createPostgresPredicateStore,
  normalizePredicateNameSql,
  recordPredicateOccurrence,
} from './predicate-store.js';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

const def = (over: Partial<PredicateDef> = {}): PredicateDef => ({
  predicate: 'tmos_conf_live_rate',
  entityType: 'company',
  datatype: 'num',
  unit: 'cents_per_hour',
  cardinality: 'one',
  status: 'proposed',
  description: 'live conformance fixture',
  aliases: [],
  supersededBy: null,
  occurrences: 0,
  subjective: false,
  distinctSources: [],
  ...over,
});

describe.skipIf(!HAS_DATABASE)('PredicateStore conformance — postgres', () => {
  for (const testCase of PREDICATE_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await inRollback(async (tx) => {
        const fixtures = await seedPredicateFixtures(tx);
        await testCase.run(createPostgresPredicateStore(tx), fixtures);
      });
    });
  }
});

describe.skipIf(!HAS_DATABASE)('the SQL normalizer agrees with the TypeScript one', () => {
  // Everything that made `normalizePredicateName` the shape it is: separators,
  // repeats, edges, characters outside [a-z0-9_], and the empty result.
  const NAMES = [
    'Hourly Rate',
    'hourly-rate',
    'hourly.rate',
    '  Spaced   Out  ',
    'Price ($CAD)',
    '__weird__',
    'a--b',
    'dots...and---dashes',
    'MiXeD_CaSe',
    'trailing_',
    '_leading',
    '123 numbers',
    'ünïcode',
    'emoji 🎉 here',
    '!!!',
    '',
  ];

  it('produces the same string for every input, or the drift is a silent alias miss', async () => {
    await inRollback(async (tx) => {
      for (const name of NAMES) {
        const row = await tx.one<{ normalized: string }>(
          sql`select ${normalizePredicateNameSql(sql`${name}::text`)} as normalized`,
        );
        expect(row.normalized, `input: ${JSON.stringify(name)}`).toBe(
          normalizePredicateName(name),
        );
      }
    });
  });
});

describe.skipIf(!HAS_DATABASE)('what only the database can say', () => {
  it('never writes occurrences — the trigger recomputes it from the ledger', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedPredicateFixtures(tx);
      const store = createPostgresPredicateStore(tx);

      // A def asserting a total with no ledger rows to support it. The memory
      // store would store 99 verbatim; here the ledger is the truth.
      const written = await store.upsert(def({ occurrences: 99, distinctSources: [] }));
      expect(written.occurrences).toBe(0);

      await recordPredicateOccurrence('tmos_conf_live_rate', fixtures.sourceA, tx);
      await recordPredicateOccurrence('tmos_conf_live_rate', fixtures.sourceA, tx);
      await recordPredicateOccurrence('tmos_conf_live_rate', fixtures.sourceB, tx);

      const read = await store.get('tmos_conf_live_rate');
      expect(read?.occurrences).toBe(3);
      expect([...(read?.distinctSources ?? [])].sort()).toEqual(
        [fixtures.sourceA, fixtures.sourceB].sort(),
      );

      // And the per-source counts are what `recordPredicateOccurrence` said,
      // because that path carries the source the port drops.
      const rows = await tx.query<{ source_id: string; count: number }>(sql`
        select source_id::text as source_id, "count" from predicate_occurrence
         where predicate = 'tmos_conf_live_rate' order by "count" desc`);
      expect(rows.map((r) => Number(r.count))).toEqual([2, 1]);
    });
  });

  it('rejects an occurrence from a source that does not exist', async () => {
    await inRollback(async (tx) => {
      const store = createPostgresPredicateStore(tx);
      await store.upsert(def());

      await expect(
        recordPredicateOccurrence(
          'tmos_conf_live_rate',
          '00000000-0000-4000-8000-000000000000',
          tx,
        ),
      ).rejects.toBeInstanceOf(MissingReferenceError);
    });
  });

  it('reads the subjective column added by 007, defaulting to false', async () => {
    await inRollback(async (tx) => {
      const store = createPostgresPredicateStore(tx);
      await store.upsert(def({ subjective: true }));
      expect((await store.get('tmos_conf_live_rate'))?.subjective).toBe(true);

      await tx.execute(sql`
        insert into predicate_def (predicate, entity_type, datatype, description)
        values ('tmos_conf_live_raw', 'company', 'text', 'inserted without the column')`);
      expect((await store.get('tmos_conf_live_raw'))?.subjective).toBe(false);
    });
  });
});
