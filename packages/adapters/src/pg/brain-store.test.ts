/**
 * The Postgres `BrainStorePort`, without Postgres.
 *
 * What can be proven with no connection is narrow but not small: that the
 * halfvec literal is the format pgvector parses and that a wrong width is
 * refused BEFORE a statement is issued (so a bad batch cannot abort the caller's
 * transaction), that `upsertChunks` conflicts on `(path, ordinal)` and clears
 * the four vector columns for — and only for — the rows flagged
 * `contentChanged`, that the re-embed predicate really is pushed into SQL, and
 * that a row shaped the way node-postgres actually hands one back decodes into a
 * `StoredChunk`.
 *
 * What CANNOT be proven here is that Postgres accepts any of it. That is
 * `brain-store.live.test.ts`, and it is skipping.
 */
import { describe, expect, it } from 'vitest';
import type { QueryRow } from '@tmos/db';
import type { ChunkUpsert, DocUpsert, EmbeddingWrite } from '@tmos/brain';

import { ConstraintError, DecodeError, NotFoundError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  BRAIN_EMBEDDING_DIMENSIONS,
  deleteBrainChunks,
  deleteBrainDocs,
  formatHalfvec,
  listBrainChunksForEmbedding,
  parseHalfvec,
  readBrainChunkIndex,
  readBrainDocIndex,
  rowToStoredChunk,
  upsertBrainChunks,
  upsertBrainDocs,
  writeBrainEmbeddings,
} from './brain-store.js';

const PATH = 'tmos-conf/a.md';
const SYNCED_AT = '2026-08-20T12:00:00.000Z';
const EMBEDDED_AT = '2026-08-20T12:30:00.000Z';

const vector = (fill = 0.5): number[] => new Array<number>(BRAIN_EMBEDDING_DIMENSIONS).fill(fill);

const doc = (over: Partial<DocUpsert> = {}): DocUpsert => ({
  path: PATH,
  title: 'A',
  type: 'spec',
  status: 'canonical',
  reviewed: '2026-08-01',
  caveats: ['GTA only.'],
  verify: ['lib/marketplace/fees.ts'],
  supersededBy: [],
  docSha: 'sha-a',
  commitSha: 'commit-1',
  syncedAt: SYNCED_AT,
  ...over,
});

const chunk = (over: Partial<ChunkUpsert> = {}): ChunkUpsert => ({
  chunkId: 'sha-a:0',
  path: PATH,
  ordinal: 0,
  heading: 'Commission',
  text: 'The rate.',
  chunkSha: 'c-a-0',
  contentChanged: true,
  ...over,
});

const write = (over: Partial<EmbeddingWrite> = {}): EmbeddingWrite => ({
  chunkId: 'sha-a:0',
  embedding: vector(),
  model: 'm',
  version: 'v1',
  embeddedAt: EMBEDDED_AT,
  ...over,
});

/** The single jsonb parameter a batch statement carries. */
const payloadOf = (values: readonly unknown[]): Record<string, unknown>[] =>
  JSON.parse(String(values[0])) as Record<string, unknown>[];

