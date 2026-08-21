/**
 * `PredictionStore` against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://... pnpm test:live
 *
 * Beyond the shared conformance array, five things cannot be checked anywhere
 * else, and each corresponds to a decision made in the adapter:
 *
 *   · `prediction.outcome` really is TEXT. The store hands back `0`; the column
 *     holds `'0'`. Nothing on the TypeScript side can tell the difference — the
 *     type says `0 | 1` either way — so this is the only place the mapping is
 *     actually verified rather than asserted against itself.
 *   · `prediction_due_idx` is partial, and exists for exactly one query. The
 *     plan for THAT query (not a hand-copied lookalike — the fragment itself)
 *     has to name it.
 *   · 012's `annul_reason` CHECK, 003's `author` and `p` CHECKs. The memory
 *     store has no constraints and accepts all of them.
 *   · `AUTHOR_RE` in `packages/intel` is STRICTER than the column's
 *     `~ '^(human|agent):'`. Which one actually gates a write depends on the
 *     path taken, and only the database can say what it will accept.
 *   · scores survive `numeric`.
 *
 * A raised constraint aborts the whole transaction — `@tmos/db` has no
 * savepoints — so every case that expects one raises it LAST.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { closePool, sql } from '@tmos/db';
import { AUTHOR_RE, type PredictionRecord, type Scores } from '@tmos/intel';

import { ConstraintError } from '../errors.js';
import { HAS_DATABASE, inRollback } from '../testing/live.js';
import {
  PREDICTION_STORE_CONFORMANCE,
  type PredictionStoreFixtures,
} from '../testing/prediction.conformance.js';
import {
  createPostgresPredictionStore,
  duePredictionsQuery,
  insertPrediction,
  predictionScores,
  resolvePrediction,
  unscoredPredictions,
  writePredictionScores,
} from './prediction-store.js';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

const FIXTURES: PredictionStoreFixtures = { newId: () => randomUUID() };

const AT = '2026-08-15T00:00:00.000Z';

const record = (over: Partial<PredictionRecord> = {}): PredictionRecord => ({
  id: randomUUID(),
  claim: 'Jiffy lists more than 40 Toronto categories on 2026-11-01',
  p: 0.65,
  author: 'agent:llama-3.3-70b@v1',
  created_at: '2026-07-01T00:00:00.000Z',
  resolve_at: '2026-11-01T00:00:00.000Z',
  resolver: {
    kind: 'scrape_assert',
    spec: 'count:Toronto >= 40',
    source_url: 'https://example.test/categories',
    fallback: 'annul',
  },
  evidence_snapshot_hash: 'a'.repeat(64),
  decision_id: null,
  belief_ids: [],
  outcome: null,
  observed: null,
  resolved_at: null,
  annul_reason: null,
  ...over,
});

describe.skipIf(!HAS_DATABASE)('PredictionStore conformance — postgres', () => {
  for (const testCase of PREDICTION_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await inRollback(async (tx) => {
        await testCase.run(createPostgresPredictionStore(tx), FIXTURES);
      });
    });
  }
});

describe.skipIf(!HAS_DATABASE)('what only the database can say', () => {
  it('stores outcome as TEXT and reads it back as a number', async () => {
    await inRollback(async (tx) => {
      const row = record();
      await insertPrediction(row, tx);
      await resolvePrediction(row.id, { outcome: 0, observed: 12, resolvedAt: AT }, tx);

      const raw = await tx.one<{ outcome: unknown; observed: unknown }>(
        sql`select outcome, observed from prediction where id = ${row.id}::uuid`,
      );
      expect(raw.outcome).toBe('0');
      expect(typeof raw.outcome).toBe('string');

      const read = await createPostgresPredictionStore(tx).all();
      const mine = read.find((r) => r.id === row.id);
      expect(mine?.outcome).toBe(0);
      expect(typeof mine?.outcome).toBe('number');
    });
  });

  it('due() can use prediction_due_idx — the partial index it was written for', async () => {
    await inRollback(async (tx) => {
      // Not proof that the planner WILL choose it on a large table; proof that
      // the query is eligible at all. A `coalesce` or a function on either side
      // makes a partial index unusable and this is where that shows up.
      await tx.execute(sql`set local enable_seqscan = off`);
      const plan = await tx.query<Record<string, unknown>>(
        sql`explain ${duePredictionsQuery(new Date(AT))}`,
      );
      const text = plan.map((r) => String(Object.values(r)[0])).join('\n');
      expect(text).toContain('prediction_due_idx');
    });
  });

  it('scores survive numeric, and an annulled prediction refuses one', async () => {
    await inRollback(async (tx) => {
      const scored = record();
      const annulled = record();
      await insertPrediction(scored, tx);
      await insertPrediction(annulled, tx);
      await resolvePrediction(scored.id, { outcome: 1, observed: 41, resolvedAt: AT }, tx);
      await resolvePrediction(
        annulled.id,
        { outcome: 'annulled', observed: null, resolvedAt: AT, annulReason: 'page moved' },
        tx,
      );

      expect((await unscoredPredictions(tx)).map((r) => r.id)).toContain(scored.id);
      expect((await unscoredPredictions(tx)).map((r) => r.id)).not.toContain(annulled.id);

      const scores: Scores = {
        brier: 0.1225,
        log: 0.35667494393873245,
        baseline: 0.485,
        peer: null,
      };
      await writePredictionScores(scored.id, scores, tx);
      expect(await predictionScores(scored.id, tx)).toEqual(scores);
      expect((await unscoredPredictions(tx)).map((r) => r.id)).not.toContain(scored.id);

      // No raise: the guard is in the WHERE clause, so this does not abort the
      // transaction — which is why the assertion below can follow it.
      await expect(writePredictionScores(annulled.id, scores, tx)).rejects.toThrow(/annulled/);
      expect(await predictionScores(annulled.id, tx)).toBeNull();
    });
  });

  it('accepts an author the DB check allows but AUTHOR_RE rejects — the gates differ', async () => {
    await inRollback(async (tx) => {
      // `^(human|agent):` is all the column requires. `validate()` in
      // packages/intel is far stricter, and it runs only on the writePrediction
      // path — a seed or a backfill that calls the store directly bypasses it.
      const loose = 'human:nishant kumar';
      expect(AUTHOR_RE.test(loose)).toBe(false);

      const row = record({ author: loose });
      await expect(insertPrediction(row, tx)).resolves.toBeUndefined();
    });
  });

  it('refuses an author the DB check rejects, which the memory store would accept', async () => {
    await inRollback(async (tx) => {
      await expect(insertPrediction(record({ author: 'bot:crawler' }), tx)).rejects.toThrow(
        ConstraintError,
      );
    });
  });

  it('refuses p outside [0.01, 0.99] — the clamp is in the schema, not only in code', async () => {
    await inRollback(async (tx) => {
      await expect(insertPrediction(record({ p: 1 }), tx)).rejects.toThrow(ConstraintError);
    });
  });

  it('refuses an annul_reason on a prediction that was not annulled (012)', async () => {
    await inRollback(async (tx) => {
      const row = record();
      await insertPrediction(row, tx);
      // The memory store stores the reason regardless of the outcome. This
      // raises, so nothing may follow it in this transaction.
      await expect(
        resolvePrediction(
          row.id,
          { outcome: 1, observed: 41, resolvedAt: AT, annulReason: 'not an annulment' },
          tx,
        ),
      ).rejects.toThrow(ConstraintError);
    });
  });
});
