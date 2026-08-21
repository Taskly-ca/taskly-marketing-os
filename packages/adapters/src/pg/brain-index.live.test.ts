/**
 * `BrainIndexPort` against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://... pnpm test:live
 *
 * The conformance block is the same array `testing/brain.conformance.test.ts`
 * runs against the in-memory reference. The block after it is what the reference
 * CANNOT answer, and is therefore the whole reason a live run matters here:
 * `to_tsvector` stems and drops stopwords, `<=>` is computed by pgvector over
 * half precision, and neither behaviour can be imitated in JavaScript without
 * reimplementing Postgres badly.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, type Executor } from '@tmos/db';

import { BRAIN_FIXTURES, BRAIN_INDEX_CONFORMANCE } from '../testing/brain.conformance.js';
import { HAS_DATABASE, inRollback } from '../testing/live.js';
import { BRAIN_EMBEDDING_DIMENSIONS, createPostgresBrainStore } from './brain-store.js';
import { createPostgresBrainIndex } from './brain-index.js';

const PREFIX = BRAIN_FIXTURES.prefix;
const PATH = `${PREFIX}live.md`;

const unit = (axis: number): number[] => {
  const v = new Array<number>(BRAIN_EMBEDDING_DIMENSIONS).fill(0);
  v[axis] = 1;
  return v;
};

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

describe.skipIf(!HAS_DATABASE)('BrainIndexPort conformance — postgres', () => {
  for (const testCase of BRAIN_INDEX_CONFORMANCE) {
    it(testCase.name, async () => {
      await inRollback(async (tx) => {
        await testCase.run(
          { store: createPostgresBrainStore(tx), index: createPostgresBrainIndex(tx) },
          BRAIN_FIXTURES,
        );
      });
    });
  }
});

describe.skipIf(!HAS_DATABASE)('what only the database can say', () => {
  const seed = async (text: string, tx: Executor) => {
    const store = createPostgresBrainStore(tx);
    await store.upsertDocs([
      {
        path: PATH,
        title: 'Live',
        type: 'spec',
        status: 'canonical',
        reviewed: '2026-08-01',
        caveats: [],
        verify: [],
        supersededBy: [],
        docSha: 'sha-live',
        commitSha: 'commit-live',
        syncedAt: '2026-08-20T12:00:00.000Z',
      },
    ]);
    await store.upsertChunks([
      {
        chunkId: 'sha-live:0',
        path: PATH,
        ordinal: 0,
        heading: 'Commission',
        text,
        chunkSha: 'c-live-0',
        contentChanged: true,
      },
    ]);
    await store.writeEmbeddings([
      {
        chunkId: 'sha-live:0',
        embedding: unit(0),
        model: 'm',
        version: 'v1',
        embeddedAt: '2026-08-20T12:30:00.000Z',
      },
    ]);
    return createPostgresBrainIndex(tx);
  };

  it('stems the query — a search for "rates" finds a chunk that says "rate"', async () => {
    await inRollback(async (tx) => {
      const index = await seed('The commission rate in the GTA.', tx);

      const hits = (await index.search({ text: 'rates', limit: 10 })).filter((c) =>
        c.doc.path.startsWith(PREFIX),
      );
      // The in-memory reference matches whole words and cannot do this, which is
      // exactly why no conformance case asserts on text ranking.
      expect(hits.map((c) => c.chunk.chunkId)).toEqual(['sha-live:0']);
      expect(hits[0]?.distance).toBeGreaterThan(0);
      expect(hits[0]?.distance).toBeLessThanOrEqual(1);
    });
  });

  it('answers an all-stopword query with nothing, and does not raise', async () => {
    await inRollback(async (tx) => {
      const index = await seed('The commission rate in the GTA.', tx);
      // `websearch_to_tsquery` yields an empty query here. Nothing is the
      // truthful answer to "what matches 'the'".
      expect(await index.search({ text: 'the and of', limit: 10 })).toEqual([]);
    });
  });

  it('takes arbitrary punctuation as a query without a syntax error', async () => {
    await inRollback(async (tx) => {
      const index = await seed('The commission rate in the GTA.', tx);
      // `plainto_`/`websearch_to_tsquery` never raise on user input; `to_tsquery`
      // would, which is why it is not used.
      await expect(index.search({ text: 'what !!! & | ( rate ?', limit: 10 })).resolves.toBeTruthy();
    });
  });

  it('computes cosine distance: zero for the same direction, one for an orthogonal one', async () => {
    await inRollback(async (tx) => {
      const index = await seed('The commission rate in the GTA.', tx);

      const same = (await index.search({ vector: unit(0), limit: 10 })).find(
        (c) => c.doc.path === PATH,
      );
      expect(same?.distance).toBeCloseTo(0, 5);

      const orthogonal = (await index.search({ vector: unit(1), limit: 10 })).find(
        (c) => c.doc.path === PATH,
      );
      expect(orthogonal?.distance).toBeCloseTo(1, 5);
    });
  });
});
