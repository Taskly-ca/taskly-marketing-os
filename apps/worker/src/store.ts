/**
 * THE THREE READS AND TWO WRITES `@tmos/adapters` DOES NOT HAVE.
 *
 * Everything else the runner touches goes through a published repository
 * function — `sourceById`, `dueSources`, `recordCollection`,
 * `collectionOutcomeFor`, `collectorCursor`, `appendEventInTx`. These five do
 * not exist there, and each one is a gap that is named in the report rather
 * than papered over:
 *
 *   ensureSource        there is NO way to create a `source` row. The adapter
 *                       reads and updates them; nothing anywhere inserts one
 *                       outside a test fixture. A registry that cannot register
 *                       is why every table was empty.
 *   lastAttemptAt       `source` records `last_ok_at`, never `last_attempt_at`,
 *                       so the backoff clock has to be reconstructed from the
 *                       append-only event log. See `backoff.ts`.
 *   recentContent       the `signal` table has the three indexes this query
 *                       wants (`signal_content_hash_idx`, `signal_simhash_idx`,
 *                       `signal_source_time_idx`) and no reader.
 *   insertSignal        migration 012 created `signal` for exactly this and no
 *                       code path wrote one.
 *   persistSignal       the outbox append and the signal insert, in ONE
 *                       transaction, with the replay check deciding both.
 *
 * SQL LIVES HERE AND NOWHERE ELSE IN THIS APP. The house rule is that domain
 * packages never see `pg`; an app that is already the composition root may
 * speak to `@tmos/db` directly, but it should do it in one file so "what does
 * the worker write" is a single read. When these move into `@tmos/adapters`,
 * this file disappears rather than shrinking.
 */
import { randomUUID } from 'node:crypto';

import { rowToSourceState, type SourceCollectionState } from '@tmos/adapters';
import { appendEventInTx } from '@tmos/adapters';
import { db, sql, withTx, type Executor } from '@tmos/db';
import type { EventRow, QueueMessage } from '@tmos/gate';

import type { SeenContent } from './gate.js';
import type { WatchEntry } from './watchlist.js';

/**
 * How far back the near-duplicate window reaches.
 *
 * Long enough that a story re-syndicated the next morning is still recognised,
 * short enough that the linear SimHash scan stays trivial and that a genuinely
 * recurring topic ("Toronto snow removal", every winter) is not suppressed
 * forever by a headline from last season.
 */
export const NEAR_DUP_WINDOW_DAYS = 14;

/** Ceiling on the window, so a busy month cannot turn the scan into a scan. */
const NEAR_DUP_WINDOW_MAX = 5_000;

/** The `source` projection `rowToSourceState` decodes. Mirrors the adapter's. */
const SOURCE_COLUMNS = sql`
  id::text as id,
  kind,
  name,
  tier,
  region,
  cursor,
  etag,
  last_ok_at,
  consecutive_failures,
  visibility,
  derives_from::text as derives_from,
  reliability_alpha,
  reliability_beta`;

/**
 * Find or create the `source` row for a watchlist entry.
 *
 * Keyed on `(kind, name)`, which is the registry's natural key — and which has
 * NO unique index in 001, so this is a select-then-insert rather than an
 * `on conflict`. That is a real race: two workers starting cold at the same
 * instant would both insert. It is acceptable today because the runner is a
 * single pass invoked by a scheduler, and it is in the report as the one-line
 * migration (`unique (kind, name)`) that would close it.
 */
export async function ensureSource(entry: WatchEntry, ex: Executor = db()): Promise<SourceCollectionState> {
  const { kind, name } = entry.collector;
  const existing = await ex.maybeOne(sql`select ${SOURCE_COLUMNS} from source where kind = ${kind} and name = ${name}`);
  if (existing !== null) return rowToSourceState(existing);

  const created = await ex.one(sql`
    insert into source (kind, name, tier, region)
    values (${kind}, ${name}, ${entry.tier}, ${entry.region})
    returning ${SOURCE_COLUMNS}`);
  return rowToSourceState(created);
}

/** Event types the runner appends, and therefore the attempt log's alphabet. */
export const COLLECTED_EVENT = 'source.collected';
export const FAILED_EVENT = 'source.collect_failed';
export const SIGNAL_EVENT = 'signal.collected';

/** The queue a surviving signal is handed to. `investigationSchema.budget_tier`. */
export const SKIM_QUEUE = 't1_skim';

/**
 * When each source was last ATTEMPTED, from the append-only log.
 *
 * `occurred_at` rather than `recorded_at`: the runner stamps `occurred_at` with
 * the instant the attempt started, which is the thing backoff measures from.
 */
export async function lastAttemptAt(
  sourceIds: readonly string[],
  ex: Executor = db(),
): Promise<Map<string, string>> {
  if (sourceIds.length === 0) return new Map();

  const rows = await ex.query<{ source_id: string; at: string }>(sql`
    select source_id::text as source_id, max(occurred_at)::text as at
      from events
     where type in (${COLLECTED_EVENT}, ${FAILED_EVENT})
       and source_id = any(${[...sourceIds]}::uuid[])
     group by source_id`);

  return new Map(rows.map((r) => [r.source_id, r.at]));
}

