/**
 * The Postgres `DecisionStore`, without Postgres.
 *
 * What can be proven with no connection is narrow but not small: that values
 * reach `values` and never the query text, that a row shaped the way
 * node-postgres actually hands one back — `bigint` as a STRING, `timestamptz`
 * as a `Date`, `jsonb` already parsed — decodes into a `DecisionRecord`, that
 * the bigint boundary refuses rather than rounds, and that the two CHECK
 * constraints come back as the domain's own `Rejection` rather than as a
 * SQLSTATE.
 *
 * What CANNOT be proven here is that Postgres accepts any of these statements.
 * That is `decision-store.live.test.ts`, and it is skipping.
 */
import { describe, expect, it } from 'vitest';
import type { Executor, QueryRow, SqlQuery } from '@tmos/db';
import type { DecisionRecord } from '@tmos/contracts';

import { ConstraintError, DecodeError, MissingReferenceError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  DecisionRejectedError,
  allDecisions,
  createPostgresDecisionStore,
  createPostgresWriteDeps,
  decisionById,
  predictionFactsFor,
  putDecision,
  rowToDecisionRecord,
} from './decision-store.js';

const OPEN = '11111111-1111-4111-8111-111111111111';
const BELIEF = '55555555-5555-4555-8555-555555555555';
const DECIDED_AT = '2026-08-01T00:00:00.000Z';

/** Shaped the way node-postgres really answers: int8 → string, timestamptz → Date. */
const cannedRow = (over: Partial<QueryRow> = {}): QueryRow => ({
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
  prediction_ids: [OPEN],
  kill_criteria: [{ metric: 'reply_rate', threshold: 0.02, by: '2027-03-01' }],
  expected_cost_cents: '250000',
  decided_at: new Date(DECIDED_AT),
  decided_by: 'human:nishant',
  outcome: null,
  has_outcome: false,
  ...over,
});

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
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
  predictions: [OPEN],
  kill_criteria: [{ metric: 'reply_rate', threshold: 0.02, by: '2027-03-01' }],
  expected_cost_cents: 250_000,
  decided_at: DECIDED_AT,
  decided_by: 'human:nishant',
  outcome: null,
  ...over,
});

/** A duck-typed `pg` error, thrown from `execute`. `errors.ts` never imports pg. */
const pgError = (code: string, constraint?: string): Error =>
  Object.assign(new Error(`new row violates check constraint "${constraint ?? '?'}"`), {
    code,
    constraint,
    table: 'decision_record',
  });

function throwingExecutor(error: unknown): Executor {
  const boom = async (_q: SqlQuery): Promise<never> => {
    throw error;
  };
  return {
    query: boom,
    one: boom,
    maybeOne: boom,
    execute: boom,
  };
}

