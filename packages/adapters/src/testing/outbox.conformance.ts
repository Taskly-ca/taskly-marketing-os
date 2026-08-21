/**
 * The `Outbox` conformance suite — the definition of "substitutable" for the
 * transactional outbox.
 *
 * Every case runs against a FRESH store (a new `Map` in memory, a new
 * rolled-back transaction against Postgres), so nothing here may depend on what
 * another case left behind. Three constraints shape the assertions, all of them
 * coming from the Postgres side:
 *
 *   · ids are supplied by the CALLER here, unlike `FactStore` — `buildEvent`
 *     mints them — so they must be real uuids. `makeOutboxFixtures` generates
 *     fresh ones per case.
 *   · `all()` does not start empty against a real database. Every case that
 *     touches it filters to its own correlation ids rather than asserting a
 *     length, which is the only form of the assertion that means the same thing
 *     in both stores.
 *   · rows come back as copies, but SHALLOW ones in memory (`{ ...event }`), so
 *     nothing here mutates a nested `payload` and expects isolation.
 *
 * `finding` and `events` have no fixture rows to seed — `events.source_id` and
 * `entity_id` are plain uuid columns with no foreign key (001) — so the seam
 * that `seedFactFixtures` fills for `FactStore` is just a value generator here.
 */
import { randomUUID } from 'node:crypto';
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';

import type { EventRow, Outbox, QueueMessage } from '@tmos/gate';

import { ABSENT_UUID, type ConformanceCase } from './conformance.js';

export interface OutboxFixtures {
  readonly correlationId: string;
  /** A second correlation: proves `byCorrelation` filters. */
  readonly otherCorrelationId: string;
  readonly queue: string;
  readonly otherQueue: string;
  /** Prefixes every idempotency key, so a case cannot collide with a real row. */
  readonly keyPrefix: string;
}

export type OutboxCase = ConformanceCase<Outbox, OutboxFixtures>;

/**
 * Fresh values for one case. Called by the memory suite and the live suite
 * alike — unlike the fact fixtures there is nothing to insert, so this is a
 * plain function rather than a seeder taking a transaction.
 */
export function makeOutboxFixtures(): OutboxFixtures {
  return {
    correlationId: randomUUID(),
    otherCorrelationId: randomUUID(),
    queue: `tmos_conf_${randomUUID().slice(0, 8)}`,
    otherQueue: `tmos_conf_${randomUUID().slice(0, 8)}`,
    keyPrefix: `tmos_conf_${randomUUID().slice(0, 8)}`,
  };
}

const T0 = '2026-07-01T00:00:00.000Z';

const event = (fx: OutboxFixtures, over: Partial<EventRow> = {}): EventRow => ({
  id: randomUUID(),
  occurredAt: T0,
  recordedAt: T0,
  type: 'source.collected',
  sourceId: null,
  entityId: null,
  payload: { items: 3 },
  contentHash: null,
  idempotencyKey: `${fx.keyPrefix}-${randomUUID()}`,
  correlationId: fx.correlationId,
  causationId: null,
  ...over,
});

const message = (
  queue: string,
  eventId: string,
  over: Partial<QueueMessage> = {},
): QueueMessage => ({
  queue,
  eventId,
  body: { work: 'skim' },
  ...over,
});

const ids = (rows: readonly EventRow[]): string[] => rows.map((r) => r.id).sort();