/**
 * The dedup memory, loaded once per pass.
 *
 * Content hashes and canonical URLs are exact keys and cheap to hold; the
 * SimHash window is the one with a size argument, so it is bounded twice (by
 * age and by count) and ordered newest-first, because the near-dup an item is
 * most likely to have is yesterday's.
 *
 * ── THE WINDOW IS ON `created_at`, NOT `observed_at`. THIS WAS A BUG. ───────
 *
 * `observed_at` is when the WORLD published the item; `created_at` is when we
 * wrote it down. Windowing on the former asks "what was published recently",
 * and that is not the question — the question is "what have we already seen",
 * and a feed hands us plenty of items that are old news to the world and brand
 * new to us.
 *
 * Measured on the first two live passes, 2026-08-22. `rss:betakit` returns 150
 * items spanning 2026-07-09 to 2026-08-20, of which exactly 48 fall inside 14
 * days. On the second pass the gate dropped exactly 48 and passed 102 straight
 * through — the other 102 were in the database and invisible to it. Worse,
 * `hn:home-services-marketplace` returns stories published 2009–2025: ZERO fall
 * inside any recent window, so the gate could never drop a single one of them,
 * ever, no matter how many times we collected the same twenty.
 *
 * Nothing was double-written — every one of the 166 was caught by the
 * idempotency key inside the transaction, which is exactly what that backstop
 * is for. But it was caught at the most expensive of the three layers instead
 * of the cheapest, which is the whole cost argument for having a gate.
 *
 * `signal` has no index on `created_at` (012 built three, all on the other
 * columns), so this is a scan bounded by `limit`. Irrelevant at hundreds of
 * rows and a migration at millions; it is in the report.
 */
export async function recentContent(
  sinceIso: string,
  limit = NEAR_DUP_WINDOW_MAX,
  ex: Executor = db(),
): Promise<SeenContent> {
  const rows = await ex.query<{ content_hash: string; canonical_url: string | null; simhash: string }>(sql`
    select content_hash, canonical_url, simhash::text as simhash
      from signal
     where created_at >= ${sinceIso}::timestamptz
     order by created_at desc
     limit ${Math.max(0, Math.floor(limit))}`);

  const seen: SeenContent = { contentHashes: new Set(), canonicalUrls: new Set(), signatures: [] };
  for (const row of rows) {
    seen.contentHashes.add(row.content_hash);
    if (row.canonical_url !== null) seen.canonicalUrls.add(row.canonical_url);
    seen.signatures.push(row.simhash);
  }
  return seen;
}

export interface NewSignal {
  readonly id: string;
  readonly sourceId: string;
  readonly observedAt: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly contentHash: string;
  readonly simhash: string;
  readonly payload: Record<string, unknown>;
}

export const newSignalId = (): string => randomUUID();

/**
 * ONE OBSERVATION, PERSISTED ATOMICALLY — and the replay check that makes a
 * second pass cheap.
 *
 * `appendEventInTx` runs FIRST and its boolean decides everything after it. A
 * `false` means the idempotency key was already there, which is a REPLAY, not
 * an error: the same item arriving from the same source with the same content
 * on a later pass. On a replay nothing is written — no duplicate signal, and
 * critically no re-enqueued skim message, because re-delivering the work of an
 * event we already recorded is what would make a second pass cost money.
 *
 * Both writes are inside `withTx`, so the event, its queue message and the
 * signal commit together or not at all. The `signal → source` foreign key and
 * `outbox_message → events` are what make that structural rather than hopeful.
 */
export async function persistSignal(
  signal: NewSignal,
  event: EventRow,
  messages: readonly QueueMessage[],
): Promise<boolean> {
  return withTx(async (tx) => {
    const appended = await appendEventInTx(event, messages, tx);
    if (!appended) return false;

    await tx.execute(sql`
      insert into signal (id, source_id, observed_at, url, canonical_url, content_hash, simhash, payload, subject_refs)
      values (
        ${signal.id}::uuid,
        ${signal.sourceId}::uuid,
        ${signal.observedAt}::timestamptz,
        ${signal.url},
        ${signal.canonicalUrl},
        ${signal.contentHash},
        ${signal.simhash}::bigint,
        ${JSON.stringify(signal.payload)}::jsonb,
        -- Entity resolution is Part 3's job and runs on the signal AFTER it
        -- lands. Guessing subjects here would be an unsourced claim at ingest,
        -- which is the one thing consolidation is built to refuse.
        ${'{}'}::text[]
      )`);
    return true;
  });
}

/** The per-attempt event. No signal, no queue message — just the record that we
 *  tried, which is also the backoff clock. */
export async function appendAttempt(event: EventRow): Promise<boolean> {
  return withTx((tx) => appendEventInTx(event, [], tx));
}
