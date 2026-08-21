/**
 * `Outbox` against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://… pnpm test:live
 *
 * Beyond the shared conformance array, this file exists for ONE claim that
 * cannot be checked anywhere else and is the entire reason the port exists:
 *
 *   AN APPEND IS ATOMIC. The event and its queue messages land together or not
 *   at all. `outbox.test.ts` can prove both statements go to one executor; only
 *   a real transaction can prove that aborting it leaves NEITHER row — and only
 *   a real foreign key can prove a message cannot outlive its event.
 *
 * The two are tested separately and deliberately differently:
 *
 *   · the rollback case appends successfully, then looks from OUTSIDE the
 *     transaction and finds nothing.
 *   · the failure case makes the SECOND write fail after the first succeeded,
 *     lets the transaction abort on its own, and then looks. That is the shape
 *     of the bug in production — a worker that enqueued work and then died
 *     before recording why — and it is the one an in-memory store can never
 *     have.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, db, sql, withTx } from '@tmos/db';
import type { EventRow } from '@tmos/gate';

import { MissingReferenceError } from '../errors.js';
import { ABSENT_UUID } from '../testing/conformance.js';
import { HAS_DATABASE, inRollback } from '../testing/live.js';
import { OUTBOX_CONFORMANCE, makeOutboxFixtures } from '../testing/outbox.conformance.js';
import { appendEventInTx, createPostgresOutbox, pendingMessages } from './outbox.js';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

const T0 = '2026-07-01T00:00:00.000Z';

const liveEvent = (over: Partial<EventRow> = {}): EventRow => ({
  id: randomUUID(),
  occurredAt: T0,
  recordedAt: T0,
  type: 'source.collected',
  sourceId: null,
  entityId: null,
  payload: { items: 3, nested: { deep: true } },
  contentHash: null,
  idempotencyKey: `tmos_live_${randomUUID()}`,
  correlationId: randomUUID(),
  causationId: null,
  ...over,
});

/** Counts, read from OUTSIDE any transaction the test opened. */
async function countsFor(eventId: string): Promise<{ events: number; messages: number }> {
  const row = await db().one<{ events: string; messages: string }>(sql`
    select
      (select count(*) from events where id = ${eventId}::uuid) as events,
      (select count(*) from outbox_message where event_id = ${eventId}::uuid) as messages`);
  return { events: Number(row.events), messages: Number(row.messages) };
}

describe.skipIf(!HAS_DATABASE)('Outbox conformance — postgres', () => {
  for (const testCase of OUTBOX_CONFORMANCE) {
    it(testCase.name, async () => {
      await inRollback(async (tx) => {
        await testCase.run(createPostgresOutbox(tx), makeOutboxFixtures());
      });
    });
  }
});

describe.skipIf(!HAS_DATABASE)('atomicity — the only reason this port exists', () => {
  it('a rolled-back append leaves neither an event nor a message', async () => {
    const event = liveEvent();

    const inside = await inRollback(async (tx) => {
      const outbox = createPostgresOutbox(tx);
      expect(
        await outbox.append(event, [{ queue: 'skim', eventId: event.id, body: { n: 1 } }]),
      ).toBe(true);
      // Both rows are visible to the transaction that wrote them…
      const row = await tx.one<{ events: string; messages: string }>(sql`
        select
          (select count(*) from events where id = ${event.id}::uuid) as events,
          (select count(*) from outbox_message where event_id = ${event.id}::uuid) as messages`);
      return { events: Number(row.events), messages: Number(row.messages) };
    });

    expect(inside).toEqual({ events: 1, messages: 1 });
    // …and to nobody, afterwards.
    expect(await countsFor(event.id)).toEqual({ events: 0, messages: 0 });
  });

  it('a message that cannot be written takes its event down with it', async () => {
    const event = liveEvent();

    // The event insert succeeds; the message names an event that does not
    // exist, so the foreign key refuses it and the transaction aborts. Nothing
    // rolls this back on purpose — the failure does.
    await expect(
      withTx(async (tx) => {
        await appendEventInTx(event, [{ queue: 'skim', eventId: ABSENT_UUID, body: { n: 1 } }], tx);
      }),
    ).rejects.toBeInstanceOf(MissingReferenceError);

    expect(await countsFor(event.id)).toEqual({ events: 0, messages: 0 });
  });

  it('a duplicate append cannot enqueue work, even when the messages are new', async () => {
    await inRollback(async (tx) => {
      const outbox = createPostgresOutbox(tx);
      const event = liveEvent();
      const queue = `tmos_live_${randomUUID().slice(0, 8)}`;

      await outbox.append(event, [{ queue, eventId: event.id, body: { n: 1 } }]);

      const replay = liveEvent({ idempotencyKey: event.idempotencyKey });
      expect(await outbox.append(replay, [{ queue, eventId: event.id, body: { n: 2 } }])).toBe(
        false,
      );

      const pending = await outbox.pending(queue);
      expect(pending.map((m) => m.body)).toEqual([{ n: 1 }]);
    });
  });
});

