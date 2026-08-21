/**
 * `Outbox` (packages/gate/src/events.ts) on `events` (migration 001) and
 * `outbox_message` (migration 012).
 *
 * The behavioural specification is `createMemoryOutbox`, not this file. Where
 * the two could differ they are made to agree; where they CANNOT agree the
 * difference is named here and in the README, because a divergence nobody
 * wrote down is a divergence someone discovers in production.
 *
 * THE WHOLE POINT IS ATOMICITY. `append` promises "the event AND its queue
 * messages, or neither", and the in-memory store keeps that promise for free by
 * being one process. Here it is kept by two mechanisms that reinforce each
 * other:
 *
 *   ONE TRANSACTION. `appendEvent` runs both inserts inside a transaction —
 *   the caller's if there is one, its own if there is not. `withTx` nests by
 *   reusing the outer transaction, so an append inside someone else's unit of
 *   work never opens a second connection that cannot see their uncommitted
 *   rows.
 *
 *   THE FOREIGN KEY. `outbox_message.event_id references events(id)`, so a
 *   message cannot exist without its event even if some future writer forgets
 *   the transaction. 012 says it plainly: "the FK is what makes both-or-neither
 *   true". `events` has no DELETE (001's `events_immutable` trigger rejects
 *   every update and delete), so the reference can never dangle either.
 *
 * THIS ADAPTER NEVER UPDATES OR DELETES `events`. There is no code path here
 * that could: the trigger would raise, the exception would poison the caller's
 * whole transaction, and the diagnostic would be about a trigger rather than
 * about whatever the caller was really doing. A duplicate is therefore handled
 * with `on conflict … do nothing`, never with a read-then-decide.
 *
 * `pending(queue)` IS A PEEK. It selects and does nothing else — no visibility
 * timeout, no delete, no status flip. That is the reason 012 chose a plain
 * table over pgmq (which has `read`, which hides, and `pop`, which destroys,
 * and no peek at all), so an adapter that quietly consumed here would give back
 * the property the schema was shaped to keep.
 */
import {
  db,
  inTransaction,
  sql,
  withTx,
  type Executor,
  type QueryRow,
  type SqlQuery,
} from '@tmos/db';
import type { EventRow, Outbox, QueueMessage } from '@tmos/gate';

import { guard } from '../errors.js';
import { asIso, asJsonObject, asText, asTextOrNull, isUuid } from './values.js';

/**
 * The projection, nested into every event read so the decoder only ever meets
 * one shape. Uuids are cast `::text` (an `EventRow` id is a string, and casting
 * in the query means the result does not depend on a driver type parser).
 */
const EVENT_COLUMNS = sql`
  id::text as id,
  occurred_at,
  recorded_at,
  type,
  source_id::text as source_id,
  entity_id::text as entity_id,
  payload,
  content_hash,
  idempotency_key,
  correlation_id::text as correlation_id,
  causation_id::text as causation_id`;

/**
 * The memory store returns events in insertion order. `events` has no insertion
 * counter and a random-uuid primary key, so the closest honest ordering is when
 * we recorded it, with the id as a deterministic tiebreak.
 *
 * Unlike `fact.asserted`, `recorded_at` is not frozen per transaction —
 * `buildEvent` stamps it in JavaScript — so ties are rare rather than normal.
 * They still happen: two events built inside the same millisecond sort by id,
 * which is not insertion order. Nothing reads `all()` for order today; see the
 * README.
 */
const EVENT_ORDER = sql`order by recorded_at, id`;

/** `queue`, `event_id`, `body` — exactly the three fields of a `QueueMessage`. */
const MESSAGE_COLUMNS = sql`
  queue,
  event_id::text as event_id,
  body`;

export function rowToEvent(row: QueryRow): EventRow {
  const id = asText(row.id, 'events.id');
  const at = (column: string): string => `events[${id}].${column}`;

  return {
    id,
    occurredAt: asIso(row.occurred_at, at('occurred_at')),
    recordedAt: asIso(row.recorded_at, at('recorded_at')),
    type: asText(row.type, at('type')),
    sourceId: asTextOrNull(row.source_id, at('source_id')),
    entityId: asTextOrNull(row.entity_id, at('entity_id')),
    payload: asJsonObject(row.payload, at('payload')),
    contentHash: asTextOrNull(row.content_hash, at('content_hash')),
    // `events.idempotency_key` is NULLABLE in 001 and `EventRow.idempotencyKey`
    // is not. Everything this adapter writes has one (the port's type requires
    // it), so a null here means a row written by something else — which is a
    // decode failure naming the column, not a silent empty string.
    idempotencyKey: asText(row.idempotency_key, at('idempotency_key')),
    correlationId: asText(row.correlation_id, at('correlation_id')),
    causationId: asTextOrNull(row.causation_id, at('causation_id')),
  };
}

