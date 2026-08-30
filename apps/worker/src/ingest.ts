/**
 * THE INGEST PASS — collect → gate → persist.
 *
 * This is the pipeline Part 2 built in five separate packages and could never
 * run, because nothing owned the three things that only a runner can own: which
 * sources to ask, what to do with the cursor they hand back, and how to write
 * the survivors down atomically.
 *
 * ── THE PASS, IN ORDER ──────────────────────────────────────────────────────
 *
 *  0. REGISTER   every watchlist entry gets (or finds) its `source` row. An
 *                unconfigured collector is SKIPPED and reported — never a
 *                failure, and never silently absent from the day's coverage.
 *  1. SCHEDULE   `dueVerdict` per source, from `consecutive_failures` and the
 *                last attempt in the event log. A failing source is held back.
 *  2. COLLECT    the collector runs with the persisted cursor/etag in its
 *                context, through the policy-enforcing transport. One host at a
 *                time, ≥2s apart, robots.txt obeyed, honest UA.
 *  3. GATE       canonical URL → content hash → SimHash near-dup, against a
 *                memory loaded from `signal` and extended as the pass runs.
 *  4. RECORD     one `source.collected` / `source.collect_failed` event per
 *                attempt. This is both the audit trail and the backoff clock.
 *  5. PERSIST    per survivor, in ONE transaction: the `events` row, its
 *                `t1_skim` queue message, and the `signal` row. A duplicate
 *                idempotency key returns false and writes nothing — a replay.
 *  6. ADVANCE    `recordCollection` moves the cursor, the etag and the failure
 *                streak. A 304 stamps `last_ok_at` and does NOT touch the
 *                cursor: there was nothing to advance past.
 *
 * ── WHAT MAKES THE SECOND PASS CHEAP ────────────────────────────────────────
 *
 * Three independent mechanisms, in increasing cost, and each one is a backstop
 * for the next:
 *
 *   the ETAG never puts the item on the wire at all (304, zero bytes);
 *   the GATE drops it before it reaches a transaction (content hash);
 *   the IDEMPOTENCY KEY drops it inside the transaction (no signal, and no
 *   re-enqueued skim message, which is where the money would have gone).
 *
 * They are all kept because they fail in different places: a source with no
 * ETag support still gets the second, and a gate memory bounded by a 14-day
 * window still gets the third.
 */
import { randomUUID } from 'node:crypto';

import {
  collectionOutcomeFor,
  collectorCursor,
  dueSources,
  recordCollection,
  type SourceCollectionState,
} from '@tmos/adapters';
import { fail, type CollectResult, type CollectorContext } from '@tmos/collectors';
import { buildEvent, idempotencyKey, type EventRow, type QueueMessage } from '@tmos/gate';

import { dueVerdict } from './backoff.js';
import { dropHistogram, runGate, type GateOutcome } from './gate.js';
import {
  COLLECTED_EVENT,
  FAILED_EVENT,
  NEAR_DUP_WINDOW_DAYS,
  SIGNAL_EVENT,
  SKIM_QUEUE,
  appendAttempt,
  ensureSource,
  lastAttemptAt,
  newSignalId,
  persistSignal,
  recentContent,
} from './store.js';
import type { Transport } from '@tmos/collectors';
import { watchlist, type WatchEntry } from './watchlist.js';

export interface IngestOptions {
  /** Only sources of this `kind` (`rss` | `hn` | `gdelt` | …). */
  readonly only?: string;
  /** Stop after this many sources. Applied after the due filter. */
  readonly limit?: number;
  /**
   * Ignore the backoff hold. An operator override for "I fixed the thing, try
   * it now" — and the only way to observe conditional GET twice inside one
   * sitting, since a healthy source is due on every pass anyway and a failing
   * one is exactly what the hold is for.
   */
  readonly force?: boolean;
}

export interface SourceOutcomeReport {
  readonly source: string;
  readonly kind: string;
  readonly status: 'collected' | 'not_modified' | 'failed' | 'held' | 'skipped' | 'orphan';
  readonly detail: string;
  readonly collected: number;
  readonly kept: number;
  readonly dropped: Record<string, number>;
  readonly written: number;
  readonly replays: number;
  readonly cursorBefore: { cursor: string | null; etag: string | null };
  readonly cursorAfter: { cursor: string | null; etag: string | null };
  readonly consecutiveFailures: number;
  readonly ms: number;
}

