/**
 * The Postgres `Outbox`, without Postgres.
 *
 * What can be proven with no connection is narrow but not small: that values
 * reach `values` and never the query text, that the duplicate check is the
 * INSERT itself rather than a read-then-decide, that a duplicate enqueues
 * nothing, that `pending` issues a bare SELECT with no side effect in it, that
 * nothing in this file can ever UPDATE or DELETE `events`, and that both writes
 * land on ONE executor — which is the whole atomicity claim, minus the proof
 * that Postgres honours it.
 *
 * That last proof is `outbox.live.test.ts`, and it is skipping.
 */
import { describe, expect, it } from 'vitest';
import { withTx, type PooledClient, type QueryRow } from '@tmos/db';
import type { EventRow, QueueMessage } from '@tmos/gate';

import { DecodeError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  allEvents,
  appendEvent,
  appendEventInTx,
  eventsByCorrelation,
  pendingMessages,
  rowToEvent,
  rowToQueueMessage,
} from './outbox.js';

const EVENT = '99999999-9999-4999-8999-999999999999';
const CORRELATION = '11111111-1111-4111-8111-111111111111';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const T0 = '2026-07-01T00:00:00.000Z';

const event = (over: Partial<EventRow> = {}): EventRow => ({
  id: EVENT,
  occurredAt: T0,
  recordedAt: T0,
  type: 'source.collected',
  sourceId: SOURCE,
  entityId: null,
  payload: { items: 3 },
  contentHash: 'sha256:abc',
  idempotencyKey: 'rss^0^sha256:abc',
  correlationId: CORRELATION,
  causationId: null,
  ...over,
});

const message = (over: Partial<QueueMessage> = {}): QueueMessage => ({
  queue: 'skim',
  eventId: EVENT,
  body: { work: 'skim' },
  ...over,
});

/** Shaped the way node-postgres really answers: timestamptz → Date, jsonb → object. */
const cannedEvent = (over: Partial<QueryRow> = {}): QueryRow => ({
  id: EVENT,
  occurred_at: new Date(T0),
  recorded_at: new Date(T0),
  type: 'source.collected',
  source_id: SOURCE,
  entity_id: null,
  payload: { items: 3 },
  content_hash: 'sha256:abc',
  idempotency_key: 'rss^0^sha256:abc',
  correlation_id: CORRELATION,
  causation_id: null,
  ...over,
});

/** A pooled client that answers the transaction bookkeeping and records it. */
function fakeConnect(): { connect: () => Promise<PooledClient>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    connect: async () => ({
      async query(text: string) {
        calls.push(text);
        return { rows: [], rowCount: 0 };
      },
      release() {},
    }),
  };
}

describe('append', () => {
  it('sends every value as a parameter and never as text', async () => {
    const ex = recordingExecutor([[cannedEvent()]]);
    await appendEventInTx(event(), [], ex);

    const q = ex.last();
    expect(q.text).toContain('insert into events');
    expect(q.text).not.toContain(EVENT);
    expect(q.text).not.toContain('sha256:abc');
    expect(q.values).toContain(EVENT);
    expect(q.values).toContain('rss^0^sha256:abc');
    expect(q.values).toContain(JSON.stringify({ items: 3 }));
  });

  it('de-duplicates in the INSERT, on the idempotency key, and nowhere else', async () => {
    const ex = recordingExecutor([[cannedEvent()]]);
    await appendEventInTx(event(), [], ex);

    // One statement: no `select … where idempotency_key` first, which would
    // leave a window in which two workers both see "not seen yet".
    expect(ex.queries).toHaveLength(1);
    expect(ex.last().text).toContain('on conflict (idempotency_key) do nothing');
  });

  it('never reads the clock — every instant comes from the event', async () => {
    const ex = recordingExecutor([[cannedEvent()]]);
    await appendEventInTx(event(), [message()], ex);

    for (const q of ex.queries) expect(q.text).not.toContain('now()');
    expect(ex.queries[0]?.values).toContain(T0);
  });

  it('returns true and writes one row per message', async () => {
    // `recordingExecutor.execute` answers with the length of the scripted rows:
    // one row for the event insert, one for each message insert.
    const ex = recordingExecutor([[cannedEvent()], [cannedEvent()], [cannedEvent()]]);

    const appended = await appendEventInTx(event(), [message(), message({ queue: 'rank' })], ex);

    expect(appended).toBe(true);
    expect(ex.queries).toHaveLength(3);
    expect(ex.queries[1]?.text).toContain('insert into outbox_message');
    expect(ex.queries[1]?.values).toEqual(['skim', EVENT, JSON.stringify({ work: 'skim' })]);
    expect(ex.queries[2]?.values).toContain('rank');
  });

  it('returns false and enqueues NOTHING when the key was already seen', async () => {
    // Zero rows from the insert = the conflict fired.
    const ex = recordingExecutor([[]]);

    const appended = await appendEventInTx(event(), [message(), message()], ex);

    expect(appended).toBe(false);
    expect(ex.queries).toHaveLength(1);
    expect(ex.queries.some((q) => q.text.includes('outbox_message'))).toBe(false);
  });

  it('never updates or deletes events — the 001 trigger rejects both', async () => {
    const ex = recordingExecutor([[cannedEvent()], [cannedEvent()]]);
    await appendEventInTx(event(), [message()], ex);

    for (const q of ex.queries) {
      expect(q.text).not.toMatch(/\bupdate\s+events\b/i);
      expect(q.text).not.toMatch(/\bdelete\s+from\s+events\b/i);
    }
  });

  it('runs both writes on the CALLER’s executor when there is already a transaction', async () => {
    const ex = recordingExecutor([[cannedEvent()], [cannedEvent()]]);
    const pool = fakeConnect();

    await withTx(async () => {
      await appendEvent(event(), [message()], ex);
    }, pool);

    // One BEGIN/COMMIT pair — `withTx` nested rather than opening a second
    // connection, which could not see the outer transaction's rows.
    expect(pool.calls).toEqual(['BEGIN', 'COMMIT']);
    expect(ex.queries).toHaveLength(2);
  });

  it.skipIf(Boolean(process.env.DATABASE_URL))(
    'refuses to write outside a transaction rather than half-writing',
    async () => {
      // No ambient transaction and no database: `appendEvent` tries to open one
      // and fails there. What matters is that it failed BEFORE using the
      // executor it was handed — an event written without its messages is the
      // one outcome this port must never produce.
      const ex = recordingExecutor([[cannedEvent()]]);
      await expect(appendEvent(event(), [message()], ex)).rejects.toThrow();
      expect(ex.queries).toEqual([]);
    },
  );
});

