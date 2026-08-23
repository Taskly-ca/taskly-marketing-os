/**
 * The pass, end to end, with fakes for the two things that need infrastructure.
 * No database, no network, no key — so this runs in CI beside everything else.
 */
import { randomUUID } from 'node:crypto';

import type { CollectionOutcome, SourceCollectionState } from '@tmos/adapters';
import { ok, notModified, fail, type Collector, type CollectResult } from '@tmos/collectors';
import type { EventRow, QueueMessage } from '@tmos/gate';
import { describe, expect, it } from 'vitest';

import { emptySeen } from './gate.js';
import { ingest, type IngestDeps } from './ingest.js';
import type { NewSignal } from './store.js';
import type { Transport } from './transport.js';
import type { WatchEntry } from './watchlist.js';

const NOW = new Date('2026-08-22T12:00:00.000Z');

function stubCollector(kind: string, name: string, results: CollectResult[], configured = true): Collector {
  let i = 0;
  return {
    kind,
    name,
    isConfigured: () => configured,
    collect: async () => results[Math.min(i++, results.length - 1)] ?? ok([]),
  };
}

function entry(collector: Collector): WatchEntry {
  return { collector, tier: 'aggregator', region: 'ca', question: 'test' };
}

function stubState(over: Partial<SourceCollectionState> = {}): SourceCollectionState {
  return {
    id: randomUUID(),
    kind: 'rss',
    name: 'rss:test',
    tier: 'aggregator',
    region: 'ca',
    cursor: null,
    etag: null,
    last_ok_at: null,
    consecutive_failures: 0,
    visibility: 'internal',
    derives_from: null,
    reliability: { alpha: 1, beta: 1 },
    ...over,
  };
}

const stubTransport = (denials: string[] = []): Transport => ({
  fetchText: async () => ({ status: 200, body: '', headers: {} }),
  drainDenials: () => denials.splice(0, denials.length),
  requestCount: () => 0,
});

interface Harness {
  deps: IngestDeps;
  signals: NewSignal[];
  events: EventRow[];
  messages: QueueMessage[];
  outcomes: { id: string; outcome: CollectionOutcome }[];
  states: Map<string, SourceCollectionState>;
}

function harness(entries: WatchEntry[], over: Partial<IngestDeps> = {}): Harness {
  const states = new Map<string, SourceCollectionState>();
  const signals: NewSignal[] = [];
  const events: EventRow[] = [];
  const messages: QueueMessage[] = [];
  const outcomes: { id: string; outcome: CollectionOutcome }[] = [];
  const keys = new Set<string>();

  // Whatever `ensure` a case supplies, its result is registered here — the fake
  // `record` has to find the state by id the way the real table does.
  const baseEnsure: NonNullable<IngestDeps['ensure']> =
    over.ensure ??
    (async (e) => states.get(e.collector.name) ?? stubState({ kind: e.collector.kind, name: e.collector.name }));

  const deps: IngestDeps = {
    now: () => NOW,
    transport: stubTransport(),
    env: {},
    entries: () => entries,
    jitter: () => 0,
    attempts: async () => new Map(),
    seen: async () => emptySeen(),
    registered: async () => [],
    record: async (id, outcome) => {
      outcomes.push({ id, outcome });
      const state = [...states.values()].find((s) => s.id === id);
      if (state === undefined) throw new Error('no such source');
      const next: SourceCollectionState = {
        ...state,
        cursor: outcome.kind === 'collected' ? (outcome.cursor ?? state.cursor) : state.cursor,
        etag: outcome.kind === 'failed' ? state.etag : (outcome.etag ?? state.etag),
        consecutive_failures: outcome.kind === 'failed' ? state.consecutive_failures + 1 : 0,
      };
      states.set(state.name, next);
      return next;
    },
    persist: async (signal, event, msgs) => {
      if (keys.has(event.idempotencyKey)) return false;
      keys.add(event.idempotencyKey);
      signals.push(signal);
      events.push(event);
      messages.push(...msgs);
      return true;
    },
    attempt: async (event) => {
      if (keys.has(event.idempotencyKey)) return false;
      keys.add(event.idempotencyKey);
      events.push(event);
      return true;
    },
    ...over,
    ensure: async (e) => {
      const state = await baseEnsure(e);
      states.set(state.name, state);
      return state;
    },
  };

  return { deps, signals, events, messages, outcomes, states };
}

const item = (id: string, url: string, body: string) => ({
  externalId: id,
  url,
  title: `Story ${id}`,
  body,
  publishedAt: '2026-08-21T09:00:00.000Z',
  meta: {},
});