describe('put', () => {
  it('sends every value as a parameter and never as text', async () => {
    const ex = recordingExecutor();
    await putDecision(record(), ex);

    const q = ex.last();
    expect(q.text).not.toContain('DEC-9999-001');
    expect(q.text).not.toContain('human:nishant');
    expect(q.values).toContain('DEC-9999-001');
    expect(q.values).toContain('human:nishant');
    // `prediction_ids` goes in as a JS array against `::uuid[]`, never spliced.
    expect(q.values).toContainEqual([OPEN]);
    expect(q.text).toContain('::uuid[]');
  });

  it('stringifies the jsonb columns and leaves a null outcome as SQL NULL', async () => {
    const ex = recordingExecutor();
    await putDecision(record(), ex);

    const q = ex.last();
    expect(q.values).toContain(
      JSON.stringify([
        { option: 'Do nothing', why_rejected: 'the list decays either way' },
        { option: 'Buy a paid test', why_rejected: 'costs more than the answer' },
      ]),
    );
    // Not the string 'null' — the jsonb document `null` is not "no outcome".
    expect(q.values).toContain(null);
  });

  it('sends expected_cost_cents as a decimal string, not as a JS number', async () => {
    const ex = recordingExecutor();
    await putDecision(record({ expected_cost_cents: 9_007_199_254_740_991 }), ex);

    expect(ex.last().values).toContain('9007199254740991');
    expect(ex.last().text).toContain('::bigint');
  });

  it('refuses an unsafe expected_cost_cents BEFORE touching the database', async () => {
    const ex = recordingExecutor();
    // Unreachable through writeDecision — Zod v4 bounds `.int()` to safe
    // integers — but the port takes a DecisionRecord a caller can hand-build.
    // 2^53 is exactly representable AND unsafe: MAX_SAFE_INTEGER is 2^53 − 1,
    // and one past it is the first integer with a second float64 spelling.
    await expect(
      putDecision(record({ expected_cost_cents: 2 ** 53 }), ex),
    ).rejects.toBeInstanceOf(ConstraintError);
    expect(ex.queries).toHaveLength(0);
  });

  it('upserts, so recordDecisionOutcome can write the whole record back', async () => {
    const ex = recordingExecutor();
    await putDecision(record(), ex);
    expect(ex.last().text).toContain('on conflict (id) do update set');
    expect(ex.last().text).toContain('outcome             = excluded.outcome');
  });
});

describe('the two CHECK constraints become the domain rejection', () => {
  it('decision_needs_prediction is a `schema` rejection worded exactly as Zod words it', async () => {
    const ex = throwingExecutor(pgError('23514', 'decision_needs_prediction'));

    const error = await putDecision(record({ predictions: [] }), ex).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionRejectedError);
    const rejected = error as DecisionRejectedError;
    expect(rejected.rejection.code).toBe('schema');
    expect(rejected.rejection.detail).toContain(
      'predictions: Too small: expected array to have >=1 items',
    );
    // The hole 010 closed, named in the error so nobody re-derives it.
    expect(rejected.rejection.detail).toContain('array_length of an empty array is NULL');
  });

  it('decision_needs_alternatives is a `schema` rejection too', async () => {
    const ex = throwingExecutor(pgError('23514', 'decision_needs_alternatives'));

    const error = await putDecision(record(), ex).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionRejectedError);
    expect((error as DecisionRejectedError).rejection.detail).toContain(
      'alternatives: Too small: expected array to have >=2 items',
    );
  });

  it('leaves any OTHER constraint to the generic taxonomy', async () => {
    const ex = throwingExecutor(pgError('23514', 'decision_record_status_check'));
    await expect(putDecision(record(), ex)).rejects.toBeInstanceOf(ConstraintError);

    const fk = throwingExecutor(pgError('23503', 'something_fkey'));
    await expect(putDecision(record(), fk)).rejects.toBeInstanceOf(MissingReferenceError);
  });
});

