/**
 * `FactStore` against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://... pnpm test:live
 *
 * Every case runs inside a transaction that is rolled back, so a full run
 * leaves the database at the row count it started with — the same discipline
 * the migrations were applied with.
 *
 * THE FIRST BLOCK IS THE POINT: the identical conformance array that
 * `memory-conformance.test.ts` runs against `createMemoryFactStore`. Anything
 * that passes there and fails here is a place the port has two meanings, which
 * is exactly the class of defect that survived 1,131 passing tests until a
 * database existed and `closeValid` turned out to be impossible.
 *
 * The blocks after it are what only a real database can answer: a trigger that
 * has no in-memory equivalent, a foreign key, and the two places Postgres
 * narrows a value that JavaScript does not.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, sql, withTx } from '@tmos/db';

import { MissingReferenceError, EmptyRangeError, AppendOnlyError } from '../errors.js';
import { FACT_STORE_CONFORMANCE } from '../testing/fact-store.conformance.js';
import { HAS_DATABASE, inRollback, seedFactFixtures } from '../testing/live.js';
import { createPostgresFactStore, factById, insertFact } from './fact-store.js';

const T0 = '2026-07-01T00:00:00.000Z';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

describe.skipIf(!HAS_DATABASE)('FactStore conformance — postgres', () => {
  for (const testCase of FACT_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await inRollback(async (tx) => {
        const fixtures = await seedFactFixtures(tx);
        await testCase.run(createPostgresFactStore(tx), fixtures);
      });
    });
  }
});

describe.skipIf(!HAS_DATABASE)('what only the database can say', () => {
  it('enlists in the ambient transaction, and disappears when it rolls back', async () => {
    // Built with NO executor: it resolves `db()` per call, which inside withTx
    // is the transaction. If it captured the pool instead, this row would
    // survive the rollback — which is the bug the lazy resolution prevents.
    const factId = await inRollback(async (tx) => {
      const fixtures = await seedFactFixtures(tx);
      const store = createPostgresFactStore();
      const row = await store.insert({
        entityId: fixtures.entityId,
        predicate: fixtures.predicate,
        value: { datatype: 'num', num: 9900 },
        valid: { from: T0, to: null },
        asserted: { from: T0, to: null },
        sourceId: fixtures.sourceId,
        observedAt: T0,
        confidence: 0.9,
        method: 'scrape',
        evidence: {},
        supersedes: null,
        status: 'active',
      });
      expect(await store.byId(row.factId)).not.toBeNull();
      return row.factId;
    });

    expect(await factById(factId)).toBeNull();
  });

  it('rejects closing a bound at the instant it opened — the frozen-clock trap', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedFactFixtures(tx);
      const store = createPostgresFactStore(tx);

      // `now()` inside a transaction. Every statement in this block sees the
      // same instant, which is precisely how a worker asserts a fact and closes
      // it in one unit of work and ends up with an empty range.
      const { now } = await tx.one<{ now: string }>(sql`select now()::text as now`);
      const at = new Date(now).toISOString();

      const row = await store.insert({
        entityId: fixtures.entityId,
        predicate: fixtures.predicate,
        value: { datatype: 'num', num: 9900 },
        valid: { from: at, to: null },
        asserted: { from: at, to: null },
        sourceId: fixtures.sourceId,
        observedAt: at,
        confidence: 0.5,
        method: 'scrape',
        evidence: {},
        supersedes: null,
        status: 'active',
      });

      await expect(store.closeAsserted(row.factId, at)).rejects.toBeInstanceOf(EmptyRangeError);

      // A millisecond later is a real interval, and is accepted. The adapter
      // guards this in the WHERE clause, so the failure above did NOT poison
      // the transaction — this statement still runs.
      const later = new Date(new Date(at).getTime() + 1).toISOString();
      await store.closeAsserted(row.factId, later);
      expect((await store.byId(row.factId))?.asserted.to).toBe(later);
    });
  });

  it('refuses to re-close valid, which the in-memory store silently allows', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedFactFixtures(tx);
      const store = createPostgresFactStore(tx);

      const row = await store.insert({
        entityId: fixtures.entityId,
        predicate: fixtures.predicate,
        value: { datatype: 'num', num: 9900 },
        valid: { from: T0, to: null },
        asserted: { from: T0, to: null },
        sourceId: fixtures.sourceId,
        observedAt: T0,
        confidence: 0.5,
        method: 'scrape',
        evidence: {},
        supersedes: null,
        status: 'active',
      });

      await store.closeValid(row.factId, '2026-07-15T00:00:00.000Z');
      // Migration 009: infinite → finite, once. The memory store would move it.
      await expect(
        store.closeValid(row.factId, '2026-08-01T00:00:00.000Z'),
      ).rejects.toBeInstanceOf(AppendOnlyError);
    });
  });

  it('narrows confidence to float4 — `real` keeps about seven digits', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedFactFixtures(tx);
      const store = createPostgresFactStore(tx);

      const row = await store.insert({
        entityId: fixtures.entityId,
        predicate: fixtures.predicate,
        value: { datatype: 'num', num: 9900 },
        valid: { from: T0, to: null },
        asserted: { from: T0, to: null },
        sourceId: fixtures.sourceId,
        observedAt: T0,
        // `fact.confidence` is `real`: 24 bits of mantissa. The memory store
        // keeps every bit of a float64 and this cannot.
        confidence: 0.123456789,
        method: 'scrape',
        evidence: {},
        supersedes: null,
        status: 'active',
      });

      expect(row.confidence).not.toBe(0.123456789);
      expect(row.confidence).toBeCloseTo(0.123456789, 6);
    });
  });

  it('truncates a numeric wider than float64 on the way OUT, not in the database', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedFactFixtures(tx);
      const wide = '12345678901234567890.5';

      // Written in SQL rather than through the port: `FactValue.num` is a JS
      // number, so a value this wide cannot be expressed as an argument. It can
      // still arrive from a backfill, another writer, or a migration.
      const inserted = await tx.one<{ fact_id: string }>(sql`
        insert into fact (
          entity_id, predicate, object_num, valid, asserted,
          source_id, observed_at, confidence, method
        ) values (
          ${fixtures.entityId}::uuid, ${fixtures.predicate}, ${wide}::numeric,
          tstzrange(${T0}::timestamptz, null), tstzrange(${T0}::timestamptz, null),
          ${fixtures.sourceId}::uuid, ${T0}::timestamptz, 0.5, 'scrape'
        ) returning fact_id::text as fact_id`);

      const raw = await tx.one<{ n: string }>(
        sql`select object_num::text as n from fact where fact_id = ${inserted.fact_id}::uuid`,
      );
      expect(raw.n).toBe(wide); // numeric is exact, and stays exact

      const read = await factById(inserted.fact_id, tx);
      const value = read?.value;
      expect(value?.datatype).toBe('num');
      const num = value?.datatype === 'num' ? value.num : Number.NaN;

      expect(num).toBe(Number(raw.n)); // the adapter loses exactly what Number() loses
      expect(String(num)).not.toBe(raw.n); // and it is a different value now
    });
  });

  it('turns a foreign key violation into MissingReferenceError, not a raw pg error', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedFactFixtures(tx);

      // LAST statement in this transaction on purpose: a raised exception
      // aborts it, and `@tmos/db` has no savepoints.
      await expect(
        insertFact(
          {
            entityId: fixtures.entityId,
            predicate: fixtures.predicate,
            value: { datatype: 'num', num: 1 },
            valid: { from: T0, to: null },
            asserted: { from: T0, to: null },
            sourceId: '00000000-0000-4000-8000-000000000000',
            observedAt: T0,
            confidence: 0.5,
            method: 'scrape',
            evidence: {},
            supersedes: null,
            status: 'active',
          },
          tx,
        ),
      ).rejects.toBeInstanceOf(MissingReferenceError);
    });
  });

  it('never issues a DELETE — 009 blocks them outright, retraction is a status', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedFactFixtures(tx);
      const store = createPostgresFactStore(tx);
      const row = await store.insert({
        entityId: fixtures.entityId,
        predicate: fixtures.predicate,
        value: { datatype: 'text', text: 'gone' },
        valid: { from: T0, to: null },
        asserted: { from: T0, to: null },
        sourceId: fixtures.sourceId,
        observedAt: T0,
        confidence: 0.5,
        method: 'scrape',
        evidence: {},
        supersedes: null,
        status: 'active',
      });

      await store.setStatus(row.factId, 'retracted');
      expect((await store.byId(row.factId))?.status).toBe('retracted');

      // The row is still there, and still readable. That is the whole argument.
      const count = await tx.one<{ n: string }>(
        sql`select count(*)::text as n from fact where fact_id = ${row.factId}::uuid`,
      );
      expect(count.n).toBe('1');
    });
  });
});

describe.skipIf(!HAS_DATABASE)('the harness itself', () => {
  it('leaves nothing behind — the fixtures are gone after a rollback', async () => {
    const entityId = await inRollback(async (tx) => (await seedFactFixtures(tx)).entityId);

    const alive = await withTx(async (tx) =>
      tx.maybeOne(sql`select id::text as id from entity where id = ${entityId}::uuid`),
    );
    expect(alive).toBeNull();
  });
});