/**
 * Source kinds produced by a pass other than this one.
 *
 * Kept as data rather than inferred from the watchlist: if a whole KIND
 * disappeared from the watchlist, that is real drift and must still be
 * reported, which an "ignore any kind not in the watchlist" rule would hide.
 */
const NOT_COLLECTED_HERE: ReadonlySet<string> = new Set(['watch']);

export interface IngestReport {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly forced: boolean;
  readonly skipped: readonly string[];
  readonly sources: readonly SourceOutcomeReport[];
  readonly requests: number;
  readonly totals: {
    readonly collected: number;
    readonly kept: number;
    readonly dropped: number;
    readonly signals: number;
    readonly events: number;
    readonly replays: number;
  };
}

/** Injected so the whole pass is testable without a network or a database. */
export interface IngestDeps {
  readonly now: () => Date;
  readonly transport: Transport;
  readonly env: Record<string, string | undefined>;
  readonly entries?: (env: Record<string, string | undefined>) => WatchEntry[];
  readonly ensure?: typeof ensureSource;
  readonly attempts?: typeof lastAttemptAt;
  readonly seen?: typeof recentContent;
  readonly record?: typeof recordCollection;
  readonly registered?: typeof dueSources;
  readonly persist?: typeof persistSignal;
  readonly attempt?: typeof appendAttempt;
  /** Deterministic in tests; production draws from the clock. */
  readonly jitter?: () => number;
}

const cursorOf = (s: SourceCollectionState): { cursor: string | null; etag: string | null } => ({
  cursor: s.cursor,
  etag: s.etag,
});

/**
 * A collection that failed WHILE the transport recorded a policy refusal is a
 * policy refusal, whatever the collector called it.
 *
 * Collectors wrap `ctx.fetchText` in their own try/catch and turn any throw
 * into `fail('network', …)`, so without this a robots.txt `Disallow` would be
 * recorded — and retried, and eventually alerted on — as a network blip. The
 * relabel only ever applies to an already-failed result: a denial that did not
 * cause a failure (a redirect hop we declined, say) changes nothing.
 */
function relabel(result: CollectResult, denials: readonly string[]): CollectResult {
  if (result.ok || denials.length === 0) return result;
  return fail('blocked_by_policy', denials.join('; '), false);
}

function describe(result: CollectResult): string {
  if (!result.ok) return `${result.reason}: ${result.detail}`;
  if (result.notModified === true) return '304 not modified';
  return `${result.items.length} item(s)`;
}

/** The per-attempt event. Its `occurred_at` IS the backoff clock. */
function attemptEvent(
  source: SourceCollectionState,
  result: CollectResult,
  gate: GateOutcome | null,
  startedAt: string,
  runId: string,
  now: Date,
): EventRow {
  return buildEvent(
    {
      type: result.ok ? COLLECTED_EVENT : FAILED_EVENT,
      occurredAt: startedAt,
      sourceId: source.id,
      correlationId: runId,
      // One attempt per source per pass, and the pass's start instant is what
      // makes the key unique — a re-run of the same pass would be the same
      // attempt and should collapse.
      idempotencyKey: idempotencyKey({ source: source.name, externalId: `attempt:${startedAt}` }),
      payload: result.ok
        ? {
            source: source.name,
            kind: source.kind,
            notModified: result.notModified === true,
            items: result.items.length,
            kept: gate?.kept.length ?? 0,
            dropped: dropHistogram(gate?.dropped ?? []),
            cursor: result.cursor ?? null,
            etag: result.etag ?? null,
          }
        : {
            source: source.name,
            kind: source.kind,
            // `reason`, `detail` and `retryable` have no column on `source` and
            // should not get one — a single mutable column only ever remembers
            // the last failure. This is where they live.
            reason: result.reason,
            detail: result.detail,
            retryable: result.retryable,
          },
    },
    now,
  );
}

