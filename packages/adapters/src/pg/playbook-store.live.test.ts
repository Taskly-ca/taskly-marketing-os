/**
 * `PlaybookRunStore` and the `playbook` repository against the real database.
 * Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://... pnpm test:live
 *
 * Every case runs inside a transaction that is rolled back. The first block is
 * the identical conformance array `testing/decide.conformance.test.ts` runs
 * against `createMemoryRunStore`; the blocks after it are what only a real
 * database can answer — the two CHECK constraints 012 added, the composite
 * foreign key, and the append-only primary key on `playbook`.
 *
 * FIXTURE SEEDING LIVES HERE rather than in `testing/live.ts` only because that
 * file belongs to whoever wires the barrel and this lane may not edit it.
 * `seedPlaybookRunFixtures` should move next to `seedFactFixtures` at
 * integration.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, sql, withTx, type Executor } from '@tmos/db';

import { AppendOnlyError, MissingReferenceError } from '../errors.js';
import {
  MEASURED_AT,
  PLAYBOOK_RUN_CONFORMANCE,
  RUN_A,
  RUN_B,
  STARTED_AT,
  conformancePlaybook,
  type PlaybookRunFixtures,
} from '../testing/decide.conformance.js';
import { HAS_DATABASE, inRollback } from '../testing/live.js';
import {
  RunRejectedError,
  createPostgresPlaybookRunStore,
  currentPlaybook,
  insertPlaybookVersion,
  playbookRunById,
  playbookVersions,
  putPlaybookRun,
} from './playbook-store.js';
import type { LedgerRun } from '@tmos/decide';

const DIGEST = 'pb_tmos_conf_digest';
const OTHER = 'pb_tmos_conf_other';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

/**
 * `playbook_run` has a composite foreign key on `(playbook_id,
 * playbook_version)`, so the playbook rows the memory store never needed have to
 * exist before a single run can be written. All of them vanish with the
 * rollback.
 */
async function seedPlaybookRunFixtures(tx: Executor): Promise<PlaybookRunFixtures> {
  // Sequential, not `Promise.all`: a transaction is ONE connection.
  const playbook = await insertPlaybookVersion(conformancePlaybook(DIGEST, 3), tx);
  const otherPlaybook = await insertPlaybookVersion(conformancePlaybook(OTHER, 1), tx);
  return { playbook, otherPlaybook };
}

const run = (fx: PlaybookRunFixtures, over: Partial<LedgerRun> = {}): LedgerRun => ({
  run_id: RUN_A,
  playbook_id: fx.playbook.id,
  playbook_version: fx.playbook.version,
  situation_snapshot: { region: 'ca' },
  params_bound: { budget_cents: 250_000 },
  prediction: { metric: 'reply_rate', point: 4, ci80: [1, 8], recorded_at: STARTED_AT },
  falsifier: {
    metric: 'reply_rate',
    direction: 'up',
    expected_effect: [2, 6],
    horizon_days: 30,
    min_n: 40,
    due_at: '2026-08-31T00:00:00.000Z',
  },
  started_at: STARTED_AT,
  outcome: null,
  lessons: [],
  supersedes: null,
  correction_reason: null,
  ...over,
});

const OUTCOME: NonNullable<LedgerRun['outcome']> = {
  metric_actual: 4,
  n: 50,
  classification: 'win',
  verdict: 'win',
  measured_at: MEASURED_AT,
  confounds: [],
  forced: null,
};

describe.skipIf(!HAS_DATABASE)('PlaybookRunStore conformance — postgres', () => {
  for (const testCase of PLAYBOOK_RUN_CONFORMANCE) {
    it(testCase.name, async () => {
      await inRollback(async (tx) => {
        const fixtures = await seedPlaybookRunFixtures(tx);
        await testCase.run(createPostgresPlaybookRunStore(tx), fixtures);
      });
    });
  }
});

