/**
 * The `BrainStorePort` + `BrainIndexPort` conformance suites — the definition of
 * "substitutable" for the Brain index.
 *
 * Cases are DATA, not tests: a name and an async function taking a store and its
 * fixtures, asserting with `node:assert/strict` so nothing in `src/` imports a
 * test framework. `brain.conformance.test.ts` runs them against the in-memory
 * store with no database at all; `pg/brain-*.live.test.ts` runs the same arrays
 * against Postgres inside a transaction it rolls back.
 *
 * THREE THINGS SHAPE HOW EVERY ASSERTION BELOW IS WRITTEN, all of them from the
 * Postgres side:
 *
 *   NOTHING ASSERTS ON A TOTAL. `readDocIndex` and `listChunksForEmbedding` are
 *   whole-table reads, and a real database has the actual Brain in it. Every
 *   case therefore filters to `fixtures.prefix` and asserts about ITS rows —
 *   the same discipline that makes `PredicateStore.all()` conformable.
 *
 *   `listChunksForEmbedding` IS COMPARED THROUGH `needsEmbedding`. The memory
 *   store deliberately ignores the criteria and returns everything; the Postgres
 *   one pushes the predicate into SQL, which is an optimisation its own comment
 *   asks for. So the two DO return different rows, and the observable they must
 *   agree on is the one `embedPending` actually uses: the subset `needsEmbedding`
 *   selects, which the criteria can only ever narrow correctly.
 *
 *   VECTORS ARE FLOAT16-EXACT. `brain_chunk.embedding` is `halfvec(1024)`, so a
 *   component that is not representable in half precision does not survive the
 *   round trip. Every vector here is built from {0, +/-0.25, +/-0.5, 1}, which is.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { groundingSet, needsEmbedding, retrieve } from '@tmos/brain';
import type {
  BrainIndexCandidate,
  BrainIndexPort,
  BrainQuery,
  BrainStorePort,
  ChunkUpsert,
  DocUpsert,
  MemoryBrainStore,
  StoredChunk,
} from '@tmos/brain';

import { AdapterError } from '../errors.js';
import { NO_QUERY_MESSAGE } from '../pg/brain-index.js';
import { rejects, type ConformanceCase } from './conformance.js';

/**
 * The seam between the two runs. `brain_doc` / `brain_chunk` have no foreign
 * keys to anything outside themselves, so unlike the fact fixtures there is
 * nothing to seed — only a namespace, so a case can tell its own rows apart from
 * a live database's real corpus.
 */
export interface BrainStoreFixtures {
  readonly prefix: string;
}

export interface BrainIndexSeam {
  readonly store: BrainStorePort;
  readonly index: BrainIndexPort;
}

export type BrainStoreCase = ConformanceCase<BrainStorePort, BrainStoreFixtures>;
export type BrainIndexCase = ConformanceCase<BrainIndexSeam, BrainStoreFixtures>;

/** Rolled back either way; the prefix is what keeps the ASSERTIONS honest. */
export const BRAIN_FIXTURES: BrainStoreFixtures = { prefix: 'tmos-conf/' };

/** `brain_chunk.embedding` is `halfvec(1024)`; anything else is refused. */
const BRAIN_CONFORMANCE_DIMENSIONS = 1024;

const MODEL = 'tmos-conf-embed';
const VERSION = 'v1';
const EMBEDDER = { model: MODEL, version: VERSION, dimensions: BRAIN_CONFORMANCE_DIMENSIONS };

const REVIEWED = '2026-08-01';
const SYNCED_AT = '2026-08-20T12:00:00.000Z';
const EMBEDDED_AT = '2026-08-20T12:30:00.000Z';
/** Well inside `BRAIN_STALE_DAYS` of `REVIEWED`, so staleness never confuses a case. */
const NOW = new Date('2026-08-20T00:00:00.000Z');

/* -- fixtures ------------------------------------------------------------ */

const at = (fx: BrainStoreFixtures, name: string): string => `${fx.prefix}${name}.md`;

const doc = (
  fx: BrainStoreFixtures,
  name: string,
  over: Partial<DocUpsert> = {},
): DocUpsert => ({
  path: at(fx, name),
  title: `Conformance ${name}`,
  type: 'spec',
  status: 'canonical',
  reviewed: REVIEWED,
  caveats: [],
  verify: [],
  supersededBy: [],
  docSha: `sha-${name}`,
  commitSha: 'commit-conf',
  syncedAt: SYNCED_AT,
  ...over,
});