describe('halfvec, encoded and decoded by hand', () => {
  it('formats the literal pgvector parses', () => {
    const literal = formatHalfvec([0.5, -0.25, 0].concat(new Array(1021).fill(0)), 'v');
    expect(literal.startsWith('[0.5,-0.25,0,')).toBe(true);
    expect(literal.endsWith(']')).toBe(true);
    expect(literal.split(',')).toHaveLength(BRAIN_EMBEDDING_DIMENSIONS);
  });

  it('refuses the wrong width before any statement is built', () => {
    // The database would refuse it too (22000), but a raised exception aborts
    // the caller's whole transaction — `@tmos/db` has no savepoints.
    expect(() => formatHalfvec([0.1, 0.2], 'v')).toThrow(ConstraintError);
    expect(() => formatHalfvec([0.1, 0.2], 'v')).toThrow(/expected 1024 dimensions, not 2/);
  });

  it('refuses a component that is not a finite number', () => {
    const bad = vector();
    bad[7] = Number.NaN;
    expect(() => formatHalfvec(bad, 'v')).toThrow(ConstraintError);
    expect(() => formatHalfvec(bad, 'v')).toThrow(/v\[7\]/);
  });

  it('parses the literal back, and a missing vector as null', () => {
    expect(parseHalfvec('[0.5,-0.25,0]', 'v')).toEqual([0.5, -0.25, 0]);
    expect(parseHalfvec('[]', 'v')).toEqual([]);
    expect(parseHalfvec(null, 'v')).toBeNull();
    // A custom type parser somewhere else in the process must not break this.
    expect(parseHalfvec([0.5, 0.25], 'v')).toEqual([0.5, 0.25]);
  });

  it('round-trips every component float16 can hold exactly', () => {
    const exact = Array.from({ length: BRAIN_EMBEDDING_DIMENSIONS }, (_, i) => ((i % 5) - 2) / 4);
    expect(parseHalfvec(formatHalfvec(exact, 'v'), 'v')).toEqual(exact);
  });

  it('names the column when the value is not a vector literal at all', () => {
    expect(() => parseHalfvec('0.5,0.25', 'brain_chunk[x].embedding')).toThrow(DecodeError);
    expect(() => parseHalfvec('0.5,0.25', 'brain_chunk[x].embedding')).toThrow(/brain_chunk\[x\]/);
  });
});

describe('upsertChunks — the vector-clearing rule', () => {
  it('splits the batch on contentChanged and nulls the vector only for the changed half', async () => {
    const ex = recordingExecutor();
    await upsertBrainChunks(
      [chunk({ ordinal: 0, contentChanged: false }), chunk({ ordinal: 1, contentChanged: true })],
      ex,
    );

    expect(ex.queries).toHaveLength(2);
    const [carried, changed] = ex.queries;

    expect(carried?.text).not.toContain('embedding');
    expect(carried?.text).not.toContain('embed_model');
    expect(payloadOf(carried?.values ?? []).map((r) => r.ordinal)).toEqual([0]);

    expect(changed?.text).toContain('embedding     = null');
    expect(changed?.text).toContain('embed_model   = null');
    expect(changed?.text).toContain('embed_version = null');
    expect(changed?.text).toContain('embedded_at   = null');
    expect(payloadOf(changed?.values ?? []).map((r) => r.ordinal)).toEqual([1]);
  });

  it('issues one statement when every row shares the flag, and none for an empty batch', async () => {
    const ex = recordingExecutor();
    await upsertBrainChunks([chunk({ ordinal: 0 }), chunk({ ordinal: 1 })], ex);
    expect(ex.queries).toHaveLength(1);

    await upsertBrainChunks([], ex);
    expect(ex.queries).toHaveLength(1);
  });

  it('conflicts on (path, ordinal) and rewrites chunk_id, never the other way round', async () => {
    const ex = recordingExecutor();
    await upsertBrainChunks([chunk()], ex);

    const q = ex.last();
    expect(q.text).toContain('on conflict (path, ordinal) do update set');
    expect(q.text).toContain('chunk_id  = excluded.chunk_id');
    expect(q.text).not.toContain('on conflict (chunk_id)');
  });

  it('quotes the column literally named text, in both the target and the source', async () => {
    const ex = recordingExecutor();
    await upsertBrainChunks([chunk()], ex);

    const q = ex.last();
    expect(q.text).toContain('"text"');
    expect(q.text).toContain('x."text"');
    expect(q.text).toContain('"text"    = excluded."text"');
  });

  it('collapses a repeated (path, ordinal) to the last row, as the memory store does', async () => {
    // Postgres raises 21000 when one statement carries two rows with the same
    // conflict key; the memory store simply overwrites. The divergence is
    // removed rather than documented.
    const ex = recordingExecutor();
    await upsertBrainChunks(
      [chunk({ chunkSha: 'first', contentChanged: true }), chunk({ chunkSha: 'second', contentChanged: true })],
      ex,
    );

    expect(ex.queries).toHaveLength(1);
    expect(payloadOf(ex.last().values).map((r) => r.chunk_sha)).toEqual(['second']);
  });

  it('sends the whole batch as one jsonb parameter and never as query text', async () => {
    const ex = recordingExecutor();
    await upsertBrainChunks([chunk({ text: "Taskly's rate is 20%." })], ex);

    const q = ex.last();
    expect(q.text).not.toContain('Taskly');
    expect(q.values).toHaveLength(1);
    expect(payloadOf(q.values)[0]?.text).toBe("Taskly's rate is 20%.");
  });
});