describe('rowToDecisionRecord', () => {
  it('decodes a row the way node-postgres really hands one back', () => {
    expect(rowToDecisionRecord(cannedRow())).toEqual(record());
  });

  it('renames prediction_ids to predictions and nothing else', () => {
    const decoded = rowToDecisionRecord(cannedRow({ prediction_ids: [OPEN, BELIEF] }));
    expect(decoded.predictions).toEqual([OPEN, BELIEF]);
    expect(decoded.beliefs_relied_on).toEqual([BELIEF]);
  });

  it('keeps a bigint at the top of the safe range EXACTLY', () => {
    const decoded = rowToDecisionRecord(cannedRow({ expected_cost_cents: '9007199254740991' }));
    expect(decoded.expected_cost_cents).toBe(9_007_199_254_740_991);
  });

  it('REFUSES a bigint past the safe range instead of silently rounding it', () => {
    // Number('9007199254740993') is 9007199254740992 — a wrong answer, quietly,
    // in a money column. `pg/values.ts`'s asNumber would return it.
    expect(Number('9007199254740993')).toBe(9_007_199_254_740_992);
    expect(() => rowToDecisionRecord(cannedRow({ expected_cost_cents: '9007199254740993' }))).toThrow(
      DecodeError,
    );
    expect(() => rowToDecisionRecord(cannedRow({ expected_cost_cents: '9007199254740993' }))).toThrow(
      /outside the safe integer range/,
    );
  });

  it('refuses a bigint column that is not an integer at all', () => {
    expect(() => rowToDecisionRecord(cannedRow({ expected_cost_cents: '2.5e6' }))).toThrow(
      DecodeError,
    );
  });

  it('reads an outcome, and distinguishes SQL NULL from the jsonb document null', () => {
    const outcome = { result: 'bad', luck_attribution: 'luck', notes: 'timing' };
    expect(rowToDecisionRecord(cannedRow({ outcome, has_outcome: true })).outcome).toEqual(outcome);

    // `'null'::jsonb IS NOT NULL` is true, and node-postgres parses it to JS
    // null. Without `has_outcome` the two are indistinguishable.
    expect(() => rowToDecisionRecord(cannedRow({ outcome: null, has_outcome: true }))).toThrow(
      /jsonb document/,
    );
  });

  it('refuses a row the contract would not accept — including a pre-010 empty array', () => {
    expect(() => rowToDecisionRecord(cannedRow({ prediction_ids: [] }))).toThrow(DecodeError);
    expect(() => rowToDecisionRecord(cannedRow({ status: 'archived' }))).toThrow(DecodeError);
    expect(() => rowToDecisionRecord(cannedRow({ alternatives: [{ option: 'a', why_rejected: 'b' }] }))).toThrow(
      DecodeError,
    );
  });
});

describe('reads', () => {
  it('looks a decision up by its text primary key — no uuid guard, no crash', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    expect((await decisionById('DEC-9999-001', ex))?.id).toBe('DEC-9999-001');
    expect(ex.last().values).toEqual(['DEC-9999-001']);

    // A malformed id is a MISS. `decision_record.id` is text, so there is no
    // 22P02 to guard against and every string is a legal lookup key.
    const miss = recordingExecutor([[]]);
    expect(await decisionById('not-a-decision-id', miss)).toBeNull();
    expect(miss.queries).toHaveLength(1);
  });

  it('orders all() deterministically, since the table has no insertion counter', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await allDecisions(ex);
    expect(ex.last().text).toContain('order by decided_at, id');
  });
});

describe('predictionFactsFor', () => {
  it('reads the prediction table and reports what writeDecision needs', async () => {
    const ex = recordingExecutor([[{ created_at: new Date(DECIDED_AT), resolved: false }]]);

    expect(await predictionFactsFor(OPEN, ex)).toEqual({
      exists: true,
      resolved: false,
      recordedAt: DECIDED_AT,
    });
    expect(ex.last().text).toContain('from prediction');
    // Fails CLOSED: either marker means resolved.
    expect(ex.last().text).toContain('outcome is not null or resolved_at is not null');
  });

  it('is null for a prediction nothing holds, and for an id no prediction could have', async () => {
    const ex = recordingExecutor([[]]);
    expect(await predictionFactsFor(OPEN, ex)).toBeNull();

    const guarded = recordingExecutor();
    expect(await predictionFactsFor('pred_1', guarded)).toBeNull();
    expect(guarded.queries).toHaveLength(0);
  });
});

describe('the factories', () => {
  it('bind the port and take `now` from the caller, never from the clock', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    const store = createPostgresDecisionStore(ex);
    expect((await store.get('DEC-9999-001'))?.id).toBe('DEC-9999-001');

    const deps = createPostgresWriteDeps('2026-08-02T00:00:00.000Z', ex);
    expect(deps.now).toBe('2026-08-02T00:00:00.000Z');
    expect(typeof deps.predictionFacts).toBe('function');
  });
});