const chunk = (
  fx: BrainStoreFixtures,
  name: string,
  ordinal: number,
  over: Partial<ChunkUpsert> = {},
): ChunkUpsert => ({
  chunkId: `sha-${name}:${ordinal}`,
  path: at(fx, name),
  ordinal,
  heading: 'Commission',
  text: `Section ${ordinal} of ${name}.`,
  chunkSha: `c-${name}-${ordinal}`,
  contentChanged: true,
  ...over,
});

/** A one-hot vector: cosine distance to itself is 0 and to any other axis is 1. */
const unit = (axis: number): number[] => {
  const v = new Array<number>(BRAIN_CONFORMANCE_DIMENSIONS).fill(0);
  v[axis % BRAIN_CONFORMANCE_DIMENSIONS] = 1;
  return v;
};

/** Every component exactly representable in float16, so equality survives. */
const EXACT_VECTOR = Array.from(
  { length: BRAIN_CONFORMANCE_DIMENSIONS },
  (_, i) => ((i % 5) - 2) / 4,
);

const embedding = (chunkId: string, vector: number[] = EXACT_VECTOR) => ({
  chunkId,
  embedding: vector,
  model: MODEL,
  version: VERSION,
  embeddedAt: EMBEDDED_AT,
});

/* -- assertions that survive a live corpus ------------------------------- */

const mine = (fx: BrainStoreFixtures, keys: Iterable<string>): string[] =>
  [...keys].filter((key) => key.startsWith(fx.prefix)).sort();

const myChunks = (fx: BrainStoreFixtures, chunks: readonly StoredChunk[]): StoredChunk[] =>
  chunks
    .filter((c) => c.path.startsWith(fx.prefix))
    .sort((a, b) => a.path.localeCompare(b.path) || a.ordinal - b.ordinal);

const only = (chunks: readonly StoredChunk[], where: string): StoredChunk => {
  const [first] = chunks;
  strictEqual(chunks.length, 1, `${where}: expected exactly one chunk, got ${chunks.length}`);
  ok(first !== undefined);
  return first;
};

