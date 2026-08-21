/**
 * The Postgres `FactStore`, without Postgres.
 *
 * What can be proven with no connection is narrow but not small: that values
 * reach `values` and never the query text, that a malformed id short-circuits
 * instead of raising 22P02, that the closers guard their preconditions in the
 * WHERE clause (so a violation returns zero rows and leaves the transaction
 * usable) and then diagnose the failure into the same error the memory store
 * raises, and that a row shaped the way node-postgres actually hands one back —
 * `numeric` as a string, `timestamptz` as a Date, evidence in snake_case —
 * decodes into a `FactRow`.
 *
 * What CANNOT be proven here is that the statements are accepted by Postgres at
 * all. That is `fact-store.live.test.ts`, and it is skipping.
 */
import { describe, expect, it } from 'vitest';
import type { QueryRow } from '@tmos/db';
import type { FactRow } from '@tmos/world';

import { AppendOnlyError, EmptyRangeError, NotFoundError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  closeFactAsserted,
  closeFactValid,
  createPostgresFactStore,
  factById,
  factsForEntity,
  factsForPredicate,
  insertFact,
  setFactStatus,
} from './fact-store.js';

const FACT = '99999999-9999-4999-8999-999999999999';
const ENTITY = '11111111-1111-4111-8111-111111111111';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const T0 = '2026-07-01T00:00:00.000Z';
const T1 = '2026-07-15T00:00:00.000Z';

/** Shaped the way node-postgres really answers: numeric → string, timestamptz → Date. */
const cannedRow = (over: Partial<QueryRow> = {}): QueryRow => ({
  fact_id: FACT,
  entity_id: ENTITY,
  predicate: 'price_cents',
  object_text: null,
  object_num: '9900',
  object_entity: null,
  object_json: null,
  has_json: false,
  valid_from: new Date(T0),
  valid_to: null,
  asserted_from: new Date(T0),
  asserted_to: null,
  source_id: SOURCE,
  observed_at: new Date(T0),
  confidence: 0.9,
  method: 'scrape',
  evidence: { url: 'https://example.test/p', extractor_version: 'extract@3' },
  supersedes: null,
  status: 'active',
  ...over,
});

const draft = (over: Partial<Omit<FactRow, 'factId'>> = {}): Omit<FactRow, 'factId'> => ({
  entityId: ENTITY,
  predicate: 'price_cents',
  value: { datatype: 'num', num: 9900 },
  valid: { from: T0, to: null },
  asserted: { from: T0, to: null },
  sourceId: SOURCE,
  observedAt: T0,
  confidence: 0.9,
  method: 'scrape',
  evidence: { url: 'https://example.test/p', extractorVersion: 'extract@3' },
  supersedes: null,
  status: 'active',
  ...over,
});

describe('insert', () => {
  it('sends every value as a parameter and never as text', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await insertFact(draft(), ex);

    const q = ex.last();
    expect(q.text).toContain('insert into fact');
    expect(q.text).not.toContain(ENTITY);
    expect(q.text).not.toContain('9900');
    expect(q.values).toContain(ENTITY);
    expect(q.values).toContain(9900);
  });

  it('writes both ranges as tstzrange bounds, and asserted from the ROW, not now()', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await insertFact(draft({ asserted: { from: T0, to: null } }), ex);

    const q = ex.last();
    expect(q.text).toMatch(/tstzrange\(\$\d+::timestamptz, \$\d+::timestamptz\)/);
    expect(q.text).not.toContain('now()');
    expect(q.values).toContain(T0);
  });

  it('maps the value onto exactly one object_* column', async () => {
    const ex = recordingExecutor([[cannedRow()], [cannedRow()]]);

    await insertFact(draft({ value: { datatype: 'text', text: 'same-day' } }), ex);
    expect(ex.last().values).toContain('same-day');

    await insertFact(draft({ value: { datatype: 'json', json: { seats: 3 } } }), ex);
    expect(ex.last().values).toContain('{"seats":3}');
  });

  it('stores evidence in snake_case and reads it back in camelCase', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    const stored = await insertFact(draft(), ex);

    expect(ex.last().values).toContain(
      JSON.stringify({ url: 'https://example.test/p', extractor_version: 'extract@3' }),
    );
    expect(stored.evidence).toEqual({
      url: 'https://example.test/p',
      extractorVersion: 'extract@3',
    });
  });

  it('decodes the row postgres actually returns', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    const stored = await insertFact(draft(), ex);

    expect(stored).toEqual({ factId: FACT, ...draft() });
    expect(typeof stored.value).toBe('object');
    expect(stored.value).toEqual({ datatype: 'num', num: 9900 });
  });
});

