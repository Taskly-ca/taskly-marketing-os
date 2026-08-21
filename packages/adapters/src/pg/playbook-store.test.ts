/**
 * The Postgres `PlaybookRunStore` and the `playbook` repository, without
 * Postgres.
 *
 * The three things worth pinning down here all come from migration 012: that a
 * run with no prediction is a legal row and decodes as `null` rather than
 * throwing, that the CHECK which replaced `not null` comes back as the LEDGER's
 * own `prediction_missing` rather than a SQLSTATE, and that `falsifier` —
 * added by 012 because the copy was previously made and thrown away — actually
 * round-trips.
 *
 * What CANNOT be proven here is that Postgres accepts any of these statements.
 * That is `playbook-store.live.test.ts`, and it is skipping.
 */
import { describe, expect, it } from 'vitest';
import type { Executor, QueryRow, SqlQuery } from '@tmos/db';

import { AppendOnlyError, DecodeError, MissingReferenceError } from '../errors.js';
import { conformancePlaybook } from '../testing/decide.conformance.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  RunRejectedError,
  allPlaybookRuns,
  createPostgresPlaybookRunStore,
  currentPlaybook,
  insertPlaybookVersion,
  playbookRunById,
  playbookRunsByPlaybook,
  playbookVersions,
  putPlaybookRun,
  rowToLedgerRun,
  rowToPlaybook,
} from './playbook-store.js';

const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STARTED_AT = '2026-08-01T00:00:00.000Z';
const PLAYBOOK = conformancePlaybook('pb_tmos_conf_digest', 3);

const cannedRun = (over: Partial<QueryRow> = {}): QueryRow => ({
  run_id: RUN_A,
  playbook_id: PLAYBOOK.id,
  playbook_version: 3,
  situation_snapshot: { region: 'ca', list_age_days: 400 },
  params_bound: { budget_cents: 250_000 },
  prediction: { metric: 'reply_rate', point: 4, ci80: [1, 8], recorded_at: STARTED_AT },
  has_prediction: true,
  falsifier: {
    metric: 'reply_rate',
    direction: 'up',
    expected_effect: [2, 6],
    horizon_days: 30,
    min_n: 40,
    due_at: '2026-08-31T00:00:00.000Z',
  },
  has_falsifier: true,
  started_at: new Date(STARTED_AT),
  outcome: null,
  has_outcome: false,
  lessons: [],
  supersedes: null,
  correction_reason: null,
  ...over,
});

const cannedPlaybookRow = (over: Partial<QueryRow> = {}): QueryRow => ({
  ...PLAYBOOK,
  ...over,
});

const pgError = (code: string, constraint?: string): Error =>
  Object.assign(new Error(`violates constraint "${constraint ?? '?'}"`), {
    code,
    constraint,
    table: 'playbook_run',
  });

function throwingExecutor(error: unknown): Executor {
  const boom = async (_q: SqlQuery): Promise<never> => {
    throw error;
  };
  return { query: boom, one: boom, maybeOne: boom, execute: boom };
}

describe('put', () => {
  it('sends every value as a parameter and never as text', async () => {
    const ex = recordingExecutor();
    await putPlaybookRun(rowToLedgerRun(cannedRun()), ex);

    const q = ex.last();
    expect(q.text).not.toContain(RUN_A);
    expect(q.text).not.toContain('pb_tmos_conf_digest');
    expect(q.values).toContain(RUN_A);
    expect(q.values).toContain('pb_tmos_conf_digest');
    expect(q.text).toContain('::uuid');
  });

  it('writes SQL NULL for an absent prediction, not the jsonb document null', async () => {
    const ex = recordingExecutor();
    await putPlaybookRun(rowToLedgerRun(cannedRun({ prediction: null, has_prediction: false })), ex);

    // 012 dropped NOT NULL for exactly this row: an imported run may lack a
    // prediction. A run with an OUTCOME may not, and that is the CHECK.
    expect(ex.last().values).toContain(null);
    expect(ex.last().values).not.toContain('null');
  });

  it('upserts, so recordRunOutcome can write the whole run back', async () => {
    const ex = recordingExecutor();
    await putPlaybookRun(rowToLedgerRun(cannedRun()), ex);
    expect(ex.last().text).toContain('on conflict (run_id) do update set');
    expect(ex.last().text).toContain('falsifier          = excluded.falsifier');
  });
});