describe('upsertDocs', () => {
  it('expands one jsonb array, keeps the text[] columns as arrays, and upserts on path', async () => {
    const ex = recordingExecutor();
    await upsertBrainDocs([doc()], ex);

    const q = ex.last();
    expect(q.text).toContain('caveats text[], verify text[], superseded_by text[]');
    expect(q.text).toContain('on conflict (path) do update set');
    expect(payloadOf(q.values)[0]).toMatchObject({
      path: PATH,
      superseded_by: [],
      caveats: ['GTA only.'],
      verify: ['lib/marketplace/fees.ts'],
      doc_sha: 'sha-a',
      commit_sha: 'commit-1',
      synced_at: SYNCED_AT,
    });
  });

  it('reads reviewed as a date and synced_at as a timestamptz', async () => {
    const ex = recordingExecutor();
    await upsertBrainDocs([doc({ reviewed: null })], ex);

    expect(ex.last().text).toContain('reviewed date');
    expect(ex.last().text).toContain('synced_at timestamptz');
    expect(payloadOf(ex.last().values)[0]?.reviewed).toBeNull();
  });

  it('collapses a repeated path to the last row', async () => {
    const ex = recordingExecutor();
    await upsertBrainDocs([doc({ docSha: 'first' }), doc({ docSha: 'second' })], ex);
    expect(payloadOf(ex.last().values).map((r) => r.doc_sha)).toEqual(['second']);
  });
});

describe('reads', () => {
  it('decodes the doc index into path → { docSha, status }', async () => {
    const ex = recordingExecutor([
      [
        { path: PATH, doc_sha: 'sha-a', status: 'canonical' },
        { path: 'tmos-conf/b.md', doc_sha: 'sha-b', status: 'superseded' },
      ],
    ]);

    const index = await readBrainDocIndex(ex);
    // Superseded rows are INCLUDED: ingest needs them to notice a document that
    // changed status without changing its bytes.
    expect(index.get('tmos-conf/b.md')).toEqual({ docSha: 'sha-b', status: 'superseded' });
  });

  it('refuses a status the trust ladder does not define', async () => {
    const ex = recordingExecutor([[{ path: PATH, doc_sha: 'sha-a', status: 'provisional' }]]);
    await expect(readBrainDocIndex(ex)).rejects.toThrow(DecodeError);
  });

  it('asks for the given paths only, and asks nothing at all for an empty list', async () => {
    const ex = recordingExecutor([[]]);
    await readBrainChunkIndex([PATH], ex);
    expect(ex.last().text).toContain('where path = any($1::text[])');
    expect(ex.last().values).toEqual([[PATH]]);

    expect(await readBrainChunkIndex([], ex)).toEqual(new Map());
    expect(ex.queries).toHaveLength(1);
  });

  it('pushes the re-embed predicate into SQL and selects the vector as text', async () => {
    const ex = recordingExecutor([[]]);
    await listBrainChunksForEmbedding({ model: 'm', version: 'v1' }, ex);

    const q = ex.last();
    // `where embedding is null` is what `brain_chunk_needs_embed_idx` indexes.
    expect(q.text).toContain('where embedding is null');
    expect(q.text).toContain('embed_model is distinct from $1');
    expect(q.text).toContain('embed_version is distinct from $2');
    expect(q.text).toContain('embedding::text as embedding');
    expect(q.values).toEqual(['m', 'v1']);
  });

  it('decodes a row shaped the way node-postgres really answers', () => {
    const row: QueryRow = {
      chunk_id: 'sha-a:0',
      path: PATH,
      ordinal: 0,
      heading: 'Commission',
      text: 'The rate.',
      chunk_sha: 'c-a-0',
      embedding: '[0.5,-0.25,0]',
      embed_model: 'm',
      embed_version: 'v1',
      embedded_at: new Date(EMBEDDED_AT),
    };

    expect(rowToStoredChunk(row)).toEqual({
      chunkId: 'sha-a:0',
      path: PATH,
      ordinal: 0,
      heading: 'Commission',
      text: 'The rate.',
      chunkSha: 'c-a-0',
      embedding: [0.5, -0.25, 0],
      embedModel: 'm',
      embedVersion: 'v1',
      embeddedAt: EMBEDDED_AT,
    });
  });

  it('decodes an unembedded chunk as null everywhere the vector would be', () => {
    const row: QueryRow = {
      chunk_id: 'sha-a:0',
      path: PATH,
      ordinal: 0,
      heading: '',
      text: 'x',
      chunk_sha: 'c',
      embedding: null,
      embed_model: null,
      embed_version: null,
      embedded_at: null,
    };
    expect(rowToStoredChunk(row)).toMatchObject({
      embedding: null,
      embedModel: null,
      embedVersion: null,
      embeddedAt: null,
    });
  });
});

