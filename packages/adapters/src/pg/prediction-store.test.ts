/**
 * The `PredictionStore` adapter, with no database.
 *
 * What this can prove: the outcome mapping in both directions (the one that
 * would otherwise be silent), that values reach `values` rather than the query
 * text, that `due()` keeps the shape `prediction_due_idx` needs, that the
 * guarded statements guard in the WHERE clause and only then diagnose, and that
 * a malformed id never reaches the driver at all.
 *
 * What it cannot prove: that Postgres accepts any of it. That is the live suite.
 */
import { describe, expect, it } from 'vitest';

import type { PredictionRecord, Scores } from '@tmos/intel';

import { ConstraintError, DecodeError, NotFoundError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  allPredictions,
  duePredictionsQuery,
  insertPrediction,
  outcomeFromColumn,
  outcomeToColumn,
  predictionScores,
  resolvePrediction,
  rowToPrediction,
  unscoredPredictions,
  writePredictionScores,
} from './prediction-store.js';

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-08-15T00:00:00.000Z';

/** The `insert` column list, in order. `values[OUTCOME]` is what 012 is about. */
const OUTCOME = 10;

const record = (over: Partial<PredictionRecord> = {}): PredictionRecord => ({
  id: ID,
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

/** A row shaped the way node-postgres actually delivers one: `numeric` as a
 *  string, `timestamptz` as a Date, `outcome` as text. */
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID,
  claim: 'Jiffy lists more than 40 Toronto categories on 2026-11-01',
  p: '0.65',
  author: 'agent:llama-3.3-70b@v1',
  created_at: new Date('2026-07-01T00:00:00.000Z'),
  resolve_at: new Date('2026-11-01T00:00:00.000Z'),
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

describe('the outcome mapping — migration 012, executable', () => {
  it('writes 0 → "0", 1 → "1", "annulled" → "annulled", null → NULL', () => {
    expect(outcomeToColumn(0)).toBe('0');
    expect(outcomeToColumn(1)).toBe('1');
    expect(outcomeToColumn('annulled')).toBe('annulled');
    expect(outcomeToColumn(null)).toBeNull();
  });

  it('reads them back as NUMBERS, not as the strings on disk', () => {
    expect(outcomeFromColumn('0')).toBe(0);
    expect(outcomeFromColumn('1')).toBe(1);
    expect(outcomeFromColumn('annulled')).toBe('annulled');
    expect(outcomeFromColumn(null)).toBeNull();

    // The failure this whole mapping exists to prevent: `'0'` is truthy, so a
    // prediction that resolved FALSE would read as one that resolved TRUE.
    expect(typeof outcomeFromColumn('0')).toBe('number');
    expect(outcomeFromColumn('0')).not.toBe('0');
    expect(Boolean(outcomeFromColumn('0'))).toBe(false);
  });

  it('round-trips all four states through both directions unchanged', () => {
    for (const state of [0, 1, 'annulled', null] as const) {
      expect(outcomeFromColumn(outcomeToColumn(state))).toBe(state);
    }
  });

  it('refuses a value the CHECK constraint could not have produced', () => {
    expect(() => outcomeFromColumn('2')).toThrow(DecodeError);
    expect(() => outcomeFromColumn('true')).toThrow(/not one of 0 \| 1 \| annulled/);
  });
});

describe('decoding a row the driver actually returns', () => {
  it('coerces numeric-as-string, timestamptz-as-Date and outcome-as-text', () => {
    const decoded = rowToPrediction(
      row({ outcome: '0', observed: { count: 12 }, resolved_at: new Date(AT) }),
    );

    expect(decoded.p).toBe(0.65);
    expect(decoded.created_at).toBe('2026-07-01T00:00:00.000Z');
    expect(decoded.outcome).toBe(0);
    expect(decoded.resolved_at).toBe(AT);
    expect(decoded.observed).toEqual({ count: 12 });
  });

  it('refuses a resolver column that is not a ResolverSpec, rather than executing it', () => {
    expect(() => rowToPrediction(row({ resolver: { kind: 'shell', spec: 'rm -rf /' } }))).toThrow(
      DecodeError,
    );
  });

  it('reads a NULL observed as null, never as undefined', () => {
    expect(rowToPrediction(row()).observed).toBeNull();
  });
});

describe('insert', () => {
  it('sends the outcome as text and every value as a parameter', async () => {
    for (const [state, column] of [
      [0, '0'],
      [1, '1'],
      ['annulled', 'annulled'],
      [null, null],
    ] as const) {
      const ex = recordingExecutor([[{ inserted: true }]]);
      await insertPrediction(
        record({ outcome: state, resolved_at: state === null ? null : AT }),
        ex,
      );

      expect(ex.last().values[OUTCOME]).toBe(column);
      // The claim is a value, not text spliced into the statement.
      expect(ex.last().text).not.toContain('Jiffy');
    }
  });

  it('conflicts on the primary key instead of raising — a raise would abort the batch', async () => {
    const ex = recordingExecutor([[]]);
    await expect(insertPrediction(record(), ex)).rejects.toThrow(`duplicate prediction id: ${ID}`);
    expect(ex.last().text).toContain('on conflict (id) do nothing');
  });

  it('refuses a non-uuid id before anything reaches the driver', async () => {
    const ex = recordingExecutor();
    await expect(insertPrediction(record({ id: 'pred_000001' }), ex)).rejects.toThrow(
      ConstraintError,
    );
    expect(ex.queries).toHaveLength(0);
  });

  it('serializes an undefined observation to NULL rather than to the string "undefined"', async () => {
    const ex = recordingExecutor([[{ inserted: true }]]);
    await insertPrediction(record({ observed: undefined }), ex);
    expect(ex.last().values[OUTCOME + 1]).toBeNull();
  });
});

describe('due', () => {
  it('keeps the exact shape prediction_due_idx needs', () => {
    const q = duePredictionsQuery(new Date(AT));

    // The index is `on prediction (resolve_at) where outcome is null`. The
    // planner only considers a partial index when the WHERE implies its
    // predicate literally, and only uses the column when it is compared bare.
    expect(q.text).toContain('outcome is null');
    expect(q.text).toContain('resolve_at <= $1::timestamptz');
    expect(q.text).not.toMatch(/coalesce\s*\(\s*outcome/i);
  });

  it('takes the instant from the caller — the adapter never reads the clock', () => {
    expect(duePredictionsQuery(new Date(AT)).values).toEqual([AT]);
  });
});

describe('resolve', () => {
  it('guards "outcome is null" in the WHERE clause and asks nothing else when it lands', async () => {
    const ex = recordingExecutor([[{ updated: true }]]);
    await resolvePrediction(ID, { outcome: 0, observed: 3, resolvedAt: AT }, ex);

    expect(ex.queries).toHaveLength(1);
    expect(ex.last().text).toContain('outcome is null');
    expect(ex.last().values[0]).toBe('0');
  });

  it('is idempotent: zero rows plus an existing row is a silent no-op', async () => {
    const ex = recordingExecutor([[], [{ outcome: '1' }]]);
    await expect(
      resolvePrediction(ID, { outcome: 0, observed: 3, resolvedAt: AT }, ex),
    ).resolves.toBeUndefined();
    expect(ex.queries).toHaveLength(2);
  });

  it('is refused for a prediction that does not exist, in the memory store’s words', async () => {
    const ex = recordingExecutor([[], []]);
    await expect(
      resolvePrediction(ID, { outcome: 1, observed: null, resolvedAt: AT }, ex),
    ).rejects.toThrow(`unknown prediction: ${ID}`);
  });

  it('treats a non-uuid id as a miss, without a statement', async () => {
    const ex = recordingExecutor();
    await expect(
      resolvePrediction('pred_000001', { outcome: 1, observed: null, resolvedAt: AT }, ex),
    ).rejects.toThrow(NotFoundError);
    expect(ex.queries).toHaveLength(0);
  });

  it('carries the annulment reason, which 012 added a column for', async () => {
    const ex = recordingExecutor([[{ updated: true }]]);
    await resolvePrediction(
      ID,
      { outcome: 'annulled', observed: null, resolvedAt: AT, annulReason: 'source moved' },
      ex,
    );
    expect(ex.last().values).toContain('source moved');
  });
});

describe('scores — the write path the port does not have', () => {
  const scores: Scores = { brier: 0.1225, log: 0.3567, baseline: 0.485, peer: null };

  it('writes all four columns, guarded to a prediction that actually resolved', async () => {
    const ex = recordingExecutor([[{ updated: true }]]);
    await writePredictionScores(ID, scores, ex);

    expect(ex.last().text).toContain("outcome in ('0','1')");
    expect(ex.last().text).toContain('log_score');
    expect(ex.last().values.slice(0, 4)).toEqual([0.1225, 0.3567, 0.485, null]);
  });

  it('refuses to score an annulled prediction — it carries no score and no penalty', async () => {
    const ex = recordingExecutor([[], [{ outcome: 'annulled' }]]);
    await expect(writePredictionScores(ID, scores, ex)).rejects.toThrow(/annulled/);
  });

  it('refuses to score an unresolved prediction', async () => {
    const ex = recordingExecutor([[], [{ outcome: null }]]);
    await expect(writePredictionScores(ID, scores, ex)).rejects.toThrow(/unresolved/);
  });

  it('refuses a non-finite score before it reaches numeric, which has no infinity', async () => {
    const ex = recordingExecutor();
    await expect(
      writePredictionScores(ID, { ...scores, log: Number.POSITIVE_INFINITY }, ex),
    ).rejects.toThrow(/finite/);
    expect(ex.queries).toHaveLength(0);
  });

  it('reads scores back into the shape scoring.ts produces (log_score → log)', async () => {
    const ex = recordingExecutor([
      [{ brier: '0.1225', log_score: '0.3567', baseline: '0.485', peer: null }],
    ]);
    expect(await predictionScores(ID, ex)).toEqual(scores);
  });

  it('reports an unscored prediction as null rather than as zeros', async () => {
    const ex = recordingExecutor([[{ brier: null, log_score: null, baseline: null, peer: null }]]);
    expect(await predictionScores(ID, ex)).toBeNull();
  });

  it('lists resolved-but-unscored predictions, excluding annulled ones', async () => {
    const ex = recordingExecutor([[row({ outcome: '1' })]]);
    const rows = await unscoredPredictions(ex);

    expect(rows[0]?.outcome).toBe(1);
    expect(ex.last().text).toContain("outcome in ('0','1')");
    expect(ex.last().text).toContain('brier is null');
  });
});

describe('all', () => {
  it('orders by when the forecast was made, with the id as a tiebreak', async () => {
    const ex = recordingExecutor([[row(), row({ id: '22222222-2222-4222-8222-222222222222' })]]);
    expect((await allPredictions(ex)).map((r) => r.id)).toHaveLength(2);
    expect(ex.last().text).toContain('order by created_at, id');
  });
});
