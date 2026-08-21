/**
 * `LabelStore` against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://... pnpm test:live
 *
 * Every case runs inside a transaction that is rolled back, so a full run
 * leaves `er_label` at the row count it started with — which matters more here
 * than anywhere else in this package, since `er_label` is the calibration set
 * and a stray row moves a threshold.
 *
 * THE FIRST BLOCK IS THE POINT: the identical array `er.conformance.test.ts`
 * runs against `createMemoryLabelStore`. The second block is what only a real
 * database can answer — that 006's expression index exists and refuses a second
 * row for the same unordered pair, which is the constraint the memory store
 * simulates by using a `Map` and can therefore never disprove.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, sql, withTx, type Executor } from '@tmos/db';

import { LABEL_STORE_CONFORMANCE, type ErLabelFixtures } from '../testing/er.conformance.js';
import { HAS_DATABASE, inRollback } from '../testing/live.js';
import { insertEntity } from './entity-directory.js';
import { createPostgresLabelStore, erLabelByPair, upsertErLabel } from './er-labels.js';

const CONF = 'tmos_conf';
const T0 = '2026-07-01T00:00:00.000Z';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

/**
 * `left_entity` and `right_entity` are foreign keys, so three real rows have to
 * exist before a single label can be written. Seeded through this package's own
 * `insertEntity` rather than raw SQL: if entity creation is broken, every
 * labelling case failing at the fixture is the honest signal.
 */
async function seedEntities(tx: Executor): Promise<ErLabelFixtures> {
  const a = await insertEntity({ entityType: 'company', name: `${CONF} Label A`, region: 'ca' }, tx);
  const b = await insertEntity({ entityType: 'company', name: `${CONF} Label B`, region: 'ca' }, tx);
  const c = await insertEntity({ entityType: 'company', name: `${CONF} Label C`, region: 'ca' }, tx);
  return { entityA: a.entityId, entityB: b.entityId, entityC: c.entityId };
}

const label = (left: string, right: string, over: Record<string, unknown> = {}) => ({
  leftEntity: left,
  rightEntity: right,
  score: 0.875,
  llmVerdict: 'match',
  llmRationale: 'same registrable domain',
  humanVerdict: 'match' as const,
  decidedBy: 'reviewer@taskly.ca',
  decidedAt: T0,
  ...over,
});

describe.skipIf(!HAS_DATABASE)('LabelStore conformance — postgres', () => {
  for (const testCase of LABEL_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await inRollback(async (tx) => {
        const fixtures = await seedEntities(tx);
        await testCase.run(createPostgresLabelStore(tx), fixtures);
      });
    });
  }
});

describe.skipIf(!HAS_DATABASE)('what only the database can say', () => {
  it('enlists in the ambient transaction, and disappears when it rolls back', async () => {
    // Built with NO executor: it resolves `db()` per call, which inside withTx
    // is the transaction. A store that captured the pool at construction would
    // leave this row behind — in the calibration set.
    const pair = await inRollback(async (tx) => {
      const fx = await seedEntities(tx);
      const store = createPostgresLabelStore();
      const stored = await store.add(label(fx.entityA, fx.entityB));
      expect(await store.byPair(fx.entityA, fx.entityB)).not.toBeNull();
      return [stored.leftEntity, stored.rightEntity] as const;
    });

    expect(await erLabelByPair(pair[0], pair[1])).toBeNull();
  });

  it('narrows score to float4 — `real` keeps about seven digits', async () => {
    await inRollback(async (tx) => {
      const fx = await seedEntities(tx);
      const stored = await upsertErLabel(label(fx.entityA, fx.entityB, { score: 0.123456789 }), tx);

      expect(stored.score).not.toBe(0.123456789);
      expect(stored.score).toBeCloseTo(0.123456789, 6);
    });
  });

  it('006 er_label_pair_uidx really refuses a second row for the reversed pair', async () => {
    await inRollback(async (tx) => {
      const fx = await seedEntities(tx);
      await upsertErLabel(label(fx.entityA, fx.entityB), tx);

      // Raw, bypassing the adapter's ON CONFLICT: this is the index itself
      // being tested, and it is the thing 006 was written to add. LAST
      // statement in this transaction — a raised exception aborts it and
      // `@tmos/db` has no savepoints.
      await expect(
        tx.execute(sql`
          insert into er_label (left_entity, right_entity, score, human_verdict, decided_by)
          values (${fx.entityB}::uuid, ${fx.entityA}::uuid, 0.1, 'no_match', 'someone')`),
      ).rejects.toThrow(/er_label_pair_uidx|duplicate key/i);
    });
  });

  it('006 er_label_not_self really refuses a pair labelled against itself', async () => {
    await inRollback(async (tx) => {
      const fx = await seedEntities(tx);

      await expect(
        tx.execute(sql`
          insert into er_label (left_entity, right_entity, score, human_verdict, decided_by)
          values (${fx.entityA}::uuid, ${fx.entityA}::uuid, 1.0, 'match', 'someone')`),
      ).rejects.toThrow(/er_label_not_self|violates check constraint/i);
    });
  });

  it('a re-label is one row in the table, not two — counted in SQL, not through the port', async () => {
    await inRollback(async (tx) => {
      const fx = await seedEntities(tx);
      await upsertErLabel(label(fx.entityA, fx.entityB, { humanVerdict: 'match' }), tx);
      await upsertErLabel(label(fx.entityB, fx.entityA, { humanVerdict: 'no_match' }), tx);

      const counted = await tx.one<{ n: string }>(sql`
        select count(*)::text as n from er_label
         where least(left_entity, right_entity) = least(${fx.entityA}::uuid, ${fx.entityB}::uuid)
           and greatest(left_entity, right_entity) = greatest(${fx.entityA}::uuid, ${fx.entityB}::uuid)`);

      expect(counted.n).toBe('1');
    });
  });

  it('the fixtures leave nothing behind', async () => {
    const entityA = await inRollback(async (tx) => (await seedEntities(tx)).entityA);

    const alive = await withTx(async (tx) =>
      tx.maybeOne(sql`select id::text as id from entity where id = ${entityA}::uuid`),
    );
    expect(alive).toBeNull();
  });
});
