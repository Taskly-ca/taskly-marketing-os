/**
 * The Postgres `LabelStore`, without Postgres.
 *
 * The one statement worth proving here is `add`'s conflict target. 006's
 * uniqueness is an index over an EXPRESSION, and an `on conflict` that does not
 * name the same expressions does not compile against it — so the assertion
 * below is not "the SQL looks right", it is the difference between a re-label
 * correcting a verdict and a re-label raising 23505 in production. Everything
 * else is the usual: values reach `values` and never the text, a malformed id
 * short-circuits instead of raising 22P02, and a row shaped the way
 * node-postgres really answers decodes into an `ErLabel`.
 */
import { describe, expect, it } from 'vitest';
import type { QueryRow } from '@tmos/db';
import type { ErLabelInput } from '@tmos/world';

import { ConstraintError, DecodeError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  allErLabels,
  createPostgresLabelStore,
  erLabelByPair,
  rowToErLabel,
  upsertErLabel,
} from './er-labels.js';

const LABEL = '99999999-9999-4999-8999-999999999999';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T0 = '2026-07-01T00:00:00.000Z';

/** `real` arrives as a number, `timestamptz` as a Date. */
const cannedRow = (over: Partial<QueryRow> = {}): QueryRow => ({
  id: LABEL,
  left_entity: A,
  right_entity: B,
  score: 0.875,
  llm_verdict: 'match',
  llm_rationale: 'same registrable domain',
  human_verdict: 'match',
  decided_by: 'reviewer@taskly.ca',
  decided_at: new Date(T0),
  ...over,
});

const draft = (over: Partial<ErLabelInput> = {}): ErLabelInput => ({
  leftEntity: A,
  rightEntity: B,
  score: 0.875,
  llmVerdict: 'match',
  llmRationale: 'same registrable domain',
  humanVerdict: 'match',
  decidedBy: 'reviewer@taskly.ca',
  decidedAt: T0,
  ...over,
});

describe('add', () => {
  it('targets the least/greatest EXPRESSION index, not a column list', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await upsertErLabel(draft(), ex);

    const { text } = ex.last();
    expect(text).toMatch(
      /on conflict \(least\(left_entity, right_entity\), greatest\(left_entity, right_entity\)\)/,
    );
    expect(text).toContain('do update set');
  });

  it('rewrites left_entity and right_entity from excluded, so a reversed re-label re-orients', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await upsertErLabel(draft(), ex);

    const { text } = ex.last();
    expect(text).toContain('left_entity   = excluded.left_entity');
    expect(text).toContain('right_entity  = excluded.right_entity');
    expect(text).toContain('human_verdict = excluded.human_verdict');
  });

  it('sends every value as a parameter and never as text', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await upsertErLabel(draft(), ex);

    const q = ex.last();
    expect(q.text).not.toContain(A);
    expect(q.text).not.toContain('reviewer@taskly.ca');
    expect(q.values).toContain(A);
    expect(q.values).toContain(B);
    expect(q.values).toContain(0.875);
    expect(q.values).toContain('reviewer@taskly.ca');
  });

  it('takes decidedAt from the caller and never reads the clock', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await upsertErLabel(draft(), ex);

    expect(ex.last().text).not.toContain('now()');
    expect(ex.last().values).toContain(T0);
  });

  it('refuses a self-pair BEFORE issuing a statement — 006 rejects it, memory accepts it', async () => {
    const ex = recordingExecutor([[cannedRow()]]);

    await expect(upsertErLabel(draft({ rightEntity: A }), ex)).rejects.toBeInstanceOf(
      ConstraintError,
    );
    await expect(upsertErLabel(draft({ rightEntity: A.toUpperCase() }), ex)).rejects.toThrow(
      /er_label_not_self/,
    );
    // Nothing ran: a raised exception would abort the caller's whole transaction.
    expect(ex.queries).toHaveLength(0);
  });

  it('refuses a non-uuid entity id before issuing a statement', async () => {
    const ex = recordingExecutor([[cannedRow()]]);

    await expect(upsertErLabel(draft({ leftEntity: 'ent_1' }), ex)).rejects.toBeInstanceOf(
      ConstraintError,
    );
    expect(ex.queries).toHaveLength(0);
  });
});

describe('byPair', () => {
  it('matches on least/greatest, so the index serves it whichever way round it is asked', async () => {
    const ex = recordingExecutor([[cannedRow()], [cannedRow()]]);

    await erLabelByPair(A, B, ex);
    const forward = ex.last();
    await erLabelByPair(B, A, ex);
    const reverse = ex.last();

    expect(forward.text).toContain('least(left_entity, right_entity) = least(');
    expect(forward.text).toContain('greatest(left_entity, right_entity) = greatest(');
    expect(forward.text).toBe(reverse.text);
  });

  it('returns null for a malformed id without issuing a statement', async () => {
    const ex = recordingExecutor();

    expect(await erLabelByPair('erl_1', B, ex)).toBeNull();
    expect(await erLabelByPair(A, 'erl_1', ex)).toBeNull();
    expect(ex.queries).toHaveLength(0);
  });

  it('returns null when the pair has never been labelled', async () => {
    expect(await erLabelByPair(A, B, recordingExecutor([[]]))).toBeNull();
  });
});

describe('all', () => {
  it('orders by decided_at then id, and reads every row back', async () => {
    const ex = recordingExecutor([[cannedRow(), cannedRow({ id: A, decided_by: 'other' })]]);
    const rows = await allErLabels(ex);

    expect(ex.last().text).toContain('order by decided_at, id');
    expect(rows.map((r) => r.decidedBy)).toEqual(['reviewer@taskly.ca', 'other']);
  });
});

describe('decoding', () => {
  it('decodes the projection the way node-postgres really answers it', () => {
    expect(rowToErLabel(cannedRow())).toEqual({
      id: LABEL,
      leftEntity: A,
      rightEntity: B,
      score: 0.875,
      llmVerdict: 'match',
      llmRationale: 'same registrable domain',
      humanVerdict: 'match',
      decidedBy: 'reviewer@taskly.ca',
      decidedAt: T0,
    });
  });

  it('keeps the nullable llm columns null', () => {
    const row = rowToErLabel(cannedRow({ llm_verdict: null, llm_rationale: null }));
    expect(row.llmVerdict).toBeNull();
    expect(row.llmRationale).toBeNull();
  });

  it('refuses a human_verdict outside the union rather than casting it', () => {
    expect(() => rowToErLabel(cannedRow({ human_verdict: 'maybe' }))).toThrow(DecodeError);
  });
});

describe('createPostgresLabelStore', () => {
  it('binds the port to the executor it was given', async () => {
    const ex = recordingExecutor([[cannedRow()], [cannedRow()], [cannedRow()]]);
    const store = createPostgresLabelStore(ex);

    await store.add(draft());
    await store.byPair(A, B);
    await store.all();

    expect(ex.queries).toHaveLength(3);
    expect(ex.queries[0]?.text).toContain('insert into er_label');
    expect(ex.queries[2]?.text).toContain('order by decided_at, id');
  });
});