describe.skipIf(!HAS_DATABASE)('what only the database can say', () => {
  it('enlists in the ambient transaction, and disappears when it rolls back', async () => {
    const runId = await inRollback(async (tx) => {
      const fixtures = await seedPlaybookRunFixtures(tx);
      // No executor: `db()` is resolved per call, which inside withTx is the
      // transaction. Capturing the pool at construction would leak this row.
      const store = createPostgresPlaybookRunStore();
      await store.put(run(fixtures));
      expect(await store.get(RUN_A)).not.toBeNull();
      return RUN_A;
    });

    expect(await playbookRunById(runId)).toBeNull();
  });

  it('refuses an outcome on a run that recorded no prediction', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedPlaybookRunFixtures(tx);

      // 012's `playbook_run_outcome_needs_prediction`. The memory store accepts
      // this row — it is a Map — which is why the case cannot be shared.
      //
      // LAST statement in this transaction: a raised exception aborts it.
      const error = await putPlaybookRun(
        run(fixtures, { prediction: null, falsifier: null, outcome: OUTCOME }),
        tx,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RunRejectedError);
      expect((error as RunRejectedError).rejection.code).toBe('prediction_missing');
    });
  });

  it('accepts an imported run with no prediction and no outcome — the rule is the ORDER', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedPlaybookRunFixtures(tx);
      await putPlaybookRun(run(fixtures, { prediction: null, falsifier: null }), tx);

      const read = await playbookRunById(RUN_A, tx);
      expect(read?.prediction).toBeNull();
      expect(read?.outcome).toBeNull();
    });
  });

  it('refuses a correction with no reason', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedPlaybookRunFixtures(tx);
      await putPlaybookRun(run(fixtures), tx);

      const error = await putPlaybookRun(
        run(fixtures, { run_id: RUN_B, supersedes: RUN_A, correction_reason: null }),
        tx,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RunRejectedError);
      expect((error as RunRejectedError).rejection.code).toBe('correction_needs_reason');
    });
  });

  it('refuses a run against a playbook version that does not exist', async () => {
    await inRollback(async (tx) => {
      const fixtures = await seedPlaybookRunFixtures(tx);

      // The composite FK. The ledger has no rejection code for this — `startRun`
      // is handed a whole Playbook object and never doubts it — so it stays a
      // MissingReferenceError from the generic taxonomy.
      await expect(
        putPlaybookRun(run(fixtures, { playbook_version: 99 }), tx),
      ).rejects.toBeInstanceOf(MissingReferenceError);
    });
  });

  it('reads the current playbook version, and lists every version oldest first', async () => {
    await inRollback(async (tx) => {
      await insertPlaybookVersion(conformancePlaybook(DIGEST, 1), tx);
      await insertPlaybookVersion(conformancePlaybook(DIGEST, 2), tx);
      await insertPlaybookVersion(conformancePlaybook(DIGEST, 3), tx);

      expect((await currentPlaybook(DIGEST, tx))?.version).toBe(3);
      expect((await playbookVersions(DIGEST, tx)).map((p) => p.version)).toEqual([1, 2, 3]);
      expect(await currentPlaybook('pb_tmos_conf_nothing', tx)).toBeNull();
      expect(await playbookVersions('pb_tmos_conf_nothing', tx)).toEqual([]);
    });
  });

  it('refuses to rewrite a shipped playbook version', async () => {
    await inRollback(async (tx) => {
      await insertPlaybookVersion(conformancePlaybook(DIGEST, 3), tx);

      await expect(
        insertPlaybookVersion({ ...conformancePlaybook(DIGEST, 3), title: 'rewritten' }, tx),
      ).rejects.toBeInstanceOf(AppendOnlyError);
    });
  });
});

describe.skipIf(!HAS_DATABASE)('the harness itself', () => {
  it('leaves nothing behind — the seeded playbooks are gone after a rollback', async () => {
    await inRollback(async (tx) => seedPlaybookRunFixtures(tx));

    const alive = await withTx(async (tx) =>
      tx.maybeOne(sql`select id from playbook where id = ${DIGEST}`),
    );
    expect(alive).toBeNull();
  });
});