describe('reads', () => {
  it('treats a malformed id as a miss, without touching the database', async () => {
    const ex = recordingExecutor();

    expect(await factById('fact_00000a', ex)).toBeNull();
    expect(await factsForEntity('not-a-uuid', ex)).toEqual([]);
    expect(await factsForPredicate('not-a-uuid', 'price_cents', ex)).toEqual([]);
    expect(ex.queries).toHaveLength(0);
  });

  it('orders by the asserted lower bound, with the id as a tiebreak', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await factsForPredicate(ENTITY, 'price_cents', ex);

    expect(ex.last().text).toContain('order by lower(asserted), fact_id');
    expect(ex.last().values).toEqual([ENTITY, 'price_cents']);
  });

  it('selects range BOUNDS, never the range itself — node-postgres cannot parse tstzrange', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await factById(FACT, ex);

    expect(ex.last().text).toContain('lower(valid) as valid_from');
    expect(ex.last().text).toContain('upper(asserted) as asserted_to');
  });
});

describe('closeAsserted / closeValid', () => {
  it('guards the preconditions in the WHERE clause, so a violation cannot raise', async () => {
    const ex = recordingExecutor([[{ fact_id: FACT }]]);
    await closeFactAsserted(FACT, T1, ex);

    const q = ex.last();
    expect(q.text).toContain('upper_inf(asserted)');
    expect(q.text).toContain('lower(asserted) < $');
    expect(ex.queries).toHaveLength(1);
  });

  it('reports a missing fact in the memory store’s words', async () => {
    const ex = recordingExecutor([[], []]);
    await expect(closeFactAsserted(FACT, T1, ex)).rejects.toThrow(
      new NotFoundError(`closeAsserted: no such fact ${FACT}`),
    );
  });

  it('refuses to re-close a closed bound', async () => {
    const ex = recordingExecutor([
      [],
      [{ valid_from: new Date(T0), valid_to: null, asserted_from: new Date(T0), asserted_to: new Date(T1) }],
    ]);

    const error = await closeFactAsserted(FACT, '2026-08-01T00:00:00.000Z', ex).catch((e) => e);
    expect(error).toBeInstanceOf(AppendOnlyError);
    expect(error.message).toBe(`closeAsserted: ${FACT} already closed at ${T1}`);
  });

  it('names the frozen clock when the close lands on the instant the range opened', async () => {
    const ex = recordingExecutor([
      [],
      [{ valid_from: new Date(T0), valid_to: null, asserted_from: new Date(T0), asserted_to: null }],
    ]);

    const error = await closeFactAsserted(FACT, T0, ex).catch((e) => e);
    expect(error).toBeInstanceOf(EmptyRangeError);
    expect(error.message).toContain('FROZEN');
    expect(error.message).toContain('withTx');
  });

  it('reports a valid close that precedes valid.from in the memory store’s words', async () => {
    const ex = recordingExecutor([
      [],
      [{ valid_from: new Date(T1), valid_to: null, asserted_from: new Date(T0), asserted_to: null }],
    ]);

    await expect(closeFactValid(FACT, T0, ex)).rejects.toThrow(
      `closeValid: ${T0} precedes valid.from ${T1}`,
    );
  });
});

describe('setStatus', () => {
  it('refuses a fact that is not there', async () => {
    const ex = recordingExecutor([[]]);
    await expect(setFactStatus(FACT, 'retracted', ex)).rejects.toThrow(
      `setStatus: no such fact ${FACT}`,
    );
  });

  it('updates only the status column', async () => {
    const ex = recordingExecutor([[{ fact_id: FACT }]]);
    await setFactStatus(FACT, 'disputed', ex);

    expect(ex.last().text).toContain('set status = $1');
    expect(ex.last().values).toEqual(['disputed', FACT]);
  });
});

describe('createPostgresFactStore', () => {
  it('resolves its executor per call, so it can be built before a transaction exists', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    const store = createPostgresFactStore(ex);

    expect(await store.byId(FACT)).not.toBeNull();
    expect(ex.queries).toHaveLength(1);
  });
});