describe("012's two CHECK constraints become the ledger's own rejections", () => {
  it('outcome-without-prediction is `prediction_missing`, worded as recordRunOutcome words it', async () => {
    const ex = throwingExecutor(pgError('23514', 'playbook_run_outcome_needs_prediction'));

    const error = await putPlaybookRun(rowToLedgerRun(cannedRun()), ex).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunRejectedError);
    const rejected = error as RunRejectedError;
    expect(rejected.rejection.code).toBe('prediction_missing');
    expect(rejected.rejection.detail).toContain(`run ${RUN_A} recorded no prediction`);
    expect(rejected.rejection.detail).toContain('nothing to score against');
  });

  it('supersedes-without-a-reason is `correction_needs_reason`, worded as correctRun words it', async () => {
    const ex = throwingExecutor(pgError('23514', 'playbook_run_correction_needs_reason'));

    const error = await putPlaybookRun(rowToLedgerRun(cannedRun()), ex).catch((e: unknown) => e);
    expect((error as RunRejectedError).rejection.code).toBe('correction_needs_reason');
    expect((error as RunRejectedError).rejection.detail).toContain(
      'a correction without a reason is a rewrite',
    );
  });

  it('leaves the composite FK as MissingReferenceError — the ledger has no word for it', async () => {
    const ex = throwingExecutor(pgError('23503', 'playbook_run_playbook_id_fkey'));
    await expect(putPlaybookRun(rowToLedgerRun(cannedRun()), ex)).rejects.toBeInstanceOf(
      MissingReferenceError,
    );
  });
});

describe('rowToLedgerRun', () => {
  it('decodes a row the way node-postgres really hands one back', () => {
    const run = rowToLedgerRun(cannedRun());

    expect(run.run_id).toBe(RUN_A);
    expect(run.playbook_version).toBe(3);
    // snake_case in TypeScript, deliberately. Nothing is camelCased here.
    expect(run.situation_snapshot).toEqual({ region: 'ca', list_age_days: 400 });
    expect(run.prediction).toEqual({
      metric: 'reply_rate',
      point: 4,
      ci80: [1, 8],
      recorded_at: STARTED_AT,
    });
    expect(run.falsifier?.expected_effect).toEqual([2, 6]);
    expect(run.falsifier?.due_at).toBe('2026-08-31T00:00:00.000Z');
    expect(run.outcome).toBeNull();
  });

  it('reads an absent prediction and falsifier as null, and a present one as itself', () => {
    const imported = rowToLedgerRun(
      cannedRun({ prediction: null, has_prediction: false, falsifier: null, has_falsifier: false }),
    );
    expect(imported.prediction).toBeNull();
    expect(imported.falsifier).toBeNull();
  });

  it('distinguishes SQL NULL from the jsonb document null, which the CHECK reads as PRESENT', () => {
    expect(() => rowToLedgerRun(cannedRun({ prediction: null, has_prediction: true }))).toThrow(
      /jsonb document/,
    );
  });

  it('decodes the RICH outcome — classification, n and forced, not the contract projection', () => {
    const run = rowToLedgerRun(
      cannedRun({
        outcome: {
          metric_actual: 4.5,
          n: 12,
          classification: 'underpowered',
          verdict: 'inconclusive',
          measured_at: '2026-09-05T00:00:00.000Z',
          confounds: ['underpowered: n=12 < min_n=40'],
          forced: { reason: 'the quarter ends Friday', days_early: 3 },
        },
        has_outcome: true,
      }),
    );

    // `underpowered` has no seat in `playbookRunSchema`'s verdict enum, which is
    // why this column is read as `RunOutcome` and projected down by
    // `toPlaybookRun`, never parsed through the contract.
    expect(run.outcome?.classification).toBe('underpowered');
    expect(run.outcome?.verdict).toBe('inconclusive');
    expect(run.outcome?.forced).toEqual({ reason: 'the quarter ends Friday', days_early: 3 });
  });

  it('refuses a classification or a verdict outside the union', () => {
    const bad = (outcome: Record<string, unknown>): QueryRow =>
      cannedRun({ outcome, has_outcome: true });
    const base = {
      metric_actual: 1,
      n: 50,
      classification: 'win',
      verdict: 'win',
      measured_at: '2026-09-05T00:00:00.000Z',
      confounds: [],
      forced: null,
    };
    expect(() => rowToLedgerRun(bad({ ...base, classification: 'great' }))).toThrow(DecodeError);
    expect(() => rowToLedgerRun(bad({ ...base, verdict: 'underpowered' }))).toThrow(DecodeError);
  });

  it('refuses a ci80 or expected_effect that is not a pair', () => {
    expect(() =>
      rowToLedgerRun(
        cannedRun({ prediction: { metric: 'reply_rate', point: 4, ci80: [1], recorded_at: STARTED_AT } }),
      ),
    ).toThrow(/expected a pair of numbers/);
  });

  it('decodes lessons, and treats a missing array as empty', () => {
    const run = rowToLedgerRun(
      cannedRun({ lessons: [{ kind: 'dont', text: 'do not read a 30-day hypothesis at day 3' }] }),
    );
    expect(run.lessons).toEqual([
      { kind: 'dont', text: 'do not read a 30-day hypothesis at day 3' },
    ]);
    expect(rowToLedgerRun(cannedRun({ lessons: null })).lessons).toEqual([]);
    expect(() => rowToLedgerRun(cannedRun({ lessons: [{ kind: 'maybe', text: 'x' }] }))).toThrow(
      DecodeError,
    );
  });
});

