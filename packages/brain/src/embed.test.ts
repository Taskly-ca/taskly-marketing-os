import { describe, it, expect } from 'vitest';
import { createMemoryBrainStore } from './ingest.js';
import type { BrainStorePort, MemoryBrainStore, StoredChunk } from './ingest.js';
import { DEFAULT_EMBED_BATCH, embedInput, embedPending, needsEmbedding } from './embed.js';
import type { EmbedderPort, EmbedOptions } from './embed.js';

const OPTS: EmbedOptions = { now: () => new Date('2026-08-04T12:00:00.000Z') };

const DIMS = 4;
const vec = (text: string): number[] => [text.length, 1, 2, 3];

/** Deterministic and keyless — no provider is ever reachable from this package. */
const fakeEmbedder = (over: Partial<EmbedderPort> = {}): EmbedderPort & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    model: 'gte-small',
    version: '1',
    dimensions: DIMS,
    async embed(texts) {
      calls.push(texts);
      return texts.map(vec);
    },
    ...over,
    calls,
  };
};

const seedChunks = async (store: MemoryBrainStore, n: number): Promise<void> => {
  await store.upsertDocs([
    {
      path: 'p.md',
      title: 'p',
      type: 'spec',
      status: 'canonical',
      reviewed: '2026-08-01',
      caveats: [],
      verify: [],
      supersededBy: [],
      docSha: 's1',
      commitSha: 'c0ffee',
      syncedAt: '2026-08-04T00:00:00.000Z',
    },
  ]);
  await store.upsertChunks(
    Array.from({ length: n }, (_, i) => ({
      path: 'p.md',
      chunkId: `s1:${i}`,
      ordinal: i,
      heading: `Section ${i}`,
      text: `body ${i}`,
      chunkSha: `c${i}`,
      contentChanged: true,
    })),
  );
};

const markEmbedded = async (store: MemoryBrainStore, model: string, version: string) => {
  for (const c of store.chunks()) {
    await store.writeEmbeddings([
      { chunkId: c.chunkId, embedding: [1, 2, 3, 4], model, version, embeddedAt: 'then' },
    ]);
  }
};

const vectors = (store: MemoryBrainStore): (number[] | null)[] =>
  store
    .chunks()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => c.embedding);

describe('what needs embedding', () => {
  const chunk = (over: Partial<StoredChunk> = {}): StoredChunk => ({
    chunkId: 's1:0',
    path: 'p.md',
    ordinal: 0,
    heading: 'H',
    text: 't',
    chunkSha: 'c0',
    embedding: [1, 2, 3, 4],
    embedModel: 'gte-small',
    embedVersion: '1',
    embeddedAt: 'then',
    ...over,
  });
  const embedder = fakeEmbedder();

  it('leaves a current vector alone', () => {
    expect(needsEmbedding(chunk(), embedder)).toBe(false);
  });

  it('takes a chunk that has no vector', () => {
    expect(needsEmbedding(chunk({ embedding: null }), embedder)).toBe(true);
  });

  it('takes a chunk embedded by a different model or version', () => {
    expect(needsEmbedding(chunk({ embedModel: 'e5-large' }), embedder)).toBe(true);
    expect(needsEmbedding(chunk({ embedVersion: '0' }), embedder)).toBe(true);
  });

  it('takes a stored vector of the wrong width', () => {
    // Two geometries in one index cannot be compared. A stale 1536-dim row
    // sitting in a 1024-dim corpus is a silent recall hole, not an edge case.
    expect(needsEmbedding(chunk({ embedding: [1, 2, 3] }), embedder)).toBe(true);
  });
});

describe('embedPending', () => {
  it('embeds only the chunks with no vector', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 3);
    await store.writeEmbeddings([
      {
        chunkId: 's1:1',
        embedding: [9, 9, 9, 9],
        model: 'gte-small',
        version: '1',
        embeddedAt: 't',
      },
    ]);

    const res = await embedPending(store, fakeEmbedder(), OPTS);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.report).toMatchObject({ embedded: 2, failed: 0, skipped: 1, deferred: 0 });
    expect(vectors(store)[1]).toEqual([9, 9, 9, 9]);
    expect(store.chunks().find((c) => c.chunkId === 's1:0')?.embeddedAt).toBe(
      '2026-08-04T12:00:00.000Z',
    );
  });

  it('re-embeds the WHOLE corpus when the model version is bumped', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 5);
    await markEmbedded(store, 'gte-small', '1');
    expect((await embedPending(store, fakeEmbedder(), OPTS)).ok).toBe(true);

    // Chunks embedded by different models are not comparable. Mixing them
    // degrades retrieval in a way that looks like the corpus got worse rather
    // than like a bug, so a version bump is a full re-embed, never a partial one.
    const res = await embedPending(store, fakeEmbedder({ version: '2' }), OPTS);

    if (!res.ok) throw new Error(res.reason);
    expect(res.report).toMatchObject({ embedded: 5, skipped: 0, failed: 0 });
    expect(store.chunks().every((c) => c.embedVersion === '2')).toBe(true);
  });

  it('re-embeds the whole corpus when the MODEL changes', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 4);
    await markEmbedded(store, 'gte-small', '1');
    const res = await embedPending(store, fakeEmbedder({ model: 'e5-large' }), OPTS);
    if (!res.ok) throw new Error(res.reason);
    expect(res.report.embedded).toBe(4);
    expect(store.chunks().every((c) => c.embedModel === 'e5-large')).toBe(true);
  });

  it('does nothing, successfully, when every vector is current', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 3);
    await markEmbedded(store, 'gte-small', '1');
    const embedder = fakeEmbedder();
    const res = await embedPending(store, embedder, OPTS);
    if (!res.ok) throw new Error(res.reason);
    expect(res.report).toMatchObject({ embedded: 0, failed: 0, skipped: 3, batches: 0 });
    expect(embedder.calls).toEqual([]);
  });
});

