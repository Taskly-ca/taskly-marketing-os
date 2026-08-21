/**
 * The `source` repository against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://… pnpm test:live
 *
 * There is no conformance array here, because there is no second
 * implementation to conform to — this port did not exist until now. So this
 * file IS the specification, and it is written against the behaviour that
 * matters rather than against the SQL:
 *
 *   a collection advances the cursor · a 304 does not · a failure moves only
 *   the streak · a success clears it · reliability accumulates without ever
 *   reading a value into the process first.
 *
 * Every case runs inside a transaction that is rolled back, so the `source`
 * rows it creates vanish with it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, sql, type Executor } from '@tmos/db';
import { reliabilityScore, UNRATED_SOURCE_RELIABILITY } from '@tmos/world';

import { NotFoundError } from '../errors.js';
import { ABSENT_UUID } from '../testing/conformance.js';
import { HAS_DATABASE, inRollback } from '../testing/live.js';
import {
  collectionOutcomeFor,
  collectorCursor,
  dueSources,
  recordCollection,
  recordSourceReliability,
  sourceById,
} from './source-store.js';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

const T1 = '2026-07-15T00:00:00.000Z';
const T2 = '2026-08-01T00:00:00.000Z';

/** A fresh source row. Rolled back with the rest of the case. */
async function seedSource(tx: Executor, kind = 'tmos_live_rss'): Promise<string> {
  const row = await tx.one<{ id: string }>(sql`
    insert into source (kind, name, tier, region)
    values (${kind}, ${`tmos_live_${randomUUID()}`}, 'trade', 'ca')
    returning id::text as id`);
  return row.id;
}

describe.skipIf(!HAS_DATABASE)('reading collection state', () => {
  it('reads the defaults 001 gives a source nobody has collected yet', async () => {
    await inRollback(async (tx) => {
      const id = await seedSource(tx);
      const state = await sourceById(id, tx);

      expect(state).not.toBeNull();
      expect(state?.cursor).toBeNull();
      expect(state?.etag).toBeNull();
      expect(state?.last_ok_at).toBeNull();
      expect(state?.consecutive_failures).toBe(0);
      expect(state?.visibility).toBe('internal');
      expect(state?.derives_from).toBeNull();
      // Beta(1,1) — the same weak prior `@tmos/world` assumes.
      expect(state?.reliability).toEqual({ alpha: 1, beta: 1 });
      expect(reliabilityScore(state!.reliability)).toBeCloseTo(UNRATED_SOURCE_RELIABILITY, 10);
      // Nothing to hand a collector: this is the state that makes every run
      // re-fetch from zero, which is what this store exists to end.
      expect(collectorCursor(state!)).toEqual({});
    });
  });

  it('returns null for a source that does not exist, and never raises', async () => {
    await inRollback(async (tx) => {
      expect(await sourceById(ABSENT_UUID, tx)).toBeNull();
      expect(await sourceById('rss:not-a-uuid', tx)).toBeNull();
    });
  });

  it('schedules never-collected sources before stale ones', async () => {
    await inRollback(async (tx) => {
      const kind = `tmos_live_${randomUUID().slice(0, 8)}`;
      const collected = await seedSource(tx, kind);
      const never = await seedSource(tx, kind);
      await recordCollection(collected, { kind: 'collected', at: T1 }, tx);

      const due = await dueSources({ kind }, tx);
      expect(due.map((s) => s.id)).toEqual([never, collected]);
    });
  });

  it('filters out sources whose failure streak has run away', async () => {
    await inRollback(async (tx) => {
      const kind = `tmos_live_${randomUUID().slice(0, 8)}`;
      const healthy = await seedSource(tx, kind);
      const broken = await seedSource(tx, kind);
      for (let i = 0; i < 3; i++) await recordCollection(broken, { kind: 'failed' }, tx);

      const due = await dueSources({ kind, maxConsecutiveFailures: 3 }, tx);
      expect(due.map((s) => s.id)).toEqual([healthy]);
    });
  });
});

