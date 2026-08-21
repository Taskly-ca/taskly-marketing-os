/**
 * `BrainStorePort` against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://... pnpm test:live
 *
 * Every case runs inside a transaction that is rolled back, so a full run leaves
 * the database at the row count it started with — and, since `brain_doc` is a
 * CACHE of the real vault, so that a run against a populated index cannot
 * corrupt it.
 *
 * THE FIRST BLOCK IS THE POINT: the identical conformance array that
 * `testing/brain.conformance.test.ts` runs against `createMemoryBrainStore`.
 * Anything that passes there and fails here is a place the port has two
 * meanings.
 *
 * The blocks after it are what only a real database can answer: a CHECK
 * constraint with no in-memory equivalent, an `on delete cascade` we merely
 * imitate, a column type node-postgres has never heard of, and the pushed-down
 * predicate actually returning fewer rows.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, sql } from '@tmos/db';

import { ConstraintError } from '../errors.js';
import { BRAIN_FIXTURES, BRAIN_STORE_CONFORMANCE } from '../testing/brain.conformance.js';
import { HAS_DATABASE, inRollback } from '../testing/live.js';
import {
  BRAIN_EMBEDDING_DIMENSIONS,
  createPostgresBrainStore,
  readBrainDocIndex,
} from './brain-store.js';

const PREFIX = BRAIN_FIXTURES.prefix;
const SYNCED_AT = '2026-08-20T12:00:00.000Z';

const doc = (name: string, over: Record<string, unknown> = {}) => ({
  path: `${PREFIX}${name}.md`,
  title: `Live ${name}`,
  type: 'spec' as const,
  status: 'canonical' as const,
  reviewed: '2026-08-01',
  caveats: [],
  verify: [],
  supersededBy: [],
  docSha: `sha-${name}`,
  commitSha: 'commit-live',
  syncedAt: SYNCED_AT,
  ...over,
});

const chunk = (name: string, over: Record<string, unknown> = {}) => ({
  chunkId: `sha-${name}:0`,
  path: `${PREFIX}${name}.md`,
  ordinal: 0,
  heading: 'Commission',
  text: 'The rate.',
  chunkSha: `c-${name}-0`,
  contentChanged: true,
  ...over,
});

const vector = (fill: number): number[] =>
  new Array<number>(BRAIN_EMBEDDING_DIMENSIONS).fill(fill);

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

describe.skipIf(!HAS_DATABASE)('BrainStorePort conformance — postgres', () => {
  for (const testCase of BRAIN_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await inRollback(async (tx) => {
        await testCase.run(createPostgresBrainStore(tx), BRAIN_FIXTURES);
      });
    });
  }
});

describe.skipIf(!HAS_DATABASE)('what only the database can say', () => {
  it('enlists in the ambient transaction, and disappears when it rolls back', async () => {
    // Built with NO executor: it resolves `db()` per call, which inside withTx
    // is the transaction. If it captured the pool instead, this row would
    // survive the rollback.
    const path = await inRollback(async (tx) => {
      const store = createPostgresBrainStore();
      await store.upsertDocs([doc('ambient')]);
      const index = await tx.one<{ n: string }>(
        sql`select count(*)::text as n from brain_doc where path = ${doc('ambient').path}`,
      );
      expect(index.n).toBe('1');
      return doc('ambient').path;
    });

    expect((await readBrainDocIndex()).has(path)).toBe(false);
  });

  it('stores caveats, verify and superseded_by as real text[] columns', async () => {
    // `jsonb_to_recordset(... caveats text[] ...)` is the least ordinary thing
    // in this adapter: a jsonb array of arrays is the only batch shape that does
    // NOT flatten a per-row array column.
    await inRollback(async (tx) => {
      const store = createPostgresBrainStore(tx);
      await store.upsertDocs([
        doc('arrays', { caveats: ['GTA only.', 'Restates code.'], verify: ['lib/fees.ts'] }),
      ]);

      const row = await tx.one<{ caveats: string[]; verify: string[]; n: string }>(sql`
        select caveats, verify, array_length(caveats, 1)::text as n
          from brain_doc where path = ${`${PREFIX}arrays.md`}`);

      expect(row.n).toBe('2');
      expect(row.caveats).toEqual(['GTA only.', 'Restates code.']);
      expect(row.verify).toEqual(['lib/fees.ts']);
    });
  });

  it('narrows a vector to float16 — halfvec is half precision, and 0.1 is not exact', async () => {
    await inRollback(async (tx) => {
      const store = createPostgresBrainStore(tx);
      await store.upsertDocs([doc('half')]);
      await store.upsertChunks([chunk('half')]);
      await store.writeEmbeddings([
        {
          chunkId: 'sha-half:0',
          embedding: vector(0.1),
          model: 'm',
          version: 'v1',
          embeddedAt: '2026-08-20T12:30:00.000Z',
        },
      ]);

      const [stored] = await store.listChunksForEmbedding({ model: 'other', version: 'v1' });
      const first = stored?.embedding?.[0];

      // The honest expectation, not a wish: the memory store keeps every bit of
      // a float64 and this cannot. `needsEmbedding` compares length, model and
      // version — never components — so nothing downstream depends on it.
      expect(first).not.toBe(0.1);
      expect(first).toBeCloseTo(0.1, 3);
      expect(stored?.embedding).toHaveLength(BRAIN_EMBEDDING_DIMENSIONS);
    });
  });

  it('really does return fewer rows than the memory store once a vector is current', async () => {
    await inRollback(async (tx) => {
      const store = createPostgresBrainStore(tx);
      await store.upsertDocs([doc('pushed')]);
      await store.upsertChunks([chunk('pushed'), chunk('pushed', { chunkId: 'sha-pushed:1', ordinal: 1 })]);
      await store.writeEmbeddings([
        {
          chunkId: 'sha-pushed:0',
          embedding: vector(0.5),
          model: 'm',
          version: 'v1',
          embeddedAt: '2026-08-20T12:30:00.000Z',
        },
      ]);

      const listed = (await store.listChunksForEmbedding({ model: 'm', version: 'v1' })).filter(
        (c) => c.path.startsWith(PREFIX),
      );

      // The memory store returns both and lets `needsEmbedding` filter; this one
      // pushes the predicate into SQL, which is what 008's partial index is for.
      expect(listed.map((c) => c.chunkId)).toEqual(['sha-pushed:1']);
    });
  });

  it('cascades chunk deletion in the database, not in the adapter', async () => {
    await inRollback(async (tx) => {
      const store = createPostgresBrainStore(tx);
      await store.upsertDocs([doc('cascade')]);
      await store.upsertChunks([chunk('cascade')]);

      await store.deleteDocs([`${PREFIX}cascade.md`]);

      const row = await tx.one<{ n: string }>(
        sql`select count(*)::text as n from brain_chunk where path = ${`${PREFIX}cascade.md`}`,
      );
      expect(row.n).toBe('0');
    });
  });

  it('refuses a canonical document with no review date — a constraint memory has never had', async () => {
    await inRollback(async (tx) => {
      const store = createPostgresBrainStore(tx);

      // LAST statement in this transaction on purpose: a raised exception aborts
      // it, and `@tmos/db` has no savepoints.
      await expect(
        store.upsertDocs([doc('unreviewed', { reviewed: null })]),
      ).rejects.toBeInstanceOf(ConstraintError);
    });
  });

  it('refuses a vector of the wrong width — the column is halfvec(1024)', async () => {
    await inRollback(async (tx) => {
      const store = createPostgresBrainStore(tx);
      await store.upsertDocs([doc('width')]);
      await store.upsertChunks([chunk('width')]);

      // Written in SQL rather than through the port: `formatHalfvec` refuses a
      // short vector before a statement is built, so the only way to ask the
      // DATABASE whether the typmod is real is to hand it one directly. Last
      // statement in the transaction, for the same reason as above.
      await expect(
        tx.execute(sql`
          update brain_chunk set embedding = ${'[0.1,0.2,0.3]'}::halfvec(1024)
           where chunk_id = ${'sha-width:0'}`),
      ).rejects.toThrow(/1024 dimensions/);
    });
  });
});