export function rowToQueueMessage(row: QueryRow): QueueMessage {
  return {
    queue: asText(row.queue, 'outbox_message.queue'),
    eventId: asText(row.event_id, 'outbox_message.event_id'),
    body: asJsonObject(row.body, 'outbox_message.body'),
  };
}

/**
 * The atomic body: both inserts, on ONE executor, in the order that makes the
 * foreign key do its job.
 *
 * Exported because a caller already inside `withTx` — the worker, batching an
 * append with the facts it derived from the same fetch — should be able to
 * enlist directly. **It is only atomic if `ex` is a transaction.** Handed a
 * pool executor it will happily write an event and then fail to write its
 * messages, which is the exact thing the port exists to prevent. Prefer
 * `appendEvent`, which decides for you.
 */
export async function appendEventInTx(
  event: EventRow,
  messages: readonly QueueMessage[] = [],
  ex: Executor = db(),
): Promise<boolean> {
  // `on conflict (idempotency_key) do nothing` is the whole duplicate check:
  // one statement, no read-then-decide, and therefore no window in which two
  // workers both see "not seen yet". `execute` returns the affected row count,
  // which is 0 exactly when the key was already there.
  //
  // The conflict target is NAMED rather than bare. A bare `on conflict do
  // nothing` would also swallow a duplicate PRIMARY KEY, and "you appended the
  // same event id twice" is a bug in the caller, not a replay we are absorbing.
  const inserted = await guard('append', () =>
    ex.execute(sql`
      insert into events (
        id, occurred_at, recorded_at, type, source_id, entity_id,
        payload, content_hash, idempotency_key, correlation_id, causation_id
      ) values (
        ${event.id}::uuid,
        ${event.occurredAt}::timestamptz,
        ${event.recordedAt}::timestamptz,
        ${event.type},
        ${event.sourceId}::uuid,
        ${event.entityId}::uuid,
        ${JSON.stringify(event.payload)}::jsonb,
        ${event.contentHash},
        ${event.idempotencyKey},
        ${event.correlationId}::uuid,
        ${event.causationId}::uuid
      )
      on conflict (idempotency_key) do nothing`),
  );

  // A duplicate enqueues NOTHING. This is the half of idempotency that is easy
  // to get wrong: re-delivering the messages of an event we already recorded
  // would run the work twice, which is precisely what the key exists to stop.
  if (inserted === 0) return false;

  // Sequential, not `Promise.all`: a transaction is ONE connection and
  // node-postgres queues concurrent queries on it anyway, so parallelism here
  // would only advertise a concurrency that does not exist.
  for (const message of messages) {
    await guard('append', () =>
      ex.execute(sql`
        insert into outbox_message (queue, event_id, body)
        values (
          ${message.queue},
          ${message.eventId}::uuid,
          ${JSON.stringify(message.body)}::jsonb
        )`),
    );
  }

  return true;
}

/**
 * The port method. Atomic by construction.
 *
 * `inTransaction()` — not the shape of `ex` — decides whether to open one,
 * because an `Executor` cannot be asked whether it is transactional. The test
 * is faithful anyway: the only way to obtain a transaction executor in this
 * repo is inside `withTx`'s callback, and `withTx` sets the ambient store for
 * that whole async context. So "there is an ambient transaction" and "the
 * executor I was handed belongs to a transaction" are the same statement for
 * every legitimate caller. Holding a `tx` past the end of its `withTx` is
 * already broken — the client has been released — and is not defended against.
 */
export async function appendEvent(
  event: EventRow,
  messages: readonly QueueMessage[] = [],
  ex: Executor = db(),
): Promise<boolean> {
  if (inTransaction()) return appendEventInTx(event, messages, ex);
  return withTx((tx) => appendEventInTx(event, messages, tx));
}