describe('reads', () => {
  it('treats a malformed correlation id as a miss, without issuing a query', async () => {
    const ex = recordingExecutor();
    expect(await eventsByCorrelation('event_000001', ex)).toEqual([]);
    expect(ex.queries).toEqual([]);
  });

  it('orders events by when we recorded them, with the id as a tiebreak', async () => {
    const ex = recordingExecutor([[cannedEvent()]]);
    await allEvents(ex);
    expect(ex.last().text).toContain('order by recorded_at, id');
  });

  it('pending is a bare select: no update, no delete, no visibility timeout', async () => {
    const ex = recordingExecutor([[]]);
    await pendingMessages('skim', {}, ex);

    const q = ex.last();
    expect(q.text).toContain('select');
    expect(q.text).not.toMatch(/\b(update|delete|insert)\b/i);
    expect(q.text).toContain('delivered_at is null');
    expect(q.text).toContain('dead_at is null');
    expect(q.text).toContain('order by msg_id');
    // No instant, because the port's `pending(queue)` has nowhere to take one
    // from and the memory store has no visibility notion at all.
    expect(q.text).not.toContain('visible_at');
    expect(q.values).toEqual(['skim']);
  });

  it('adds the visibility filter and the limit only when asked', async () => {
    const ex = recordingExecutor([[]]);
    await pendingMessages('skim', { asOf: T0, limit: 10 }, ex);

    const q = ex.last();
    expect(q.text).toContain('visible_at <=');
    expect(q.text).toContain('limit');
    expect(q.values).toEqual(['skim', T0, 10]);
  });
});

describe('decoding', () => {
  it('maps a driver row onto an EventRow', async () => {
    expect(rowToEvent(cannedEvent())).toEqual(event());
  });

  it('accepts the nullable columns as nulls', () => {
    const row = rowToEvent(
      cannedEvent({ source_id: null, entity_id: null, content_hash: null, causation_id: null }),
    );
    expect(row.sourceId).toBeNull();
    expect(row.contentHash).toBeNull();
    expect(row.causationId).toBeNull();
  });

  it('refuses a row with no idempotency key — the column is nullable, the type is not', () => {
    // Nothing this adapter writes lacks one, so such a row came from elsewhere.
    // That is a decode failure naming the column, not a silent empty string.
    expect(() => rowToEvent(cannedEvent({ idempotency_key: null }))).toThrow(DecodeError);
  });

  it('refuses a payload that is not a JSON object', () => {
    expect(() => rowToEvent(cannedEvent({ payload: [1, 2, 3] }))).toThrow(DecodeError);
  });

  it('maps a message row onto a QueueMessage', () => {
    expect(rowToQueueMessage({ queue: 'skim', event_id: EVENT, body: { work: 'skim' } })).toEqual({
      queue: 'skim',
      eventId: EVENT,
      body: { work: 'skim' },
    });
  });
});
