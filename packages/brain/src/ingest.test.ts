import { describe, it, expect } from 'vitest';
import type { BrainChunk, BrainDoc } from '@tmos/contracts';
import {
  createMemoryBrainStore,
  ingestSnapshot,
  MAX_REMOVED_FRACTION,
  SHRINK_GUARD_MIN_DOCS,
} from './ingest.js';
import type { BrainStorePort, IngestOptions, SnapshotSourcePort } from './ingest.js';

const OPTS: IngestOptions = { now: () => new Date('2026-08-04T12:00:00.000Z') };

const chunk = (docSha: string, ordinal: number, sha: string): BrainChunk => ({
  chunkId: `${docSha}:${ordinal}`,
  ordinal,
  heading: `Section ${ordinal}`,
  text: `body of section ${ordinal}`,
  chunkSha: sha,
});

const doc = (over: Partial<BrainDoc> & { path: string; docSha: string }): BrainDoc => ({
  title: over.path,
  type: 'spec',
  status: 'canonical',
  reviewed: '2026-08-01',
  caveats: [],
  verify: [],
  supersededBy: [],
  chunks: [chunk(over.docSha, 0, `${over.docSha}-c0`)],
  ...over,
});

const snapshot = (docs: BrainDoc[], commit = 'a99afa8d'): unknown => ({
  schemaVersion: 1,
  commit,
  generatedAt: '2026-08-04T00:00:00.000Z',
  docs,
});

const source = (payload: unknown): SnapshotSourcePort => ({ fetch: async () => payload });

/** A 40-chunk document — the shape the one-section-edit test needs. */
const bigDoc = (docSha: string, edited?: { ordinal: number; sha: string }): BrainDoc =>
  doc({
    path: '20-architecture/SYSTEM.md',
    docSha,
    chunks: Array.from({ length: 40 }, (_, i) =>
      chunk(docSha, i, edited?.ordinal === i ? edited.sha : `c${i}`),
    ),
  });

const seed = async (store: BrainStorePort, docs: BrainDoc[]) =>
  ingestSnapshot(source(snapshot(docs)), store, OPTS);

const paths = (docs: { path: string }[]) => docs.map((d) => d.path).sort();