describe('ingest', () => {
  it('skips an unconfigured collector instead of failing the run', async () => {
    const entries = [entry(stubCollector('gsc', 'gsc:taskly', [ok([])], false))];
    const h = harness(entries);
    const report = await ingest({}, h.deps);

    expect(report.skipped).toEqual(['gsc:taskly']);
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.status).toBe('skipped');
    expect(h.outcomes).toEqual([]);
  });

  it('writes one signal, one signal event and one queue message per survivor', async () => {
    const entries = [
      entry(
        stubCollector('rss', 'rss:one', [
          ok([item('a', 'https://a.test/1', 'first story about plumbing in Scarborough')], { etag: 'W/"v1"' }),
        ]),
      ),
    ];
    const h = harness(entries);
    const report = await ingest({}, h.deps);

    expect(report.totals).toMatchObject({ collected: 1, kept: 1, signals: 1, replays: 0 });
    // Two events: the attempt, and the item.
    expect(h.events.map((e) => e.type)).toEqual(['source.collected', 'signal.collected']);
    expect(h.messages).toEqual([
      { queue: 't1_skim', eventId: h.events[1]?.id, body: { signalId: h.signals[0]?.id, contentHash: h.signals[0]?.contentHash } },
    ]);
    // The item event's causation points at the attempt that produced it.
    expect(h.events[1]?.causationId).toBe(h.events[0]?.id);
    // One pass, one correlation id.
    expect(new Set(h.events.map((e) => e.correlationId))).toEqual(new Set([report.runId]));
  });

  it('hands the persisted cursor and etag to the collector', async () => {
    let seenCtx: { cursor?: string; etag?: string } | null = null;
    const collector: Collector = {
      kind: 'rss',
      name: 'rss:cursored',
      isConfigured: () => true,
      collect: async (ctx) => {
        seenCtx = { cursor: ctx.cursor, etag: ctx.etag };
        return notModified('W/"same"');
      },
    };
    const h = harness([entry(collector)], {
      ensure: async () => stubState({ name: 'rss:cursored', cursor: 'day:2026-08-20', etag: 'W/"prev"' }),
    });

    await ingest({}, h.deps);
    expect(seenCtx).toEqual({ cursor: 'day:2026-08-20', etag: 'W/"prev"' });
  });

  it('a 304 is a success that clears the failure streak and never advances the cursor', async () => {
    const h = harness([entry(stubCollector('rss', 'rss:304', [notModified('W/"v2"')]))], {
      ensure: async () => stubState({ name: 'rss:304', cursor: 'keep-me', etag: 'W/"v1"', consecutive_failures: 4 }),
    });
    const report = await ingest({}, h.deps);

    expect(report.sources[0]?.status).toBe('not_modified');
    expect(h.outcomes[0]?.outcome).toEqual({ kind: 'not_modified', at: NOW.toISOString(), etag: 'W/"v2"' });
    expect(report.sources[0]?.cursorAfter).toEqual({ cursor: 'keep-me', etag: 'W/"v2"' });
    expect(report.sources[0]?.consecutiveFailures).toBe(0);
  });

  it('records a failure as a failure, with the reason in the event and not on the source row', async () => {
    const h = harness([entry(stubCollector('rss', 'rss:down', [fail('network', 'connect ECONNREFUSED')]))]);
    const report = await ingest({}, h.deps);

    expect(report.sources[0]?.status).toBe('failed');
    expect(h.outcomes[0]?.outcome).toEqual({ kind: 'failed' });
    expect(h.events[0]).toMatchObject({
      type: 'source.collect_failed',
      payload: { reason: 'network', detail: 'connect ECONNREFUSED', retryable: true },
    });
  });

  it('relabels a failure as blocked_by_policy when the transport refused', async () => {
    const denials = ['https://trade.test/feed/: robots.txt disallows /feed/'];
    const h = harness([entry(stubCollector('rss', 'rss:blocked', [fail('network', 'fetch failed')]))], {
      transport: stubTransport(denials),
    });
    await ingest({}, h.deps);

    expect(h.events[0]?.payload).toMatchObject({ reason: 'blocked_by_policy', retryable: false });
  });

  it('survives a collector that throws, and keeps going', async () => {
    const thrower: Collector = {
      kind: 'rss',
      name: 'rss:throws',
      isConfigured: () => true,
      collect: async () => {
        throw new Error('boom');
      },
    };
    const h = harness([entry(thrower), entry(stubCollector('rss', 'rss:fine', [ok([item('z', 'https://z.test/1', 'a story')])]))]);
    const report = await ingest({}, h.deps);

    expect(report.sources[0]?.status).toBe('failed');
    expect(report.sources[0]?.detail).toContain('collector threw');
    expect(report.sources[1]?.status).toBe('collected');
    expect(report.totals.signals).toBe(1);
  });

  it('holds a failing source back, and --force overrides the hold', async () => {
    const collector = stubCollector('rss', 'rss:failing', [ok([])]);
    const state = stubState({ name: 'rss:failing', consecutive_failures: 5 });
    const held = harness([entry(collector)], {
      ensure: async () => state,
      attempts: async () => new Map([[state.id, new Date(NOW.getTime() - 60_000).toISOString()]]),
    });
    const report = await ingest({}, held.deps);
    expect(report.sources[0]?.status).toBe('held');
    expect(held.outcomes).toEqual([]);

    const forced = harness([entry(collector)], {
      ensure: async () => state,
      attempts: async () => new Map([[state.id, new Date(NOW.getTime() - 60_000).toISOString()]]),
    });
    const forcedReport = await ingest({ force: true }, forced.deps);
    expect(forcedReport.sources[0]?.status).toBe('collected');
    expect(forcedReport.forced).toBe(true);
  });

  it('treats a repeated idempotency key as a replay, not an error, and writes nothing', async () => {
    const body = 'demand for handyman work across the GTA rose through August';
    const entries = [entry(stubCollector('rss', 'rss:replay', [ok([item('a', 'https://a.test/1', body)])]))];
    const h = harness(entries);

    const first = await ingest({}, h.deps);
    expect(first.totals).toMatchObject({ signals: 1, replays: 0 });

    // Second pass: same source, same item, same content — and a gate memory that
    // has been reset, so the ONLY thing that can stop it is the idempotency key.
    const second = await ingest({}, h.deps);
    expect(second.totals).toMatchObject({ collected: 1, kept: 1, signals: 0, replays: 1 });
    expect(h.signals).toHaveLength(1);
    expect(h.messages).toHaveLength(1);
  });

  it('drops a duplicate at the gate when the database already holds it', async () => {
    const body = 'a story we already have on file';
    const first = harness([entry(stubCollector('rss', 'rss:dup', [ok([item('a', 'https://a.test/1', body)])]))]);
    await ingest({}, first.deps);

    const known = emptySeen();
    known.contentHashes.add(first.signals[0]?.contentHash ?? '');
    // Same story, a different url on the same site — the exact thing an exact
    // content hash catches and a url comparison does not.
    const second = harness([entry(stubCollector('rss', 'rss:dup', [ok([item('a', 'https://a.test/2', body)])]))], {
      seen: async () => known,
    });
    const report = await ingest({}, second.deps);

    expect(report.totals).toMatchObject({ collected: 1, kept: 0, dropped: 1 });
    expect(report.sources[0]?.dropped).toEqual({ duplicate_content: 1 });
    expect(second.signals).toEqual([]);
  });

  it('reports a source row the watchlist no longer claims instead of leaving it dark', async () => {
    const abandoned = stubState({ kind: 'rss', name: 'rss:retired', consecutive_failures: 2 });
    const h = harness([entry(stubCollector('rss', 'rss:current', [ok([])]))], {
      registered: async () => [abandoned],
    });
    const report = await ingest({}, h.deps);

    const orphan = report.sources.find((s) => s.status === 'orphan');
    expect(orphan?.source).toBe('rss:retired');
    // Reported, never collected: there is no collector to run for it.
    expect(h.outcomes.map((o) => o.id)).not.toContain(abandoned.id);
  });

  it('does not cry orphan over a source another pass owns', async () => {
    // `watch` rows are written by the competitor watcher, which reads documents
    // this pass has no collector for. Calling one orphaned says "nothing
    // collects this any more" about something collected an hour ago, and a
    // report that cries wolf every run is one nobody reads to the bottom of.
    const watched = stubState({ kind: 'watch', name: 'competitor-pages' });
    const h = harness([entry(stubCollector('rss', 'rss:current', [ok([])]))], {
      registered: async () => [watched],
    });
    const report = await ingest({}, h.deps);

    expect(report.sources.some((s) => s.status === 'orphan')).toBe(false);
  });

  it('still reports a collector kind that vanished entirely', async () => {
    // The rule is by KIND-OF-PRODUCER, not "any kind absent from the
    // watchlist" — the latter would hide the real drift of a whole collector
    // kind being deleted, which is exactly what this check is for.
    const gone = stubState({ kind: 'gdelt', name: 'gdelt:retired' });
    const h = harness([entry(stubCollector('rss', 'rss:current', [ok([])]))], {
      registered: async () => [gone],
    });
    const report = await ingest({}, h.deps);

    expect(report.sources.find((s) => s.status === 'orphan')?.source).toBe('gdelt:retired');
  });

  it('does not cry orphan on a filtered pass, where every other kind would look abandoned', async () => {
    const other = stubState({ kind: 'hn', name: 'hn:elsewhere' });
    const h = harness([entry(stubCollector('rss', 'rss:current', [ok([])]))], {
      registered: async () => [other],
    });
    const report = await ingest({ only: 'rss' }, h.deps);
    expect(report.sources.some((s) => s.status === 'orphan')).toBe(false);
  });

  it('restricts to one kind with --only and stops at --limit', async () => {
    const entries = [
      entry(stubCollector('rss', 'rss:a', [ok([])])),
      entry(stubCollector('hn', 'hn:a', [ok([])])),
      entry(stubCollector('hn', 'hn:b', [ok([])])),
    ];
    const onlyHn = await ingest({ only: 'hn' }, harness(entries).deps);
    expect(onlyHn.sources.map((s) => s.source)).toEqual(['hn:a', 'hn:b']);

    const limited = await ingest({ only: 'hn', limit: 1 }, harness(entries).deps);
    expect(limited.sources.map((s) => s.source)).toEqual(['hn:a']);
  });
});