describe('reads', () => {
  it('treats a non-uuid run id as a miss, without issuing a query', async () => {
    const ex = recordingExecutor();
    expect(await playbookRunById('run_1', ex)).toBeNull();
    expect(ex.queries).toHaveLength(0);
  });

  it('orders byPlaybook and all the way createMemoryRunStore sorts', async () => {
    const byPlaybook = recordingExecutor([[cannedRun()]]);
    await playbookRunsByPlaybook(PLAYBOOK.id, byPlaybook);
    expect(byPlaybook.last().text).toContain('order by started_at, run_id');
    expect(byPlaybook.last().values).toEqual([PLAYBOOK.id]);

    const all = recordingExecutor([[cannedRun()]]);
    await allPlaybookRuns(all);
    expect(all.last().text).toContain('order by started_at, run_id');
  });

  it('binds the port through the factory', async () => {
    const ex = recordingExecutor([[cannedRun({ run_id: RUN_B })]]);
    const store = createPostgresPlaybookRunStore(ex);
    expect((await store.get(RUN_B))?.run_id).toBe(RUN_B);
  });
});

describe('playbook — the table with no port', () => {
  it('appends a version and never upserts one', async () => {
    const ex = recordingExecutor([[cannedPlaybookRow()]]);
    const stored = await insertPlaybookVersion(PLAYBOOK, ex);

    expect(stored).toEqual(PLAYBOOK);
    // Append-only by primary key: `(id, version)`, a shipped version never mutates.
    expect(ex.last().text).not.toContain('on conflict');
    expect(ex.last().values).toContain('pb_tmos_conf_digest');
    expect(ex.last().values).toContain(3);
  });

  it('turns a duplicate (id, version) into AppendOnlyError, not a bare unique violation', async () => {
    const ex = throwingExecutor(pgError('23505', 'playbook_pkey'));

    const error = await insertPlaybookVersion(PLAYBOOK, ex).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppendOnlyError);
    expect((error as Error).message).toContain('a shipped version never mutates');
  });

  it('reads the current version as the highest one, retired included', async () => {
    const ex = recordingExecutor([[cannedPlaybookRow({ status: 'retired' })]]);
    const current = await currentPlaybook('pb_tmos_conf_digest', ex);

    expect(current?.status).toBe('retired');
    expect(ex.last().text).toContain('order by version desc');
    expect(ex.last().text).toContain('limit 1');
  });

  it('lists versions oldest first', async () => {
    const ex = recordingExecutor([[cannedPlaybookRow({ version: 1 }), cannedPlaybookRow()]]);
    expect((await playbookVersions('pb_tmos_conf_digest', ex)).map((p) => p.version)).toEqual([1, 3]);
    expect(ex.last().text).toContain('order by version');
  });

  it('refuses a row the contract would not accept', () => {
    expect(() => rowToPlaybook(cannedPlaybookRow({ status: 'shipped' }))).toThrow(DecodeError);
    expect(() => rowToPlaybook(cannedPlaybookRow({ hypothesis: { metric: 'x' } }))).toThrow(
      DecodeError,
    );
  });
});