export const BRAIN_STORE_CONFORMANCE: readonly BrainStoreCase[] = [
  {
    name: 'upsertDocs then readDocIndex reports every path with its sha and status',
    async run(store, fx) {
      await store.upsertDocs([doc(fx, 'a'), doc(fx, 'b', { status: 'draft', reviewed: null })]);

      const index = await store.readDocIndex();
      deepStrictEqual(mine(fx, index.keys()), [at(fx, 'a'), at(fx, 'b')]);
      deepStrictEqual(index.get(at(fx, 'a')), { docSha: 'sha-a', status: 'canonical' });
      deepStrictEqual(index.get(at(fx, 'b')), { docSha: 'sha-b', status: 'draft' });
    },
  },

  {
    name: 'upsertDocs is keyed on path — a re-sync replaces the row rather than adding one',
    async run(store, fx) {
      await store.upsertDocs([doc(fx, 'a')]);
      // A status change with the SAME sha is the case ingest looks for: an
      // exporter that hashes only the body would otherwise leave a newly
      // superseded document retrievable forever.
      await store.upsertDocs([doc(fx, 'a', { status: 'draft', reviewed: null })]);

      const index = await store.readDocIndex();
      deepStrictEqual(mine(fx, index.keys()), [at(fx, 'a')]);
      deepStrictEqual(index.get(at(fx, 'a')), { docSha: 'sha-a', status: 'draft' });
    },
  },

  {
    name: 'readChunkIndex is keyed by chunkId and covers only the paths it was asked for',
    async run(store, fx) {
      await store.upsertDocs([doc(fx, 'a'), doc(fx, 'b')]);
      await store.upsertChunks([chunk(fx, 'a', 0), chunk(fx, 'a', 1), chunk(fx, 'b', 0)]);

      const index = await store.readChunkIndex([at(fx, 'a')]);
      deepStrictEqual([...index.keys()].sort(), ['sha-a:0', 'sha-a:1']);
      deepStrictEqual(index.get('sha-a:0'), { path: at(fx, 'a'), ordinal: 0, chunkSha: 'c-a-0' });

      deepStrictEqual(await store.readChunkIndex([]), new Map());
    },
  },

  {
    name: 'a chunk upserts on (path, ordinal): the id rotates and the vector rides across',
    async run(store, fx) {
      await store.upsertDocs([doc(fx, 'a')]);
      await store.upsertChunks([chunk(fx, 'a', 0)]);
      await store.writeEmbeddings([embedding('sha-a:0')]);

      // Another section of the same document was edited, so `docSha` moved and
      // EVERY chunkId with it — but this chunk's text did not change. Keying the
      // write on chunkId would have thrown this vector away.
      await store.upsertChunks([
        chunk(fx, 'a', 0, { chunkId: 'sha-a2:0', contentChanged: false }),
      ]);

      // Listed under a DIFFERENT model, so the Postgres store's pushed-down
      // predicate returns the row it would otherwise (correctly) filter out.
      const rows = myChunks(fx, await store.listChunksForEmbedding({ model: 'other', version: VERSION }));
      const row = only(rows, 'after a carried upsert');

      strictEqual(row.chunkId, 'sha-a2:0', 'chunk_id is a rewritten column, not the key');
      strictEqual(row.ordinal, 0);
      deepStrictEqual(row.embedding, EXACT_VECTOR, 'same text must keep its vector');
      strictEqual(row.embedModel, MODEL);
      strictEqual(row.embedVersion, VERSION);
      strictEqual(row.embeddedAt, EMBEDDED_AT);
    },
  },

  {
    name: 'contentChanged clears the vector, the model, the version and the timestamp',
    async run(store, fx) {
      await store.upsertDocs([doc(fx, 'a')]);
      await store.upsertChunks([chunk(fx, 'a', 0)]);
      await store.writeEmbeddings([embedding('sha-a:0')]);

      // The edit. A vector belonging to the previous text is worse than no
      // vector: retrieval would return the new text under the old meaning.
      await store.upsertChunks([
        chunk(fx, 'a', 0, {
          chunkId: 'sha-a2:0',
          text: 'Rewritten section.',
          chunkSha: 'c-a-0-v2',
          contentChanged: true,
        }),
      ]);

      const rows = myChunks(fx, await store.listChunksForEmbedding(EMBEDDER));
      const row = only(rows, 'after an edited upsert');

      strictEqual(row.text, 'Rewritten section.');
      strictEqual(row.embedding, null, 'a stale vector must not survive an edit');
      strictEqual(row.embedModel, null);
      strictEqual(row.embedVersion, null);
      strictEqual(row.embeddedAt, null);
      strictEqual(needsEmbedding(row, EMBEDDER), true);
    },
  },

  {
    name: 'listChunksForEmbedding yields exactly the chunks needsEmbedding selects',
    async run(store, fx) {
      await store.upsertDocs([doc(fx, 'a')]);
      await store.upsertChunks([chunk(fx, 'a', 0), chunk(fx, 'a', 1), chunk(fx, 'a', 2)]);
      await store.writeEmbeddings([embedding('sha-a:1')]);

      const listed = myChunks(fx, await store.listChunksForEmbedding(EMBEDDER));
      const pending = listed.filter((c) => needsEmbedding(c, EMBEDDER)).map((c) => c.chunkId);

      // The store may over-return (memory does, deliberately) and may not
      // under-return. This is the only comparison the two owe each other.
      deepStrictEqual(pending.sort(), ['sha-a:0', 'sha-a:2']);
      ok(!pending.includes('sha-a:1'), 'a current vector is not pending');
    },
  },

  {
    name: 'a stored chunk round-trips its heading and text verbatim, empty heading included',
    async run(store, fx) {
      await store.upsertDocs([doc(fx, 'a')]);
      // Above the first heading, and prose that would break a hand-built
      // literal: a quote, a bracket and a non-ASCII dash.
      const nasty = "Taskly's rate — see [FACT-SHEET] — is 20%.";
      await store.upsertChunks([chunk(fx, 'a', 0, { heading: '', text: nasty })]);

      const row = only(myChunks(fx, await store.listChunksForEmbedding(EMBEDDER)), 'verbatim');
      strictEqual(row.heading, '');
      strictEqual(row.text, nasty);
    },
  },

  {
    name: 'deleteChunks removes rows by chunkId and leaves the document behind',
    async run(store, fx) {
      await store.upsertDocs([doc(fx, 'a')]);
      await store.upsertChunks([chunk(fx, 'a', 0), chunk(fx, 'a', 1)]);

      await store.deleteChunks(['sha-a:0']);

      deepStrictEqual([...(await store.readChunkIndex([at(fx, 'a')])).keys()], ['sha-a:1']);
      deepStrictEqual(mine(fx, (await store.readDocIndex()).keys()), [at(fx, 'a')]);
    },
  },

  {
    name: 'deleteDocs cascades to the document chunks',
    async run(store, fx) {
      await store.upsertDocs([doc(fx, 'a'), doc(fx, 'b')]);
      await store.upsertChunks([chunk(fx, 'a', 0), chunk(fx, 'b', 0)]);

      await store.deleteDocs([at(fx, 'a')]);

      deepStrictEqual(mine(fx, (await store.readDocIndex()).keys()), [at(fx, 'b')]);
      // 008's `on delete cascade`, mirrored by hand in the memory store so the
      // tests exercise what production does.
      deepStrictEqual(await store.readChunkIndex([at(fx, 'a')]), new Map());
      deepStrictEqual([...(await store.readChunkIndex([at(fx, 'b')])).keys()], ['sha-b:0']);
    },
  },

  {
    name: 'writeEmbeddings refuses a chunk that is not there',
    async run(store, fx) {
      await store.upsertDocs([doc(fx, 'a')]);
      await store.upsertChunks([chunk(fx, 'a', 0)]);

      await rejects(
        () => store.writeEmbeddings([embedding('sha-a:404')]),
        /writeEmbeddings: no such chunk sha-a:404/,
      );
    },
  },
];

