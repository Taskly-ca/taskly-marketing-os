/**
 * The `source` repository, without Postgres.
 *
 * There is no in-memory implementation to conform against — this port does not
 * exist yet — so these assertions carry more weight than the equivalents
 * elsewhere in this package. What they pin down is the three-way distinction
 * that made a store necessary at all:
 *
 *   a collection ADVANCES the cursor, a 304 does not touch it, and a failure
 *   touches neither the cursor nor `last_ok_at`.
 *
 * Getting that wrong is not a crash, it is a source that silently skips a
 * window of items or a dead source that looks healthy — so it is asserted on
 * the statement text, where it is visible without a database.
 */
import { describe, expect, it } from 'vitest';
import type { QueryRow } from '@tmos/db';
import type { CollectResult } from '@tmos/collectors';

import { DecodeError, NotFoundError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  collectionOutcomeFor,
  collectorCursor,
  dueSources,
  recordCollection,
  recordSourceReliability,
  rowToSourceState,
  sourceById,
} from './source-store.js';

const SOURCE = '33333333-3333-4333-8333-333333333333';
const T0 = '2026-07-01T00:00:00.000Z';

/** Shaped the way node-postgres really answers: timestamptz → Date, numeric → string. */
const cannedSource = (over: Partial<QueryRow> = {}): QueryRow => ({
  id: SOURCE,
  kind: 'rss',
  name: 'Trade weekly',
  tier: 'trade',
  region: 'ca',
  cursor: '2026-07-01T00:00:00.000Z',
  etag: 'W/"abc"',
  last_ok_at: new Date(T0),
  consecutive_failures: 0,
  visibility: 'internal',
  derives_from: null,
  reliability_alpha: '1',
  reliability_beta: '1',
  ...over,
});

describe('decoding', () => {
  it('maps a driver row onto the collection state', () => {
    expect(rowToSourceState(cannedSource())).toEqual({
      id: SOURCE,
      kind: 'rss',
      name: 'Trade weekly',
      tier: 'trade',
      region: 'ca',
      cursor: '2026-07-01T00:00:00.000Z',
      etag: 'W/"abc"',
      last_ok_at: T0,
      consecutive_failures: 0,
      visibility: 'internal',
      derives_from: null,
      reliability: { alpha: 1, beta: 1 },
    });
  });

  it('reads a numeric posterior that arrives as a string — never as a string', () => {
    const state = rowToSourceState(
      cannedSource({ reliability_alpha: '190.5', reliability_beta: '10' }),
    );
    expect(state.reliability).toEqual({ alpha: 190.5, beta: 10 });
  });

  it('accepts a never-collected source: no cursor, no etag, no last_ok_at', () => {
    const state = rowToSourceState(
      cannedSource({ cursor: null, etag: null, last_ok_at: null, region: null }),
    );
    expect(state.cursor).toBeNull();
    expect(state.last_ok_at).toBeNull();
    expect(state.region).toBeNull();
    expect(collectorCursor(state)).toEqual({});
  });

  it('hands a collector exactly the two fields CollectorContext takes', () => {
    expect(collectorCursor(rowToSourceState(cannedSource()))).toEqual({
      cursor: '2026-07-01T00:00:00.000Z',
      etag: 'W/"abc"',
    });
  });

  it('refuses a tier the check constraint could not have produced', () => {
    expect(() => rowToSourceState(cannedSource({ tier: 'content_farm' }))).toThrow(DecodeError);
  });
});

describe('CollectResult → CollectionOutcome', () => {
  it('keeps the three outcomes apart', () => {
    const collected: CollectResult = { ok: true, items: [], cursor: 'c2', etag: 'e2' };
    expect(collectionOutcomeFor(collected, T0)).toEqual({
      kind: 'collected',
      at: T0,
      cursor: 'c2',
      etag: 'e2',
    });

    const notModified: CollectResult = { ok: true, items: [], notModified: true, etag: 'e2' };
    expect(collectionOutcomeFor(notModified, T0)).toEqual({
      kind: 'not_modified',
      at: T0,
      etag: 'e2',
    });

    const failed: CollectResult = {
      ok: false,
      reason: 'network',
      detail: 'ETIMEDOUT',
      retryable: true,
    };
    expect(collectionOutcomeFor(failed, T0)).toEqual({ kind: 'failed' });
  });

  it('a genuinely quiet source is a COLLECTION, not a 304 — items may be empty', () => {
    expect(collectionOutcomeFor({ ok: true, items: [] }, T0)).toEqual({
      kind: 'collected',
      at: T0,
    });
  });

  it('omits a cursor the collector did not return, so the stored one survives', () => {
    expect(collectionOutcomeFor({ ok: true, items: [], etag: 'e2' }, T0)).toEqual({
      kind: 'collected',
      at: T0,
      etag: 'e2',
    });
  });
});