export async function ingest(options: IngestOptions, deps: IngestDeps): Promise<IngestReport> {
  const ensure = deps.ensure ?? ensureSource;
  const attempts = deps.attempts ?? lastAttemptAt;
  const seenSince = deps.seen ?? recentContent;
  const record = deps.record ?? recordCollection;
  const registered = deps.registered ?? dueSources;
  const persist = deps.persist ?? persistSignal;
  const attempt = deps.attempt ?? appendAttempt;
  const entriesFor = deps.entries ?? watchlist;
  const jitter = deps.jitter ?? Math.random;

  // ONE correlation id for the whole pass, so `eventsByCorrelation(runId)`
  // returns the entire run as a single query. That is the reason the column
  // exists, and the reason an agent run is investigable at all.
  const runId = randomUUID();
  const startedAt = deps.now().toISOString();

  const all = entriesFor(deps.env);
  const configured: WatchEntry[] = [];
  const skipped: string[] = [];
  for (const entry of all) {
    if (entry.collector.isConfigured(deps.env)) configured.push(entry);
    else skipped.push(entry.collector.name);
  }

  const selected = options.only === undefined ? configured : configured.filter((e) => e.collector.kind === options.only);

  // 0. Register. A source row is created only for a collector that can run —
  //    registering one we cannot collect would put a permanently-stale row in
  //    the scheduler's view.
  const states = new Map<WatchEntry, SourceCollectionState>();
  for (const entry of selected) states.set(entry, await ensure(entry));

  // 1. Schedule.
  const lastAttempts = await attempts([...states.values()].map((s) => s.id));
  const sources: SourceOutcomeReport[] = [];
  const due: WatchEntry[] = [];
  for (const entry of selected) {
    const state = states.get(entry);
    if (state === undefined) continue;
    const verdict = dueVerdict(
      { consecutiveFailures: state.consecutive_failures, lastAttemptAt: lastAttempts.get(state.id) ?? null },
      deps.now(),
      jitter(),
    );
    if (verdict.due || options.force === true) {
      due.push(entry);
      continue;
    }
    sources.push({
      source: state.name,
      kind: state.kind,
      status: 'held',
      detail: verdict.reason,
      collected: 0,
      kept: 0,
      dropped: {},
      written: 0,
      replays: 0,
      cursorBefore: cursorOf(state),
      cursorAfter: cursorOf(state),
      consecutiveFailures: state.consecutive_failures,
      ms: 0,
    });
  }

  const runnable = options.limit === undefined ? due : due.slice(0, Math.max(0, options.limit));

  // 3 (memory). Loaded once, before the first collection, and mutated by the
  // gate as the pass runs so two feeds carrying one wire story collapse.
  //
  // The window is "what have WE recorded in the last 14 days", not "what was
  // published in the last 14 days" — a feed routinely hands us items older than
  // any recency window, and they are still items we already hold. See
  // `recentContent`, and the pass that measured it.
  const windowStart = new Date(deps.now().getTime() - NEAR_DUP_WINDOW_DAYS * 86_400_000).toISOString();
  const seen = await seenSince(windowStart);

  let signals = 0;
  let events = 0;
  let replays = 0;

  for (const entry of runnable) {
    const state = states.get(entry);
    if (state === undefined) continue;

    const attemptStartedAt = deps.now().toISOString();
    const began = Date.now();

    // 2. Collect. The cursor and etag we kept go IN; whatever comes back comes
    //    OUT. This three-line seam is the entire point of the task.
    const ctx: CollectorContext = {
      fetchText: deps.transport.fetchText,
      now: deps.now,
      ...collectorCursor(state),
    };

    let result: CollectResult;
    try {
      result = await entry.collector.collect(ctx);
    } catch (error) {
      // A collector is contractually not supposed to throw. If one does, the
      // pass must not die with it — a single bad source cannot cost the day.
      result = fail('network', `collector threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    result = relabel(result, deps.transport.drainDenials());

    // 3. Gate.
    const gate = result.ok ? runGate(result.items, seen) : null;

    // 4. Record the attempt BEFORE the items, so `causation_id` points at an
    //    event that already exists and the chain renders in order.
    const attemptRow = attemptEvent(state, result, gate, attemptStartedAt, runId, deps.now());
    if (await attempt(attemptRow)) events += 1;

    // 5. Persist survivors.
    let written = 0;
    let replayed = 0;
    for (const kept of gate?.kept ?? []) {
      const signalId = newSignalId();
      const event = buildEvent(
        {
          type: SIGNAL_EVENT,
          occurredAt: kept.item.publishedAt ?? attemptStartedAt,
          sourceId: state.id,
          correlationId: runId,
          causationId: attemptRow.id,
          contentHash: kept.contentHash,
          idempotencyKey: idempotencyKey({
            source: state.name,
            externalId: kept.item.externalId,
            contentHash: kept.contentHash,
          }),
          payload: { signalId, source: state.name, url: kept.canonicalUrl, title: kept.item.title },
        },
        deps.now(),
      );
      // The queue body is a POINTER, not the content: the payload is already in
      // `signal`, and duplicating a body into the outbox would make the queue
      // the second place an item's text lives and the second place retention
      // has to reach.
      const messages: QueueMessage[] = [
        { queue: SKIM_QUEUE, eventId: event.id, body: { signalId, contentHash: kept.contentHash } },
      ];

      const stored = await persist(
        {
          id: signalId,
          sourceId: state.id,
          observedAt: kept.item.publishedAt ?? attemptStartedAt,
          url: kept.item.url,
          canonicalUrl: kept.canonicalUrl,
          contentHash: kept.contentHash,
          simhash: kept.simhash,
          payload: {
            externalId: kept.item.externalId,
            title: kept.item.title,
            body: kept.item.body,
            meta: kept.item.meta,
            collector: state.name,
            piiRedacted: kept.piiRedacted,
          },
        },
        event,
        messages,
      );

      if (stored) {
        written += 1;
        signals += 1;
        events += 1;
      } else {
        replayed += 1;
        replays += 1;
      }
    }

    // 6. Advance. `collectionOutcomeFor` is the only place the collector
    //    vocabulary and the source table's vocabulary meet — and the only place
    //    that knows a 304 must not move the cursor.
    const outcome = collectionOutcomeFor(result, attemptStartedAt);
    const after = await record(state.id, outcome);

    sources.push({
      source: state.name,
      kind: state.kind,
      status: result.ok ? (result.notModified === true ? 'not_modified' : 'collected') : 'failed',
      detail: describe(result),
      collected: result.ok ? result.items.length : 0,
      kept: gate?.kept.length ?? 0,
      dropped: dropHistogram(gate?.dropped ?? []),
      written,
      replays: replayed,
      cursorBefore: cursorOf(state),
      cursorAfter: cursorOf(after),
      consecutiveFailures: after.consecutive_failures,
      ms: Date.now() - began,
    });
  }

  // REGISTRY DRIFT. `dueSources` is the scheduler's read of the table, and it
  // cannot drive this pass: `source` has no column saying which feed url or
  // query a row points at, so a row it returns may have no collector to run.
  // That is exactly what makes it the right tool for the opposite question —
  // which rows the table holds that the watchlist no longer claims. A source
  // dropped from the watchlist stops being collected and nothing says so; this
  // is the line that says so. Skipped for a filtered pass, where every other
  // kind would look orphaned.
  if (options.only === undefined) {
    const claimed = new Set(all.map((e) => `${e.collector.kind}\u0000${e.collector.name}`));
    for (const row of await registered({})) {
      if (claimed.has(`${row.kind}\u0000${row.name}`)) continue;
      // A source another pass owns is not drift. `watch` rows are written by
      // the competitor watcher, which reads documents this pass has no
      // collector for — reporting them as orphaned says "nothing collects this
      // any more" about something collected an hour ago, and a report that
      // cries wolf on every run is one nobody reads to the bottom of.
      if (NOT_COLLECTED_HERE.has(row.kind)) continue;
      sources.push({
        source: row.name,
        kind: row.kind,
        status: 'orphan',
        detail: 'row in `source` with no watchlist entry — registered once, never collected again',
        collected: 0,
        kept: 0,
        dropped: {},
        written: 0,
        replays: 0,
        cursorBefore: cursorOf(row),
        cursorAfter: cursorOf(row),
        consecutiveFailures: row.consecutive_failures,
        ms: 0,
      });
    }
  }

  for (const name of skipped) {
    sources.push({
      source: name,
      kind: 'unconfigured',
      status: 'skipped',
      detail: 'no credential in env — skipped, not failed',
      collected: 0,
      kept: 0,
      dropped: {},
      written: 0,
      replays: 0,
      cursorBefore: { cursor: null, etag: null },
      cursorAfter: { cursor: null, etag: null },
      consecutiveFailures: 0,
      ms: 0,
    });
  }

  const collected = sources.reduce((n, s) => n + s.collected, 0);
  const kept = sources.reduce((n, s) => n + s.kept, 0);
  const dropped = sources.reduce((n, s) => n + Object.values(s.dropped).reduce((a, b) => a + b, 0), 0);

  return {
    runId,
    startedAt,
    finishedAt: deps.now().toISOString(),
    forced: options.force === true,
    skipped,
    sources,
    requests: deps.transport.requestCount(),
    totals: { collected, kept, dropped, signals, events, replays },
  };
}