/* -- the read path ------------------------------------------------------- */

/**
 * Seeds one canonical document, one draft and one superseded, each with a single
 * embedded chunk on its own axis, so a vector query can name a winner.
 *
 * `caveats`, `verify` and `supersededBy` are populated because they are the
 * three `text[]` columns, and `reviewed` because it is the one `date` — the
 * driver returns a `date` as a `Date` at LOCAL midnight, and a store that
 * reads it that way loses a day for every timezone west of UTC.
 */
async function seedIndex(seam: BrainIndexSeam, fx: BrainStoreFixtures): Promise<void> {
  await seam.store.upsertDocs([
    doc(fx, 'near', {
      caveats: ['GTA only at launch.', 'Numbers restate code.'],
      verify: ['lib/marketplace/fees.ts'],
    }),
    doc(fx, 'far', {
      type: 'reference',
      status: 'supporting',
      // Not a normal thing for a supporting document to carry; it is here so the
      // third text[] column is exercised on a row a search can actually return.
      supersededBy: [`${fx.prefix}near.md`],
    }),
    doc(fx, 'thinking', { type: 'plan', status: 'draft', reviewed: null }),
    doc(fx, 'wrong', { status: 'superseded', reviewed: null, supersededBy: [`${fx.prefix}near.md`] }),
  ]);

  await seam.store.upsertChunks([
    chunk(fx, 'near', 0, { text: 'The commission rate in the GTA.' }),
    chunk(fx, 'far', 0, { text: 'A second section about rates.' }),
    chunk(fx, 'thinking', 0, { text: 'Maybe the rate should move.' }),
    chunk(fx, 'wrong', 0, { text: 'The old rate, already corrected.' }),
  ]);

  await seam.store.writeEmbeddings([
    embedding('sha-near:0', unit(0)),
    embedding('sha-far:0', unit(1)),
    embedding('sha-thinking:0', unit(2)),
    embedding('sha-wrong:0', unit(0)),
  ]);
}

const paths = (candidates: readonly BrainIndexCandidate[]): string[] =>
  candidates.map((c) => c.doc.path);

const found = (candidates: readonly BrainIndexCandidate[], path: string): BrainIndexCandidate => {
  const hit = candidates.find((c) => c.doc.path === path);
  ok(hit !== undefined, `expected a candidate for ${path}, got ${paths(candidates).join(', ')}`);
  return hit;
};