describe('a bad batch is refused whole', () => {
  it('writes NOTHING when the provider returns 3 vectors for 4 texts', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 4);
    const res = await embedPending(
      store,
      fakeEmbedder({
        async embed(texts) {
          return texts.slice(1).map(vec);
        },
      }),
      OPTS,
    );

    if (!res.ok) throw new Error(res.reason);
    expect(res.report).toMatchObject({ embedded: 0, failed: 4 });
    expect(res.report.failures[0]?.reason).toBe('vector_count_mismatch');
    expect(res.report.failures[0]?.detail).toContain('3');
    // Not "write the three we got" — the mapping from text to vector is gone,
    // and a vector attached to the wrong chunk is undetectable afterwards.
    expect(vectors(store)).toEqual([null, null, null, null]);
  });

  it('rejects a vector of the wrong dimension', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 2);
    const res = await embedPending(
      store,
      fakeEmbedder({
        async embed(texts) {
          return texts.map(() => [1, 2, 3]);
        },
      }),
      OPTS,
    );

    if (!res.ok) throw new Error(res.reason);
    // A truncated or padded vector poisons every future similarity score, and
    // the damage looks like bad retrieval rather than like corruption.
    expect(res.report).toMatchObject({ embedded: 0, failed: 2 });
    expect(res.report.failures[0]?.reason).toBe('bad_vector');
    expect(res.report.failures[0]?.detail).toContain('3');
    expect(vectors(store)).toEqual([null, null]);
  });

  it('rejects a non-finite component', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 1);
    const res = await embedPending(
      store,
      fakeEmbedder({
        async embed(texts) {
          return texts.map(() => [1, NaN, 3, 4]);
        },
      }),
      OPTS,
    );
    if (!res.ok) throw new Error(res.reason);
    // NaN sorts unpredictably and compares false against every threshold.
    expect(res.report.failures[0]?.reason).toBe('bad_vector');
    expect(vectors(store)).toEqual([null]);
  });

  it('keeps the batches that worked when one batch fails', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 4);
    let n = 0;
    const res = await embedPending(
      store,
      fakeEmbedder({
        async embed(texts) {
          if (++n === 2) throw new Error('rate limited');
          return texts.map(vec);
        },
      }),
      { ...OPTS, batchSize: 2 },
    );

    if (!res.ok) throw new Error(res.reason);
    expect(res.report).toMatchObject({ embedded: 2, failed: 2, batches: 2 });
    expect(res.report.failures[0]).toMatchObject({
      reason: 'provider_error',
      chunkIds: ['s1:2', 's1:3'],
    });
    expect(vectors(store).filter((v) => v !== null)).toHaveLength(2);
  });

  it('counts a failed write as a failed batch and carries on', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 2);
    const broken: BrainStorePort = {
      ...store,
      writeEmbeddings: async () => {
        throw new Error('deadlock detected');
      },
    };
    const res = await embedPending(broken, fakeEmbedder(), OPTS);
    if (!res.ok) throw new Error(res.reason);
    expect(res.report).toMatchObject({ embedded: 0, failed: 2 });
    expect(res.report.failures[0]?.reason).toBe('store_failed');
  });
});

describe('batching and options', () => {
  it('defaults to a documented batch size', () => {
    expect(DEFAULT_EMBED_BATCH).toBe(64);
  });

  it('splits the work at the configured size, in a stable order', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 5);
    const embedder = fakeEmbedder();
    const res = await embedPending(store, embedder, { ...OPTS, batchSize: 2 });
    if (!res.ok) throw new Error(res.reason);
    expect(res.report.batches).toBe(3);
    expect(embedder.calls.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(embedder.calls[0]?.[0]).toContain('body 0');
  });

  it('defers work past the per-run cap instead of failing it', async () => {
    const store = createMemoryBrainStore();
    await seedChunks(store, 6);
    const res = await embedPending(store, fakeEmbedder(), { ...OPTS, max: 2 });
    if (!res.ok) throw new Error(res.reason);
    expect(res.report).toMatchObject({ embedded: 2, deferred: 4, failed: 0 });
  });

  it('refuses a nonsensical batch size rather than looping forever', async () => {
    const store = createMemoryBrainStore();
    const res = await embedPending(store, fakeEmbedder(), { ...OPTS, batchSize: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_options');
  });

  it('reports a store read failure rather than pretending there is no work', async () => {
    const store = createMemoryBrainStore();
    const broken: BrainStorePort = {
      ...store,
      listChunksForEmbedding: async () => {
        throw new Error('connection reset');
      },
    };
    const res = await embedPending(broken, fakeEmbedder(), OPTS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('store_failed');
  });

  it('embeds the heading with the body so a section is locatable', () => {
    // "Roles" alone means nothing in vector space; the heading path is what
    // separates one spec's §Roles from another's.
    expect(embedInput({ heading: 'SYSTEM.md › Roles', text: 'two roles' })).toBe(
      'SYSTEM.md › Roles\n\ntwo roles',
    );
    expect(embedInput({ heading: '  ', text: 'body only' })).toBe('body only');
  });
});