describe('a snapshot that does not validate is a broken sync, never an empty one', () => {
  it('leaves an existing index COMPLETELY untouched', async () => {
    const store = createMemoryBrainStore();
    await seed(store, [
      doc({ path: 'a.md', docSha: 'sha-a' }),
      doc({ path: 'b.md', docSha: 'sha-b' }),
    ]);
    await store.writeEmbeddings([
      {
        chunkId: 'sha-a:0',
        embedding: [0.1, 0.2],
        model: 'm',
        version: '1',
        embeddedAt: '2026-08-04T00:00:00.000Z',
      },
    ]);
    const before = JSON.stringify({ docs: store.docs(), chunks: store.chunks() });

    // `docs` is not an array, so the exporter's shape is gone. The dangerous
    // failure is treating that as "the Brain now has zero documents".
    const res = await ingestSnapshot(
      source({ schemaVersion: 1, commit: 'x', docs: null }),
      store,
      OPTS,
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('invalid_snapshot');
    expect(JSON.stringify({ docs: store.docs(), chunks: store.chunks() })).toBe(before);
  });

  it('refuses a schema version it does not understand rather than guessing', async () => {
    const store = createMemoryBrainStore();
    const res = await ingestSnapshot(
      source({ ...(snapshot([]) as object), schemaVersion: 2 }),
      store,
      OPTS,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_snapshot');
  });

  it('refuses a snapshot with two documents at the same path', async () => {
    const store = createMemoryBrainStore();
    const res = await ingestSnapshot(
      source(snapshot([doc({ path: 'a.md', docSha: '1' }), doc({ path: 'a.md', docSha: '2' })])),
      store,
      OPTS,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_snapshot');
  });

  it('separates a failed fetch from a fetch that returned nothing', async () => {
    const store = createMemoryBrainStore();
    const res = await ingestSnapshot(
      {
        fetch: async () => {
          throw new Error('502 from the release artifact');
        },
      },
      store,
      OPTS,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('fetch_failed');
      expect(res.detail).toContain('502');
    }
  });

  it('reports a store read failure as store_failed, not as an empty index', async () => {
    const store = createMemoryBrainStore();
    const broken: BrainStorePort = {
      ...store,
      readDocIndex: async () => {
        throw new Error('connection reset');
      },
    };
    const res = await ingestSnapshot(source(snapshot([])), broken, OPTS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('store_failed');
  });
});

describe('an empty snapshot on an empty index is a valid no-op', () => {
  it('succeeds with a zeroed plan — distinct from every failure', async () => {
    const store = createMemoryBrainStore();
    const res = await ingestSnapshot(source(snapshot([])), store, OPTS);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.plan).toMatchObject({ added: 0, changed: 0, unchanged: 0, removed: 0 });
    expect(res.plan.toEmbed).toEqual([]);
    expect(store.docs()).toEqual([]);
  });
});

describe('the diff is the whole point', () => {
  it('treats a first sync as all-added and queues every chunk', async () => {
    const store = createMemoryBrainStore();
    const res = await seed(store, [bigDoc('sha-1')]);
    if (!res.ok) throw new Error(res.reason);
    expect(res.plan.added).toBe(1);
    expect(res.plan.toEmbed).toHaveLength(40);
    expect(store.chunks()).toHaveLength(40);
    expect(store.docs()[0]).toMatchObject({
      commitSha: 'a99afa8d',
      syncedAt: '2026-08-04T12:00:00.000Z',
    });
  });

  it('does ZERO chunk work when docSha is unchanged', async () => {
    const store = createMemoryBrainStore();
    await seed(store, [bigDoc('sha-1')]);
    await store.writeEmbeddings([
      { chunkId: 'sha-1:0', embedding: [1], model: 'm', version: '1', embeddedAt: 'then' },
    ]);
    const readsBefore = store.calls.readChunkIndex ?? 0;
    const writesBefore = store.calls.upsertChunks ?? 0;

    const res = await seed(store, [bigDoc('sha-1')]);

    if (!res.ok) throw new Error(res.reason);
    expect(res.plan).toMatchObject({ unchanged: 1, changed: 0, chunksUpserted: 0 });
    expect(res.plan.toEmbed).toEqual([]);
    // Not merely "no writes" — the chunk table is never even read for a
    // document whose hash matches. That is what makes a no-op sync cheap.
    expect(store.calls.readChunkIndex ?? 0).toBe(readsBefore);
    expect(store.calls.upsertChunks ?? 0).toBe(writesBefore);
    expect(store.chunks().find((c) => c.chunkId === 'sha-1:0')?.embedding).toEqual([1]);
  });

  it('re-embeds exactly ONE chunk when one section of a 40-chunk doc changes', async () => {
    const store = createMemoryBrainStore();
    await seed(store, [bigDoc('sha-1')]);
    for (const c of store.chunks()) {
      await store.writeEmbeddings([
        {
          chunkId: c.chunkId,
          embedding: [c.ordinal],
          model: 'm',
          version: '1',
          embeddedAt: 'then',
        },
      ]);
    }

    // Every chunkId changes (they are `${docSha}:${ordinal}`), but only one
    // chunkSha does. Keying re-embedding on the id would cost 40 calls.
    const res = await seed(store, [bigDoc('sha-2', { ordinal: 7, sha: 'c7-edited' })]);

    if (!res.ok) throw new Error(res.reason);
    expect(res.plan.changed).toBe(1);
    expect(res.plan.toEmbed).toHaveLength(1);
    expect(res.plan.toEmbed[0]).toMatchObject({ ordinal: 7, chunkId: 'sha-2:7' });
    expect(res.plan.chunksUnchanged).toBe(39);

    const rows = store.chunks();
    expect(rows).toHaveLength(40);
    // The 39 untouched sections keep their vectors across the id rewrite…
    expect(rows.find((c) => c.ordinal === 6)?.embedding).toEqual([6]);
    expect(rows.find((c) => c.ordinal === 6)?.chunkId).toBe('sha-2:6');
    // …and the edited one is cleared, because a vector for the previous text is
    // worse than no vector at all.
    expect(rows.find((c) => c.ordinal === 7)?.embedding).toBeNull();
    expect(rows.find((c) => c.ordinal === 7)?.embedModel).toBeNull();
  });

  it('drops chunks that disappeared when a document got shorter', async () => {
    const store = createMemoryBrainStore();
    await seed(store, [bigDoc('sha-1')]);
    const shorter = doc({
      path: '20-architecture/SYSTEM.md',
      docSha: 'sha-2',
      chunks: Array.from({ length: 3 }, (_, i) => chunk('sha-2', i, `c${i}`)),
    });
    const res = await seed(store, [shorter]);
    if (!res.ok) throw new Error(res.reason);
    expect(res.plan.chunksDeleted).toBe(37);
    expect(store.chunks()).toHaveLength(3);
  });

  it('computes a plan without writing when dryRun is set', async () => {
    const store = createMemoryBrainStore();
    const res = await ingestSnapshot(source(snapshot([bigDoc('sha-1')])), store, {
      ...OPTS,
      dryRun: true,
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.plan.added).toBe(1);
    expect(store.docs()).toEqual([]);
    expect(store.chunks()).toEqual([]);
  });
});

describe('deletion, and the guard on deletion', () => {
  it('removes a document that is absent from the new snapshot, chunks and all', async () => {
    const store = createMemoryBrainStore();
    await seed(store, [doc({ path: 'a.md', docSha: '1' }), doc({ path: 'b.md', docSha: '2' })]);
    const res = await seed(store, [doc({ path: 'a.md', docSha: '1' })]);
    if (!res.ok) throw new Error(res.reason);
    expect(res.plan.removed).toBe(1);
    expect(paths(store.docs())).toEqual(['a.md']);
    // `on delete cascade` in migration 008 — a doc never leaves orphans behind.
    expect(store.chunks().every((c) => c.path === 'a.md')).toBe(true);
  });

  it('REFUSES a snapshot that drops more than half the corpus', async () => {
    const store = createMemoryBrainStore();
    const all = Array.from({ length: 12 }, (_, i) => doc({ path: `d${i}.md`, docSha: `s${i}` }));
    await seed(store, all);
    const before = JSON.stringify(store.docs());

    // 7 of 12 removed = 58% > 50%. An exporter bug must not be able to empty
    // the index; a real deletion of this size is a reviewed, deliberate act.
    const res = await seed(store, all.slice(0, 5));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('suspicious_shrink');
      expect(res.detail).toContain('12');
    }
    expect(JSON.stringify(store.docs())).toBe(before);
  });

  it('ALLOWS a drop of exactly the threshold — the guard is on "more than half"', async () => {
    const store = createMemoryBrainStore();
    const all = Array.from({ length: 12 }, (_, i) => doc({ path: `d${i}.md`, docSha: `s${i}` }));
    await seed(store, all);
    const res = await seed(store, all.slice(0, 6)); // 6 of 12 = exactly 0.5
    expect(MAX_REMOVED_FRACTION).toBe(0.5);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.plan.removed).toBe(6);
    expect(store.docs()).toHaveLength(6);
  });

  it('does not apply the ratio to an index too small for a ratio to mean anything', async () => {
    const store = createMemoryBrainStore();
    const all = Array.from({ length: 4 }, (_, i) => doc({ path: `d${i}.md`, docSha: `s${i}` }));
    await seed(store, all);
    // 3 of 4 removed is 75%, but on a four-document index that is ordinary
    // churn, not a wiped corpus. The floor is what keeps the guard credible.
    expect(SHRINK_GUARD_MIN_DOCS).toBe(10);
    const res = await seed(store, all.slice(0, 1));
    expect(res.ok).toBe(true);
    expect(store.docs()).toHaveLength(1);
  });

  it('lets a reviewed deletion through explicitly', async () => {
    const store = createMemoryBrainStore();
    const all = Array.from({ length: 12 }, (_, i) => doc({ path: `d${i}.md`, docSha: `s${i}` }));
    await seed(store, all);
    const res = await ingestSnapshot(source(snapshot([])), store, { ...OPTS, allowShrink: true });
    expect(res.ok).toBe(true);
    expect(store.docs()).toEqual([]);
  });
});

describe('the trust ladder decides what is even stored', () => {
  it('stores a superseded document as a row but with ZERO retrievable chunks', async () => {
    const store = createMemoryBrainStore();
    await seed(store, [
      doc({ path: 'old.md', docSha: 'o1', status: 'superseded', supersededBy: ['new.md'] }),
    ]);
    expect(paths(store.docs())).toEqual(['old.md']);
    expect(store.docs()[0]?.supersededBy).toEqual(['new.md']);
    // never_retrieved is a property of the data, not of a filter somebody has
    // to remember to write in every query.
    expect(store.chunks()).toEqual([]);
  });

  it('deletes the chunks of a document the Brain has just superseded', async () => {
    const store = createMemoryBrainStore();
    await seed(store, [doc({ path: 'p.md', docSha: 'v1' })]);
    expect(store.chunks()).toHaveLength(1);
    const res = await seed(store, [doc({ path: 'p.md', docSha: 'v2', status: 'superseded' })]);
    if (!res.ok) throw new Error(res.reason);
    expect(store.chunks()).toEqual([]);
    expect(res.plan.chunksDeleted).toBe(1);
  });

  it('re-runs a document whose status changed even if its hash did not', async () => {
    // Defence against an exporter that hashes only the body: a status flip that
    // did not move docSha would otherwise leave a superseded document
    // retrievable forever.
    const store = createMemoryBrainStore();
    await seed(store, [doc({ path: 'p.md', docSha: 'same' })]);
    const res = await seed(store, [doc({ path: 'p.md', docSha: 'same', status: 'superseded' })]);
    if (!res.ok) throw new Error(res.reason);
    expect(res.plan.changed).toBe(1);
    expect(store.chunks()).toEqual([]);
  });

  it('keeps draft and supporting documents retrievable', async () => {
    const store = createMemoryBrainStore();
    await seed(store, [
      doc({ path: 'd.md', docSha: 'd1', status: 'draft', reviewed: null }),
      doc({ path: 's.md', docSha: 's1', status: 'supporting' }),
    ]);
    expect(store.chunks()).toHaveLength(2);
  });
});