export const OUTBOX_CONFORMANCE: readonly OutboxCase[] = [
  {
    name: 'append returns true and the event reads back identically by correlation',
    async run(store, fx) {
      const e = event(fx, { sourceId: ABSENT_UUID, contentHash: 'sha256:abc', causationId: null });

      strictEqual(await store.append(e), true);

      const read = await store.byCorrelation(fx.correlationId);
      strictEqual(read.length, 1);
      deepStrictEqual(read[0], e);
    },
  },

  {
    name: 'a repeated idempotency key returns false and appends nothing — never throws',
    async run(store, fx) {
      const first = event(fx);
      strictEqual(await store.append(first), true);

      // Same key, different id, different payload: the key is the identity.
      const replay = event(fx, { idempotencyKey: first.idempotencyKey, payload: { items: 99 } });
      strictEqual(await store.append(replay), false);

      const read = await store.byCorrelation(fx.correlationId);
      strictEqual(read.length, 1, 'a duplicate must not append a second row');
      strictEqual(read[0]?.id, first.id);
    },
  },

  {
    name: 'append enqueues its messages, and pending finds them on their own queue',
    async run(store, fx) {
      const e = event(fx);
      await store.append(e, [
        message(fx.queue, e.id),
        message(fx.queue, e.id, { body: { work: 'rank' } }),
      ]);

      const pending = await store.pending(fx.queue);
      strictEqual(pending.length, 2);
      deepStrictEqual(
        pending.map((m) => m.body),
        [{ work: 'skim' }, { work: 'rank' }],
        'FIFO within a queue',
      );
      strictEqual(
        pending.every((m) => m.eventId === e.id),
        true,
      );

      deepStrictEqual(await store.pending(fx.otherQueue), [], 'another queue is untouched');
    },
  },

  {
    name: 'pending is a PEEK — calling it twice returns the same rows',
    async run(store, fx) {
      const e = event(fx);
      await store.append(e, [message(fx.queue, e.id)]);

      const first = await store.pending(fx.queue);
      const second = await store.pending(fx.queue);

      strictEqual(first.length, 1);
      deepStrictEqual(second, first, 'a peek must not consume, hide, or mutate');
      // And a third time, after reading the events too — nothing about reading
      // may change what is queued.
      await store.all();
      deepStrictEqual(await store.pending(fx.queue), first);
    },
  },

  {
    name: 'a duplicate append enqueues NOTHING — the whole point of both-or-neither',
    async run(store, fx) {
      const e = event(fx);
      await store.append(e, [message(fx.queue, e.id)]);

      const replay = event(fx, { idempotencyKey: e.idempotencyKey });
      strictEqual(
        await store.append(replay, [message(fx.queue, e.id, { body: { work: 'again' } })]),
        false,
      );

      const pending = await store.pending(fx.queue);
      strictEqual(pending.length, 1, 'the replay must not re-enqueue the work');
      deepStrictEqual(pending[0]?.body, { work: 'skim' });
    },
  },

  {
    name: 'an append with no messages leaves the queue empty',
    async run(store, fx) {
      await store.append(event(fx));
      deepStrictEqual(await store.pending(fx.queue), []);
    },
  },

  {
    name: 'byCorrelation isolates one investigation from another',
    async run(store, fx) {
      const a = event(fx);
      const b = event(fx);
      const other = event(fx, { correlationId: fx.otherCorrelationId });
      await store.append(a);
      await store.append(b);
      await store.append(other);

      deepStrictEqual(ids(await store.byCorrelation(fx.correlationId)), ids([a, b]));
      deepStrictEqual(ids(await store.byCorrelation(fx.otherCorrelationId)), [other.id]);
    },
  },

  {
    name: 'all() contains every appended event',
    async run(store, fx) {
      const a = event(fx);
      const b = event(fx, { correlationId: fx.otherCorrelationId });
      await store.append(a);
      await store.append(b);

      // Filtered, not counted: `all()` against a real database also returns
      // every event any other run ever recorded.
      const mine = (await store.all()).filter((e) => e.idempotencyKey.startsWith(fx.keyPrefix));
      deepStrictEqual(ids(mine), ids([a, b]));
    },
  },

  {
    name: 'an unknown correlation and an unknown queue are empty, never an error',
    async run(store) {
      deepStrictEqual(await store.byCorrelation(ABSENT_UUID), []);
      deepStrictEqual(await store.pending('tmos_conf_queue_that_does_not_exist'), []);
    },
  },

  {
    name: 'the rows handed back are copies — mutating one does not reach the store',
    async run(store, fx) {
      const e = event(fx);
      await store.append(e, [message(fx.queue, e.id)]);

      const read = (await store.byCorrelation(fx.correlationId))[0];
      ok(read !== undefined);
      read.type = 'mutated';

      const again = (await store.byCorrelation(fx.correlationId))[0];
      strictEqual(again?.type, 'source.collected');
      notStrictEqual(again, read);

      const peeked = (await store.pending(fx.queue))[0];
      ok(peeked !== undefined);
      peeked.queue = 'mutated';
      strictEqual((await store.pending(fx.queue))[0]?.queue, fx.queue);
    },
  },

  {
    name: 'messages for two events on one queue keep their append order',
    async run(store, fx) {
      const first = event(fx);
      const second = event(fx);
      await store.append(first, [message(fx.queue, first.id, { body: { n: 1 } })]);
      await store.append(second, [message(fx.queue, second.id, { body: { n: 2 } })]);

      deepStrictEqual(
        (await store.pending(fx.queue)).map((m) => m.body),
        [{ n: 1 }, { n: 2 }],
      );
    },
  },
];