describe.skipIf(!HAS_DATABASE)('what only the database can say', () => {
  it('events is append-only — 001’s trigger rejects the update this adapter never issues', async () => {
    await inRollback(async (tx) => {
      const event = liveEvent();
      await appendEventInTx(event, [], tx);

      // Documented here rather than in the adapter because the adapter has no
      // code path that could reach it: every duplicate is absorbed by
      // `on conflict … do nothing`, never by a read-then-update.
      await expect(
        tx.execute(sql`update events set type = 'edited' where id = ${event.id}::uuid`),
      ).rejects.toThrow(/append-only/i);
    });
  });

  it('pending is non-destructive across repeated reads and does not hide rows', async () => {
    await inRollback(async (tx) => {
      const event = liveEvent();
      const queue = `tmos_live_${randomUUID().slice(0, 8)}`;
      await appendEventInTx(
        event,
        [
          { queue, eventId: event.id, body: { n: 1 } },
          { queue, eventId: event.id, body: { n: 2 } },
        ],
        tx,
      );

      const first = await pendingMessages(queue, {}, tx);
      const second = await pendingMessages(queue, {}, tx);
      const third = await pendingMessages(queue, {}, tx);

      expect(first.map((m) => m.body)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(second).toEqual(first);
      expect(third).toEqual(first);

      // The rows really are still there, unlocked and undelivered — pgmq's
      // `read` would have set a visibility timeout by now, which is the whole
      // reason 012 chose a plain table.
      const row = await tx.one<{ n: string }>(sql`
        select count(*) as n from outbox_message
         where event_id = ${event.id}::uuid
           and delivered_at is null and dead_at is null and locked_by is null`);
      expect(Number(row.n)).toBe(2);
    });
  });

  it('honours visible_at when a dispatcher supplies an instant', async () => {
    await inRollback(async (tx) => {
      const event = liveEvent();
      const queue = `tmos_live_${randomUUID().slice(0, 8)}`;
      await appendEventInTx(event, [{ queue, eventId: event.id, body: { n: 1 } }], tx);

      // Deferred by hand: `visible_at` has no port method, deliberately.
      await tx.execute(sql`
        update outbox_message set visible_at = ${'2099-01-01T00:00:00.000Z'}::timestamptz
         where event_id = ${event.id}::uuid`);

      expect(await pendingMessages(queue, { asOf: '2026-08-01T00:00:00.000Z' }, tx)).toEqual([]);
      // …and the default peek still sees it, because the port has no instant.
      expect(await pendingMessages(queue, {}, tx)).toHaveLength(1);
    });
  });

  it('round-trips a nested jsonb payload and the uuid casts', async () => {
    await inRollback(async (tx) => {
      const outbox = createPostgresOutbox(tx);
      const event = liveEvent({
        sourceId: ABSENT_UUID,
        entityId: null,
        contentHash: 'sha256:abc',
        causationId: ABSENT_UUID,
        payload: { items: 3, nested: { deep: true }, list: [1, 'two', null] },
      });

      await outbox.append(event);
      const read = await outbox.byCorrelation(event.correlationId);
      expect(read).toEqual([event]);
    });
  });
});