describe('deletes', () => {
  it('deleteDocs touches brain_doc only — the chunks go by cascade', async () => {
    const ex = recordingExecutor();
    await deleteBrainDocs([PATH], ex);

    expect(ex.last().text).toContain('delete from brain_doc');
    expect(ex.last().text).not.toContain('brain_chunk');
    expect(ex.queries).toHaveLength(1);
  });

  it('deleteChunks passes the ids as an array, never spliced into an in (...)', async () => {
    const ex = recordingExecutor();
    await deleteBrainChunks(['sha-a:0', 'sha-a:1'], ex);

    expect(ex.last().text).toContain('chunk_id = any($1::text[])');
    expect(ex.last().values).toEqual([['sha-a:0', 'sha-a:1']]);

    await deleteBrainChunks([], ex);
    expect(ex.queries).toHaveLength(1);
  });
});

describe('writeEmbeddings', () => {
  it('casts the literal to halfvec(1024) and sends one row per chunk', async () => {
    const ex = recordingExecutor([[{}, {}]]);
    await writeBrainEmbeddings([write(), write({ chunkId: 'sha-a:1' })], ex);

    const q = ex.last();
    expect(q.text).toContain('x.embedding::halfvec(1024)');
    const rows = payloadOf(q.values);
    expect(rows).toHaveLength(2);
    expect(String(rows[0]?.embedding).startsWith('[0.5,')).toBe(true);
    expect(rows[0]?.embedded_at).toBe(EMBEDDED_AT);
  });

  it('refuses a wrong-width vector before issuing anything', async () => {
    const ex = recordingExecutor();
    await expect(writeBrainEmbeddings([write({ embedding: [0.1] })], ex)).rejects.toThrow(
      ConstraintError,
    );
    expect(ex.queries).toHaveLength(0);
  });

  it('diagnoses a short write into the message the memory store raises', async () => {
    // Zero rows updated, then a SECOND read works out which id was missing. The
    // update did not raise, so the transaction is still usable for that read.
    const ex = recordingExecutor([[], [{ id: 'sha-a:404' }]]);

    await expect(writeBrainEmbeddings([write({ chunkId: 'sha-a:404' })], ex)).rejects.toThrow(
      NotFoundError,
    );
    expect(ex.queries).toHaveLength(2);
    expect(ex.last().text).toContain('not exists');
  });

  it('collapses a repeated chunkId so the row count can be trusted', async () => {
    const ex = recordingExecutor([[{}]]);
    await writeBrainEmbeddings([write({ model: 'first' }), write({ model: 'second' })], ex);

    const rows = payloadOf(ex.last().values);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.embed_model).toBe('second');
  });

  it('issues nothing for an empty batch', async () => {
    const ex = recordingExecutor();
    await writeBrainEmbeddings([], ex);
    expect(ex.queries).toHaveLength(0);
  });
});