describe('recordCollection', () => {
  it('a collection advances the cursor, stamps last_ok_at and clears the streak', async () => {
    const ex = recordingExecutor([[cannedSource()]]);
    await recordCollection(SOURCE, { kind: 'collected', at: T0, cursor: 'c2', etag: 'e2' }, ex);

    const q = ex.last();
    expect(q.text).toMatch(/cursor\s*=\s*coalesce/);
    expect(q.text).toMatch(/last_ok_at\s*=/);
    expect(q.text).toMatch(/consecutive_failures\s*=\s*0/);
    // The instant is the caller's. `now()` is frozen for a whole transaction,
    // so a source collected inside someone else's unit of work would otherwise
    // be stamped with the instant that transaction opened.
    expect(q.text).not.toContain('now()');
    expect(q.values).toEqual(['c2', 'e2', T0, SOURCE]);
  });

  it('a 304 CANNOT touch the cursor — the column is not in the statement', async () => {
    const ex = recordingExecutor([[cannedSource()]]);
    await recordCollection(SOURCE, { kind: 'not_modified', at: T0, etag: 'e2' }, ex);

    const q = ex.last();
    // Not `cursor = cursor`, not `coalesce(null, cursor)`: absent.
    expect(q.text).not.toMatch(/cursor\s*=/);
    expect(q.text).toMatch(/etag\s*=\s*coalesce/);
    expect(q.text).toMatch(/last_ok_at\s*=/);
    expect(q.text).toMatch(/consecutive_failures\s*=\s*0/);
  });

  it('a failure moves the streak and NOTHING else', async () => {
    const ex = recordingExecutor([[cannedSource({ consecutive_failures: 3 })]]);
    const state = await recordCollection(SOURCE, { kind: 'failed' }, ex);

    const q = ex.last();
    expect(q.text).toMatch(/consecutive_failures\s*=\s*consecutive_failures \+ 1/);
    expect(q.text).not.toMatch(/cursor\s*=/);
    expect(q.text).not.toMatch(/last_ok_at\s*=/);
    expect(q.text).not.toMatch(/etag\s*=/);
    expect(q.values).toEqual([SOURCE]);
    expect(state.consecutive_failures).toBe(3);
  });

  it('is refused for a source that does not exist, and for an id that cannot be one', async () => {
    const missing = recordingExecutor([[]]);
    await expect(recordCollection(SOURCE, { kind: 'failed' }, missing)).rejects.toThrow(
      NotFoundError,
    );

    const malformed = recordingExecutor();
    await expect(
      recordCollection('source_1', { kind: 'failed' }, malformed),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(malformed.queries).toEqual([]);
  });
});

describe('reads', () => {
  it('treats a malformed id as a miss, without issuing a query', async () => {
    const ex = recordingExecutor();
    expect(await sourceById('source_1', ex)).toBeNull();
    expect(ex.queries).toEqual([]);
  });

  it('schedules never-collected sources first, then the stalest', async () => {
    const ex = recordingExecutor([[cannedSource()]]);
    await dueSources({}, ex);
    expect(ex.last().text).toContain('order by last_ok_at asc nulls first, id');
  });

  it('filters by kind and by failure streak only when asked', async () => {
    const all = recordingExecutor([[]]);
    await dueSources({}, all);
    expect(all.last().values).toEqual([null, null, null, null]);

    const some = recordingExecutor([[]]);
    await dueSources({ kind: 'rss', maxConsecutiveFailures: 5, limit: 10 }, some);
    expect(some.last().values).toEqual(['rss', 'rss', 5, 5, 10]);
    expect(some.last().text).toContain('limit');
  });
});

describe('reliability', () => {
  it('adds the observation to the posterior in SQL, never read-modify-write', async () => {
    const ex = recordingExecutor([
      [cannedSource({ reliability_alpha: '4', reliability_beta: '2' })],
    ]);
    const state = await recordSourceReliability(SOURCE, { correct: 3, incorrect: 1 }, ex);

    // One statement, and it is an increment: two concurrent observations both
    // count, which a read-then-write would silently lose.
    expect(ex.queries).toHaveLength(1);
    expect(ex.last().text).toMatch(/reliability_alpha\s*=\s*reliability_alpha \+/);
    expect(ex.last().text).toMatch(/reliability_beta\s*=\s*reliability_beta\s*\+/);
    expect(ex.last().values).toEqual([3, 1, SOURCE]);
    expect(state.reliability).toEqual({ alpha: 4, beta: 2 });
  });

  it('refuses counts the domain function refuses, before touching the database', async () => {
    const ex = recordingExecutor();
    await expect(
      recordSourceReliability(SOURCE, { correct: -1, incorrect: 0 }, ex),
    ).rejects.toThrow(RangeError);
    await expect(
      recordSourceReliability(SOURCE, { correct: Number.NaN, incorrect: 0 }, ex),
    ).rejects.toThrow(RangeError);
    expect(ex.queries).toEqual([]);
  });
});
