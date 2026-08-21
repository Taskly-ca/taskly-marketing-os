/**
 * `DecisionStore` against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://... pnpm test:live
 *
 * Every case runs inside a transaction that is rolled back, so a full run leaves
 * the database at the row count it started with — the same discipline the
 * migrations were applied with.
 *
 * THE FIRST BLOCK IS THE POINT: the identical conformance array that
 * `testing/decide.conformance.test.ts` runs against `createMemoryDecisionStore`.
 * Anything that passes there and fails here is a place the port has two
 * meanings.
 *
 * The blocks after it are what only a real database can answer: the two CHECK
 * constraints (which the memory store, being a `Map`, cannot have), the bigint
 * that JavaScript cannot hold, and the ordering `decision_record` has no
 * insertion counter to provide.
 *
 * FIXTURE SEEDING LIVES HERE, not in `testing/live.ts`, only because that file
 * belongs to whoever wires the barrel and this lane may not edit it.
 * `seedDecisionFixtures` should move next to `seedFactFixtures` at integration.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, sql, withTx, type Executor } from '@tmos/db';
import type { DecisionRecord } from '@tmos/contracts';

import { DecodeError } from '../errors.js';
import {
  DECIDED_AT,
  DECISION_STORE_CONFORMANCE,
  type DecisionStoreFixtures,
} from '../testing/decide.conformance.js';
import { HAS_DATABASE, inRollback } from '../testing/live.js';
import {
  DecisionRejectedError,
  allDecisions,
  createPostgresDecisionStore,
  decisionById,
  predictionFactsFor,
  putDecision,
} from './decision-store.js';

const CONF = 'tmos_conf';
const BELIEF = '55555555-5555-4555-8555-555555555555';
const BEFORE = '2026-07-20T00:00:00.000Z';
const AFTER = '2026-08-01T12:00:00.000Z';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

/**
 * `prediction` has no foreign keys at all — `decision_id` is text with no FK
 * (012: the cycle is real and the missing constraint is the correct resolution
 * of it), and `belief_ids` is a bare `uuid[]`. So a prediction row can be
 * written on its own, which is the whole reason the ordering rule has to be
 * enforced in the application.
 */
async function insertPrediction(
  tx: Executor,
  name: string,
  createdAt: string,
  resolved: boolean,
): Promise<string> {
  const resolver = JSON.stringify({
    kind: 'manual',
    spec: 'ask the operator list',
    source_url: 'https://example.test/conformance',
    fallback: 'annul',
  });

  const row = await tx.one<{ id: string }>(sql`
    insert into prediction (
      claim, p, author, created_at, resolve_at, resolver, evidence_snapshot_hash,
      outcome, resolved_at
    ) values (
      ${`${CONF}: reply rate exceeds 4% by 2027-01-01 (${name})`},
      0.6, ${`human:${CONF}`},
      ${createdAt}::timestamptz, '2027-01-01T00:00:00.000Z'::timestamptz,
      ${resolver}::jsonb, ${`${CONF}-snapshot`},
      ${resolved ? '1' : null}, ${resolved ? createdAt : null}::timestamptz
    )
    returning id::text as id`);
  return row.id;
}

async function seedDecisionFixtures(tx: Executor): Promise<DecisionStoreFixtures> {
  // Sequential, not `Promise.all`: a transaction is ONE connection.
  const openA = await insertPrediction(tx, 'open_a', BEFORE, false);
  const openB = await insertPrediction(tx, 'open_b', BEFORE, false);
  const resolvedId = await insertPrediction(tx, 'resolved', BEFORE, true);
  const lateId = await insertPrediction(tx, 'late', AFTER, false);

  return {
    openPredictionIds: [openA, openB],
    resolvedPredictionId: resolvedId,
    latePredictionId: lateId,
    beliefIds: [BELIEF],
    predictionFacts: (id) => predictionFactsFor(id, tx),
  };
}

const record = (fx: DecisionStoreFixtures, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: 'DEC-9999-001',
  status: 'proposed',
  door: 'two_way',
  context: 'The operator list has stopped replying.',
  decision: 'Ship a weekly digest',
  alternatives: [
    { option: 'Do nothing', why_rejected: 'the list decays either way' },
    { option: 'Buy a paid test', why_rejected: 'costs more than the answer' },
  ],
  beliefs_relied_on: [BELIEF],
  predictions: [fx.openPredictionIds[0]],
  kill_criteria: [{ metric: 'reply_rate', threshold: 0.02, by: '2027-03-01' }],
  expected_cost_cents: 250_000,
  decided_at: DECIDED_AT,
  decided_by: `human:${CONF}`,
  outcome: null,
  ...over,
});

describe.skipIf(!HAS_DATABASE)('DecisionStore conformance — postgres', () => {
  for (const testCase of DECISION_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await inRollback(async (tx) => {
        const fixtures = await seedDecisionFixtures(tx);
        await testCase.run(createPostgresDecisionStore(tx), fixtures);
      });
    });
  }
});