export const BRAIN_INDEX_CONFORMANCE: readonly BrainIndexCase[] = [
  {
    name: 'a vector search ranks by distance, smaller first',
    async run(seam, fx) {
      await seedIndex(seam, fx);

      const candidates = await seam.index.search({ vector: unit(0), limit: 10 });
      const near = found(candidates, at(fx, 'near'));
      const far = found(candidates, at(fx, 'far'));

      ok(near.distance < far.distance, 'smaller must mean closer, as pgvector <=> does');
      ok(near.distance <= 0.5, `the matching axis should be close, got ${near.distance}`);
      ok(far.distance > 0.5, `an orthogonal axis should be far, got ${far.distance}`);
      strictEqual(paths(candidates)[0], at(fx, 'near'), 'candidates arrive ranked');
    },
  },

  {
    name: 'a superseded document is not a candidate at all',
    async run(seam, fx) {
      await seedIndex(seam, fx);

      // Seeded on the SAME axis as the winner, so it would rank first if the
      // index were willing to return it.
      const candidates = await seam.index.search({ vector: unit(0), limit: 10 });
      ok(!paths(candidates).includes(at(fx, 'wrong')), 'superseded is absent, not demoted');
    },
  },

  {
    name: 'a draft IS a candidate — the ladder is what stops it grounding a claim',
    async run(seam, fx) {
      await seedIndex(seam, fx);

      const candidates = await seam.index.search({ vector: unit(2), limit: 10 });
      ok(paths(candidates).includes(at(fx, 'thinking')), 'a draft may inform phrasing');

      // Driven through the domain rather than asserted about the SQL: this is
      // the exact call the caller makes, and it is where the guarantee lives.
      const result = await retrieve(seam.index, { vector: unit(2), limit: 10 }, NOW);
      const draft = result.hits.find((h) => h.doc.path === at(fx, 'thinking'));
      strictEqual(draft?.right, 'context_only');
      ok(
        !groundingSet(result).some((h) => h.doc.path === at(fx, 'thinking')),
        'a draft must never enter the grounding set',
      );
      strictEqual(
        result.excluded.length,
        0,
        'the superseded row never reached the ladder — the index already dropped it',
      );
    },
  },

  {
    name: 'every candidate carries its document metadata, arrays and review date included',
    async run(seam, fx) {
      await seedIndex(seam, fx);

      const candidates = await seam.index.search({ vector: unit(0), limit: 10 });
      const near = found(candidates, at(fx, 'near')).doc;

      strictEqual(near.title, 'Conformance near');
      strictEqual(near.type, 'spec');
      strictEqual(near.status, 'canonical');
      strictEqual(near.reviewed, REVIEWED, 'a date must not travel through a local-midnight Date');
      deepStrictEqual(near.caveats, ['GTA only at launch.', 'Numbers restate code.']);
      deepStrictEqual(near.verify, ['lib/marketplace/fees.ts']);
      deepStrictEqual(near.supersededBy, []);
      strictEqual(near.docSha, 'sha-near');

      const far = found(candidates, at(fx, 'far')).doc;
      strictEqual(far.reviewed, REVIEWED);
      deepStrictEqual(far.supersededBy, [at(fx, 'near')]);

      const chunkOf = found(candidates, at(fx, 'near')).chunk;
      deepStrictEqual(chunkOf, {
        chunkId: 'sha-near:0',
        ordinal: 0,
        heading: 'Commission',
        text: 'The commission rate in the GTA.',
        chunkSha: 'c-near-0',
      });
    },
  },

  {
    name: 'limit is a candidate budget the index honours',
    async run(seam, fx) {
      await seedIndex(seam, fx);

      strictEqual((await seam.index.search({ vector: unit(0), limit: 1 })).length, 1);
      strictEqual((await seam.index.search({ vector: unit(0), limit: 0 })).length, 0);
    },
  },

  {
    name: 'a chunk with no vector is invisible to a vector search',
    async run(seam, fx) {
      await seedIndex(seam, fx);
      await seam.store.upsertDocs([doc(fx, 'unembedded')]);
      await seam.store.upsertChunks([chunk(fx, 'unembedded', 0)]);

      const candidates = await seam.index.search({ vector: unit(0), limit: 10 });
      ok(
        !paths(candidates).includes(at(fx, 'unembedded')),
        'mid-backfill a vector search sees a SMALLER corpus, and nothing reports it',
      );
    },
  },

  {
    name: 'when both a vector and text are supplied the vector decides the ranking',
    async run(seam, fx) {
      await seedIndex(seam, fx);

      // The text names a word only the FAR document carries; the vector points
      // at the near one. `text` is documented as the fallback when embeddings
      // are unavailable, so it does not get to move a ranked list.
      const candidates = await seam.index.search({ vector: unit(0), text: 'second', limit: 10 });
      strictEqual(paths(candidates)[0], at(fx, 'near'));
    },
  },

  {
    name: 'a text search finds the chunks that carry the word, and no others',
    async run(seam, fx) {
      await seedIndex(seam, fx);

      // Only the RANKING differs between the two implementations (Postgres ranks
      // with ts_rank_cd over a stemmed tsvector; the reference cannot), so this
      // asserts the matched SET and the direction of `distance`, never an order.
      const candidates = await seam.index.search({ text: 'gta', limit: 10 });
      deepStrictEqual(paths(candidates), [at(fx, 'near')]);
      ok(candidates.every((c) => c.distance > 0), 'a text distance is still a distance');
    },
  },

  {
    name: 'a query with neither a vector nor text is refused, not answered',
    async run(seam, fx) {
      await seedIndex(seam, fx);

      await rejects(
        () => seam.index.search({ limit: 5 } as BrainQuery),
        /needs a vector or text/,
      );
    },
  },
];