/** One investigation is one query — the reason `correlation_id` exists at all. */
export async function eventsByCorrelation(
  correlationId: string,
  ex: Executor = db(),
): Promise<EventRow[]> {
  // A malformed id is "nothing matched", never an error: `correlation_id` is a
  // uuid column and handing Postgres a non-uuid raises 22P02, which would turn
  // a miss into a crash and make the two stores non-substitutable.
  if (!isUuid(correlationId)) return [];

  return guard('byCorrelation', async () => {
    const rows = await ex.query(sql`
      select ${EVENT_COLUMNS} from events
       where correlation_id = ${correlationId}::uuid
       ${EVENT_ORDER}`);
    return rows.map(rowToEvent);
  });
}

/**
 * Every event, ever.
 *
 * Faithful to the port and to the memory store, and a foot-gun on a real
 * database for exactly the reason `createMemoryOutbox` is not: this one does
 * not start empty. It is here because the port declares it (the pipeline
 * harness asserts over it); a dispatcher or an operator wants
 * `eventsByCorrelation`.
 */
export async function allEvents(ex: Executor = db()): Promise<EventRow[]> {
  return guard('all', async () => {
    const rows = await ex.query(sql`select ${EVENT_COLUMNS} from events ${EVENT_ORDER}`);
    return rows.map(rowToEvent);
  });
}

export interface PendingOptions {
  /**
   * Visibility instant. OMITTED means "every undelivered message", which is
   * what the in-memory outbox returns and therefore what the port method does.
   *
   * A dispatcher passes the instant it started, and gets the redelivery
   * semantics 012 built the `visible_at` column for. It is a parameter rather
   * than `now()` because this package never reads the clock — and because
   * `now()` is frozen for a whole transaction, so a dispatcher that leaned on
   * it would compare every message against the instant its transaction opened.
   */
  readonly asOf?: string | null;
  readonly limit?: number;
}

/**
 * A PEEK: `select`, and nothing else. Calling it twice returns the same rows.
 *
 * `delivered_at is null and dead_at is null` matches `outbox_pending_idx`
 * exactly, so this is the same scan a `for update skip locked` dispatcher will
 * make. Ordered by `msg_id`, which is `generated always as identity` — FIFO
 * within a queue with no tiebreak needed, and the same order the memory store's
 * array gives.
 *
 * NOTE the port's `QueueMessage` has no `msg_id`, so a dispatcher cannot mark
 * what this returns as delivered. That is a gap in the port rather than here;
 * it is in the README.
 */
export async function pendingMessages(
  queue: string,
  options: PendingOptions = {},
  ex: Executor = db(),
): Promise<QueueMessage[]> {
  const asOf = options.asOf ?? null;
  // Nested `SqlQuery` fragments, because a placeholder can carry a value but
  // never a clause, and there is deliberately no `sql.raw`.
  const visibility: SqlQuery = asOf === null ? sql`` : sql`and visible_at <= ${asOf}::timestamptz`;
  const limit: SqlQuery =
    options.limit === undefined ? sql`` : sql`limit ${Math.max(0, Math.floor(options.limit))}`;

  return guard('pending', async () => {
    const rows = await ex.query(sql`
      select ${MESSAGE_COLUMNS} from outbox_message
       where queue = ${queue}
         and delivered_at is null
         and dead_at is null
         ${visibility}
       order by msg_id
       ${limit}`);
    return rows.map(rowToQueueMessage);
  });
}

/**
 * The port, bound to an executor.
 *
 * `executor` is resolved PER CALL, not captured at construction: a store built
 * at module scope and used inside a `withTx` must enlist in that transaction,
 * and `db()` only knows which one is running while it is running. Written as
 * `createPostgresOutbox(ex = db())` the default would bind the pool once,
 * forever, and every append through this store would silently escape the
 * caller's transaction — which for THIS port would also silently un-guarantee
 * its one guarantee.
 */
export function createPostgresOutbox(executor?: Executor): Outbox {
  const ex = (): Executor => executor ?? db();

  return {
    append: (event, messages) => appendEvent(event, messages, ex()),
    byCorrelation: (correlationId) => eventsByCorrelation(correlationId, ex()),
    pending: (queue) => pendingMessages(queue, {}, ex()),
    all: () => allEvents(ex()),
  };
}