describe.skipIf(!HAS_DATABASE)('what only the database can say', () => {
  it('enlists in the ambient transaction, and disappears when it rolls back', async () => {
    // Built with NO executor: it resolves `db()` per call, which inside withTx
    // is the transaction. If it captured the pool instead, this row would
    // survive the rollback — the bug the lazy resolution prevents.
    const id = await inRollback(async (tx) => {
      const fixtures = await seedDecisionFixtures(tx);
      const store = createPostgresDecisionStore();
      await store.put(record(fixtures));
      expect(await store.get('DEC-9999-001')).not.toBeNull();
      return 'DEC-9999-001';
    });

    expect(await decisionById(id)).toBeNull();
  });

  it('orders all() by decided_at, which the memory store does not do at all', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedDecisionFixtures(tx);
      const store = createPostgresDecisionStore(tx);

      await store.put(record(fixtures, { id: 'DEC-9999-002', decided_at: '2026-08-05T00:00:00.000Z' }));
      await store.put(record(fixtures, { id: 'DEC-9999-003', decided_at: '2026-07-01T00:00:00.000Z' }));

      const mine = (await allDecisions(tx))
        .map((r) => r.id)
        .filter((id) => id.startsWith('DEC-9999-'));
      // Written 002 then 003; read back 003 then 002. `createMemoryDecisionStore`
      // returns Map insertion order and would answer the other way round.
      expect(mine).toEqual(['DEC-9999-003', 'DEC-9999-002']);
    });
  });

  it('refuses a decision with no predictions — the hole migration 010 closed', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedDecisionFixtures(tx);

      // Pre-010 this insert SUCCEEDED: array_length('{}', 1) is NULL, NULL >= 1
      // is NULL, and a CHECK evaluating to NULL passes. The memory store still
      // accepts it, which is why this case cannot live in the conformance array.
      //
      // LAST statement in this transaction on purpose: a raised exception aborts
      // it, and `@tmos/db` has no savepoints.
      const error = await putDecision(record(fixtures, { predictions: [] }), tx).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DecisionRejectedError);
      expect((error as DecisionRejectedError).rejection.code).toBe('schema');
      expect((error as DecisionRejectedError).rejection.detail).toContain('predictions:');
    });
  });

  it('refuses a decision with one alternative — that is not a decision, it is a plan', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedDecisionFixtures(tx);

      const error = await putDecision(
        record(fixtures, {
          alternatives: [{ option: 'Do nothing', why_rejected: 'the list decays either way' }],
        }),
        tx,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DecisionRejectedError);
      expect((error as DecisionRejectedError).rejection.detail).toContain('alternatives:');
    });
  });

  it('refuses to READ a bigint that JavaScript cannot hold, rather than rounding it', async () => {
    await inRollback(async (tx) => {
      // Written in SQL, not through the port: `expected_cost_cents` is a JS
      // number in the contract, so a value this wide cannot be expressed as an
      // argument. It can still arrive from a backfill or another writer.
      await tx.execute(sql`
        insert into decision_record (
          id, status, door, context, decision, alternatives, prediction_ids,
          kill_criteria, expected_cost_cents, decided_at, decided_by
        ) values (
          'DEC-9999-800', 'proposed', 'one_way', 'wide', 'wider',
          '[{"option":"a","why_rejected":"x"},{"option":"b","why_rejected":"y"}]'::jsonb,
          array['11111111-1111-4111-8111-111111111111'::uuid],
          '[{"metric":"m","threshold":1,"by":"2027-03-01"}]'::jsonb,
          9007199254740993, ${DECIDED_AT}::timestamptz, ${`human:${CONF}`}
        )`);

      const raw = await tx.one<{ n: string }>(
        sql`select expected_cost_cents::text as n from decision_record where id = 'DEC-9999-800'`,
      );
      expect(raw.n).toBe('9007199254740993'); // bigint is exact, and stays exact
      expect(Number(raw.n)).toBe(9_007_199_254_740_992); // and Number() is not

      await expect(decisionById('DEC-9999-800', tx)).rejects.toBeInstanceOf(DecodeError);
    });
  });

  it('reports a resolved prediction as resolved, which is what refuses the write', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedDecisionFixtures(tx);

      expect(await predictionFactsFor(fixtures.resolvedPredictionId, tx)).toEqual({
        exists: true,
        resolved: true,
        recordedAt: BEFORE,
      });
      expect(await predictionFactsFor(fixtures.openPredictionIds[0], tx)).toEqual({
        exists: true,
        resolved: false,
        recordedAt: BEFORE,
      });
      expect(await predictionFactsFor('00000000-0000-4000-8000-000000000000', tx)).toBeNull();
    });
  });
});

describe.skipIf(!HAS_DATABASE)('the harness itself', () => {
  it('leaves nothing behind — the seeded predictions are gone after a rollback', async () => {
    const id = await inRollback(async (tx) => (await seedDecisionFixtures(tx)).openPredictionIds[0]);

    const alive = await withTx(async (tx) =>
      tx.maybeOne(sql`select id::text as id from prediction where id = ${id}::uuid`),
    );
    expect(alive).toBeNull();
  });
});