describe.skipIf(!HAS_DATABASE)('recording an attempt', () => {
  it('a collection advances the cursor, stamps last_ok_at, and clears the streak', async () => {
    await inRollback(async (tx) => {
      const id = await seedSource(tx);
      await recordCollection(id, { kind: 'failed' }, tx);

      const after = await recordCollection(
        id,
        collectionOutcomeFor({ ok: true, items: [], cursor: 'page=2', etag: 'W/"v2"' }, T1),
        tx,
      );

      expect(after.cursor).toBe('page=2');
      expect(after.etag).toBe('W/"v2"');
      expect(after.last_ok_at).toBe(T1);
      expect(after.consecutive_failures).toBe(0);
      // And what a collector gets next time is exactly what it returned.
      expect(collectorCursor(after)).toEqual({ cursor: 'page=2', etag: 'W/"v2"' });
    });
  });

  it('a 304 keeps the cursor, refreshes the etag, and still counts as a success', async () => {
    await inRollback(async (tx) => {
      const id = await seedSource(tx);
      await recordCollection(
        id,
        { kind: 'collected', at: T1, cursor: 'page=2', etag: 'W/"v2"' },
        tx,
      );
      await recordCollection(id, { kind: 'failed' }, tx);

      const after = await recordCollection(
        id,
        collectionOutcomeFor({ ok: true, items: [], notModified: true, etag: 'W/"v3"' }, T2),
        tx,
      );

      // THE case this store exists to get right: nothing new arrived, so there
      // is nothing to advance past.
      expect(after.cursor).toBe('page=2');
      expect(after.etag).toBe('W/"v3"');
      expect(after.last_ok_at).toBe(T2);
      expect(after.consecutive_failures).toBe(0);
    });
  });

  it('a collection with no cursor of its own keeps the one it was given', async () => {
    await inRollback(async (tx) => {
      const id = await seedSource(tx);
      await recordCollection(id, { kind: 'collected', at: T1, cursor: 'page=2' }, tx);

      const after = await recordCollection(
        id,
        collectionOutcomeFor({ ok: true, items: [] }, T2),
        tx,
      );
      expect(after.cursor).toBe('page=2');
      expect(after.last_ok_at).toBe(T2);
    });
  });

  it('a failure moves the streak and leaves the cursor and last_ok_at exactly where they were', async () => {
    await inRollback(async (tx) => {
      const id = await seedSource(tx);
      await recordCollection(
        id,
        { kind: 'collected', at: T1, cursor: 'page=2', etag: 'W/"v2"' },
        tx,
      );

      const failure = collectionOutcomeFor(
        { ok: false, reason: 'rate_limited', detail: '429', retryable: true },
        T2,
      );
      const first = await recordCollection(id, failure, tx);
      const second = await recordCollection(id, failure, tx);

      expect(first.consecutive_failures).toBe(1);
      expect(second.consecutive_failures).toBe(2);
      expect(second.cursor).toBe('page=2');
      expect(second.etag).toBe('W/"v2"');
      // A dead source must not look healthy: `last_ok_at` still says T1.
      expect(second.last_ok_at).toBe(T1);
    });
  });

  it('is refused for a source that does not exist', async () => {
    await inRollback(async (tx) => {
      await expect(recordCollection(ABSENT_UUID, { kind: 'failed' }, tx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});

describe.skipIf(!HAS_DATABASE)('reliability', () => {
  it('accumulates observations into the Beta posterior', async () => {
    await inRollback(async (tx) => {
      const id = await seedSource(tx);

      const once = await recordSourceReliability(id, { correct: 3, incorrect: 1 }, tx);
      expect(once.reliability).toEqual({ alpha: 4, beta: 2 });

      const twice = await recordSourceReliability(id, { correct: 3, incorrect: 1 }, tx);
      expect(twice.reliability).toEqual({ alpha: 7, beta: 3 });

      // The point of storing it: a source with a record now outranks one without.
      expect(reliabilityScore(twice.reliability)).toBeGreaterThan(UNRATED_SOURCE_RELIABILITY);
    });
  });

  it('keeps a fractional weight exactly — numeric, not float', async () => {
    await inRollback(async (tx) => {
      const id = await seedSource(tx);
      const state = await recordSourceReliability(id, { correct: 0.1, incorrect: 0.2 }, tx);
      expect(state.reliability).toEqual({ alpha: 1.1, beta: 1.2 });
    });
  });

  it('is an increment, so a concurrent observation cannot be lost', async () => {
    await inRollback(async (tx) => {
      const id = await seedSource(tx);
      // Both statements read the column inside the database; neither carries a
      // value read into this process first.
      await recordSourceReliability(id, { correct: 1, incorrect: 0 }, tx);
      await recordSourceReliability(id, { correct: 1, incorrect: 0 }, tx);
      expect((await sourceById(id, tx))?.reliability).toEqual({ alpha: 3, beta: 1 });
    });
  });

  it('is refused for a source that does not exist', async () => {
    await inRollback(async (tx) => {
      await expect(
        recordSourceReliability(ABSENT_UUID, { correct: 1, incorrect: 0 }, tx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