/* -- the in-memory reference for the read port --------------------------- */

/**
 * A `BrainIndexPort` over `createMemoryBrainStore`.
 *
 * READ THIS BEFORE TRUSTING IT. Unlike `createMemoryBrainStore`, this is not an
 * upstream specification the adapter was written to match — `packages/brain`
 * ships no in-memory index, so it is written HERE, and a conformance suite whose
 * reference was written alongside the implementation proves less than one whose
 * reference predates it. What it does buy is real: the cases above run in CI
 * with no database, so the trust-ladder split, the ranking direction and the
 * metadata mapping are exercised now rather than whenever a `DATABASE_URL`
 * appears, and any disagreement between the two is one line of output.
 *
 * Two things it deliberately does NOT reproduce:
 *
 *   TEXT RANKING. Postgres stems, drops stopwords and ranks with `ts_rank_cd`;
 *   this matches whole lowercased words and gives every hit the same distance.
 *   No case above asserts a text ORDER, only which chunks matched.
 *
 *   A ZERO-NORM VECTOR. pgvector's cosine distance returns NaN; this returns 1.
 *   Nothing embeds a zero vector, and a case that did would be asserting on a
 *   number neither side means.
 */
export function createMemoryBrainIndex(store: MemoryBrainStore): BrainIndexPort {
  return {
    async search(query: BrainQuery): Promise<BrainIndexCandidate[]> {
      const docs = new Map(store.docs().map((d) => [d.path, d]));
      const rows = store.chunks().flatMap((c) => {
        const d = docs.get(c.path);
        // The one filter the SQL also applies, for the one rung whose rows are
        // absent rather than demoted. `retrieve()` still owns the guarantee.
        return d === undefined || d.status === 'superseded' ? [] : [{ c, d }];
      });

      const scored = rank(query, rows);
      scored.sort(
        (a, b) =>
          a.distance - b.distance ||
          a.d.path.localeCompare(b.d.path) ||
          a.c.ordinal - b.c.ordinal,
      );

      return scored.slice(0, Math.max(0, Math.trunc(query.limit))).map(({ c, d, distance }) => ({
        chunk: {
          chunkId: c.chunkId,
          ordinal: c.ordinal,
          heading: c.heading,
          text: c.text,
          chunkSha: c.chunkSha,
        },
        doc: {
          path: d.path,
          title: d.title,
          type: d.type,
          status: d.status,
          reviewed: d.reviewed,
          caveats: [...d.caveats],
          verify: [...d.verify],
          supersededBy: [...d.supersededBy],
          docSha: d.docSha,
        },
        distance,
      }));
    },
  };
}

interface Row {
  c: StoredChunk;
  d: DocUpsert;
}

function rank(query: BrainQuery, rows: readonly Row[]): (Row & { distance: number })[] {
  if (query.vector !== undefined) {
    const q = query.vector;
    return rows.flatMap((row) =>
      row.c.embedding === null || row.c.embedding.length !== q.length
        ? []
        : [{ ...row, distance: cosineDistance(q, row.c.embedding) }],
    );
  }

  if (query.text !== undefined) {
    const wanted = words(query.text);
    if (wanted.length === 0) return [];
    return rows.flatMap((row) => {
      const have = new Set(words(`${row.c.heading} ${row.c.text}`));
      return wanted.every((w) => have.has(w)) ? [{ ...row, distance: 0.5 }] : [];
    });
  }

  // The message is IMPORTED rather than copied so the two cannot drift; the
  // case above still matches on a regex, which is what would catch it if they did.
  throw new AdapterError(NO_QUERY_MESSAGE);
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);

/** 1 - cosine similarity, which is what pgvector's `<=>` computes. */
function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 1 : 1 - dot / norm;
}
