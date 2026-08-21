/**
 * `BrainStorePort` (packages/brain/src/ingest.ts) on `brain_doc` + `brain_chunk`
 * — migration 008.
 *
 * The behavioural specification is `createMemoryBrainStore`, not this file.
 * Where the two could differ they are made to agree; where they CANNOT they are
 * named in a comment here and in the README.
 *
 * TWO RULES THE PORT CALLS LOAD-BEARING, both implemented below and both
 * asserted by the conformance suite:
 *
 *   CHUNKS UPSERT ON `(path, ordinal)`, NEVER ON `chunk_id`. A `chunkId` is
 *   `${docSha}:${ordinal}`, so it rotates for EVERY chunk of a document the
 *   moment any byte of that document changes. Keying the write on it would
 *   rewrite all forty rows of a forty-chunk file for a one-word edit and throw
 *   away forty vectors. 008 has `unique (path, ordinal)` for exactly this, and
 *   `chunk_id` is therefore a REWRITTEN COLUMN rather than the conflict target.
 *
 *   `contentChanged === true` CLEARS `embedding`, `embed_model`,
 *   `embed_version` AND `embedded_at`. A vector belonging to the previous text
 *   is worse than no vector: retrieval returns the new text under the old
 *   meaning and nothing about that looks like a bug.
 *   `packages/brain/src/index.ts` calls this "the single riskiest untested
 *   assumption in this package", which is why `upsertChunks` is the one method
 *   here that is deliberately TWO statements — the flag cannot be read from
 *   `excluded` (it is not a column), and deriving it in SQL from
 *   `chunk_sha is distinct from ...` would re-derive a rule the port already
 *   decided, and disagree with the memory store on an added document whose
 *   chunk index was never read.
 *
 * `ex: Executor = db()` is the LAST parameter of every function, so each one
 * works standalone and enlists in someone else's `withTx` with no plumbing.
 */
import { db, sql, type Executor, type QueryRow, type SqlQuery } from '@tmos/db';
import type {
  BrainStorePort,
  ChunkUpsert,
  DocUpsert,
  EmbedCriteria,
  EmbeddingWrite,
  StoredChunk,
  StoredChunkState,
  StoredDocState,
} from '@tmos/brain';
import { brainStatusSchema } from '@tmos/contracts';

import { ConstraintError, DecodeError, NotFoundError, guard } from '../errors.js';
import { asIsoOrNull, asNumber, asText, asTextOrNull, asUnion } from './values.js';

/**
 * The width of `brain_chunk.embedding`, which is `halfvec(1024)` in 008.
 *
 * It is a schema fact, not a preference: the cast below must name the same
 * number, and a cast cannot take a placeholder (there is no `sql.raw`), so the
 * literal appears in the SQL and this constant is what everything else — the
 * pre-flight length check, the tests, the query-vector guard — compares against.
 * `EmbedderPort.dimensions` must equal it or nothing can ever be written.
 */
export const BRAIN_EMBEDDING_DIMENSIONS = 1024;

/* -- halfvec, by hand ---------------------------------------------------- */

/**
 * `number[]` to the pgvector text literal, e.g. `[0.5,-0.25,0]`.
 *
 * node-postgres has no `halfvec` (or `vector`) type: it does not know the OID,
 * so it neither serialises an array into one nor parses one back. Both
 * directions are therefore done here and the value is cast in the statement.
 *
 * Length and finiteness are checked BEFORE the statement is issued. Postgres
 * would refuse both itself — a typmod'd cast raises 22000 `expected 1024
 * dimensions, not N`, and `NaN` fails input syntax — but a raised exception
 * aborts the caller's whole transaction (`@tmos/db` has no savepoints), so a
 * batch of a hundred vectors with one bad row would take everything else with
 * it. `ConstraintError` is the class `translatePgError` would have produced from
 * 22000, so a caller cannot tell which side refused: only WHEN.
 */
export function formatHalfvec(vector: readonly number[], column: string): string {
  if (vector.length !== BRAIN_EMBEDDING_DIMENSIONS) {
    throw new ConstraintError(
      `${column}: expected ${BRAIN_EMBEDDING_DIMENSIONS} dimensions, not ${vector.length} — ` +
        'brain_chunk.embedding is halfvec(1024) (migration 008) and the database refuses ' +
        'any other width.',
    );
  }
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new ConstraintError(`${column}[${i}]: not a finite number (${String(x)})`);
    }
  }
  return `[${vector.join(',')}]`;
}

/**
 * The pgvector text literal back to `number[]`, or null for a chunk with no
 * vector.
 *
 * Reads select `embedding::text`, so this normally meets a string. An ARRAY is
 * accepted too: `pg.types.setTypeParser` is global mutable process state and
 * somebody registering a vector parser elsewhere must not break this decoder —
 * the same reason nothing in this package trusts the driver's types.
 *
 * PRECISION: `halfvec` is float16. A vector written and read back is NOT the
 * vector that went in (0.1 returns as 0.099975586), while the memory store keeps
 * every bit of a float64. Nothing depends on it — `needsEmbedding` compares
 * length, model and version, never components — but a test asserting equality
 * must use values float16 represents exactly.
 */
export function parseHalfvec(value: unknown, column: string): number[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v, i) => asNumber(v, `${column}[${i}]`));

  const text = asText(value, column).trim();
  if (!text.startsWith('[') || !text.endsWith(']')) {
    throw new DecodeError(`${column}: expected a pgvector literal like [1,2,3], got ${text}`);
  }
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part, i) => asNumber(part.trim(), `${column}[${i}]`));
}

/* -- row decoding -------------------------------------------------------- */

/** `text` is a column name in 008, so it is quoted in every statement below. */
const CHUNK_COLUMNS = sql`
  chunk_id, path, ordinal, heading, "text", chunk_sha,
  embedding::text as embedding, embed_model, embed_version, embedded_at`;

export function rowToStoredChunk(row: QueryRow): StoredChunk {
  const chunkId = asText(row.chunk_id, 'brain_chunk.chunk_id');
  const at = (column: string): string => `brain_chunk[${chunkId}].${column}`;

  return {
    chunkId,
    path: asText(row.path, at('path')),
    ordinal: asNumber(row.ordinal, at('ordinal')),
    heading: asText(row.heading, at('heading')),
    text: asText(row.text, at('text')),
    chunkSha: asText(row.chunk_sha, at('chunk_sha')),
    embedding: parseHalfvec(row.embedding, at('embedding')),
    embedModel: asTextOrNull(row.embed_model, at('embed_model')),
    embedVersion: asTextOrNull(row.embed_version, at('embed_version')),
    embeddedAt: asIsoOrNull(row.embedded_at, at('embedded_at')),
  };
}

/* -- reads --------------------------------------------------------------- */

/**
 * `path -> { docSha, status }` for EVERYTHING indexed, superseded rows included.
 *
 * Ingest needs them: a document that left the Brain is found by absence from
 * the snapshot, and a document that only changed STATUS (canonical to
 * superseded) has the same `doc_sha` and would otherwise look unchanged forever.
 */
export async function readBrainDocIndex(ex: Executor = db()): Promise<Map<string, StoredDocState>> {
  return guard('readDocIndex', async () => {
    const rows = await ex.query(sql`select path, doc_sha, status from brain_doc order by path`);
    return new Map(
      rows.map((row) => {
        const path = asText(row.path, 'brain_doc.path');
        return [
          path,
          {
            docSha: asText(row.doc_sha, `brain_doc[${path}].doc_sha`),
            status: asUnion(row.status, brainStatusSchema.options, `brain_doc[${path}].status`),
          },
        ];
      }),
    );
  });
}

/**
 * `chunkId -> state`, for the given paths only — the read stays proportional to
 * what changed rather than to the size of the corpus, which is the whole reason
 * the port takes paths at all. An empty list short-circuits: `= any('{}')`
 * returns nothing, so the round trip could only agree with skipping it.
 */
export async function readBrainChunkIndex(
  paths: readonly string[],
  ex: Executor = db(),
): Promise<Map<string, StoredChunkState>> {
  if (paths.length === 0) return new Map();

  return guard('readChunkIndex', async () => {
    const rows = await ex.query(sql`
      select chunk_id, path, ordinal, chunk_sha from brain_chunk
       where path = any(${[...paths]}::text[])
       order by path, ordinal`);
    return new Map(
      rows.map((row) => {
        const chunkId = asText(row.chunk_id, 'brain_chunk.chunk_id');
        const at = (column: string): string => `brain_chunk[${chunkId}].${column}`;
        return [
          chunkId,
          {
            path: asText(row.path, at('path')),
            ordinal: asNumber(row.ordinal, at('ordinal')),
            chunkSha: asText(row.chunk_sha, at('chunk_sha')),
          },
        ];
      }),
    );
  });
}

/* -- writes -------------------------------------------------------------- */

/**
 * A batch reaches Postgres as ONE jsonb document expanded by
 * `jsonb_to_recordset`, not as N statements.
 *
 * A first sync writes the whole corpus — well over a hundred documents and
 * thousands of chunks — and a statement per row is that many round trips inside
 * one transaction. `unnest` with parallel arrays would do for the chunk table,
 * but `brain_doc.caveats` / `verify` / `superseded_by` are `text[]` COLUMNS and
 * a parallel array of arrays flattens; a jsonb array of arrays does not. One
 * idiom for both tables beats two.
 */
const rowsOf = (values: readonly Record<string, unknown>[]): string => JSON.stringify(values);

/**
 * Last write wins for a repeated key, exactly as the memory store's sequential
 * `for` loop does.
 *
 * Not cosmetic: `insert ... on conflict do update` raises 21000 ("cannot affect
 * row a second time") when one statement carries two rows with the same conflict
 * key, and `update ... from` picks an arbitrary winner. Both are divergences
 * from a store that simply overwrites, and both are removed here rather than
 * documented.
 */
function lastWins<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(keyOf(row), row);
  return [...byKey.values()];
}

export async function upsertBrainDocs(
  docs: readonly DocUpsert[],
  ex: Executor = db(),
): Promise<void> {
  if (docs.length === 0) return;

  const payload = rowsOf(
    lastWins(docs, (d) => d.path).map((d) => ({
      path: d.path,
      title: d.title,
      type: d.type,
      status: d.status,
      reviewed: d.reviewed,
      caveats: d.caveats,
      verify: d.verify,
      superseded_by: d.supersededBy,
      doc_sha: d.docSha,
      commit_sha: d.commitSha,
      synced_at: d.syncedAt,
    })),
  );

  await guard('upsertDocs', () =>
    ex.execute(sql`
      insert into brain_doc (
        path, title, type, status, reviewed,
        caveats, verify, superseded_by, doc_sha, commit_sha, synced_at
      )
      select x.path, x.title, x.type, x.status, x.reviewed,
             x.caveats, x.verify, x.superseded_by, x.doc_sha, x.commit_sha, x.synced_at
        from jsonb_to_recordset(${payload}::jsonb) as x(
          path text, title text, type text, status text, reviewed date,
          caveats text[], verify text[], superseded_by text[],
          doc_sha text, commit_sha text, synced_at timestamptz)
      on conflict (path) do update set
        title         = excluded.title,
        type          = excluded.type,
        status        = excluded.status,
        reviewed      = excluded.reviewed,
        caveats       = excluded.caveats,
        verify        = excluded.verify,
        superseded_by = excluded.superseded_by,
        doc_sha       = excluded.doc_sha,
        commit_sha    = excluded.commit_sha,
        synced_at     = excluded.synced_at`),
  );
}

/**
 * THE VECTOR-CLEARING RULE, and the only place in this package a port method is
 * more than one statement.
 *
 * The batch is split on `contentChanged` and each half runs as its own upsert,
 * identical except for the four columns the changed half sets to null. The flag
 * cannot travel through `excluded` — it is not a column of `brain_chunk` — and
 * the alternative (deriving it from `brain_chunk.chunk_sha is distinct from
 * excluded.chunk_sha`) re-derives a decision `ingestSnapshot` already made and
 * disagrees with it for a document the diff treats as ADDED, whose chunk index
 * was never read.
 */
export async function upsertBrainChunks(
  chunks: readonly ChunkUpsert[],
  ex: Executor = db(),
): Promise<void> {
  if (chunks.length === 0) return;

  const deduped = lastWins(chunks, (c) => `${c.path} ${c.ordinal}`);
  const changed = deduped.filter((c) => c.contentChanged);
  const carried = deduped.filter((c) => !c.contentChanged);

  // Same text, same vector: `embedding`, `embed_model`, `embed_version` and
  // `embedded_at` are absent from this SET list, so the row keeps them and
  // re-embedding it is spend nobody asked for.
  if (carried.length > 0) await upsertChunkBatch(carried, sql``, ex);

  // New or edited text: the old vector is a lie about what this row says.
  if (changed.length > 0) {
    await upsertChunkBatch(
      changed,
      sql`,
        embedding     = null,
        embed_model   = null,
        embed_version = null,
        embedded_at   = null`,
      ex,
    );
  }
}

async function upsertChunkBatch(
  chunks: readonly ChunkUpsert[],
  clearVector: SqlQuery,
  ex: Executor,
): Promise<void> {
  const payload = rowsOf(
    chunks.map((c) => ({
      chunk_id: c.chunkId,
      path: c.path,
      ordinal: c.ordinal,
      heading: c.heading,
      text: c.text,
      chunk_sha: c.chunkSha,
    })),
  );

  await guard('upsertChunks', () =>
    ex.execute(sql`
      insert into brain_chunk (chunk_id, path, ordinal, heading, "text", chunk_sha)
      select x.chunk_id, x.path, x.ordinal, x.heading, x."text", x.chunk_sha
        from jsonb_to_recordset(${payload}::jsonb) as x(
          chunk_id text, path text, ordinal int, heading text, "text" text, chunk_sha text)
      on conflict (path, ordinal) do update set
        chunk_id  = excluded.chunk_id,
        heading   = excluded.heading,
        "text"    = excluded."text",
        chunk_sha = excluded.chunk_sha${clearVector}`),
  );
}

export async function deleteBrainChunks(
  chunkIds: readonly string[],
  ex: Executor = db(),
): Promise<void> {
  if (chunkIds.length === 0) return;

  await guard('deleteChunks', () =>
    ex.execute(sql`delete from brain_chunk where chunk_id = any(${[...chunkIds]}::text[])`),
  );
}

/**
 * Documents only. `brain_chunk.path references brain_doc(path) on delete
 * cascade`, so the chunks go with them in the same statement — and the memory
 * store mirrors that cascade by hand for the same reason. Deleting the chunks
 * separately would be a second round trip that can only ever disagree.
 */
export async function deleteBrainDocs(
  paths: readonly string[],
  ex: Executor = db(),
): Promise<void> {
  if (paths.length === 0) return;

  await guard('deleteDocs', () =>
    ex.execute(sql`delete from brain_doc where path = any(${[...paths]}::text[])`),
  );
}

/**
 * The re-embed queue, with the predicate PUSHED DOWN — the memory store returns
 * every chunk and lets `needsEmbedding` filter, and its own comment says the
 * Postgres adapter should not.
 *
 * `where embedding is null` matches the partial index 008 declares for this
 * query (`brain_chunk_needs_embed_idx`); the model/version arms are the "vectors
 * from different models are not comparable" rule, in SQL.
 *
 * It is an OPTIMISATION, never the correctness boundary: `embedPending` re-runs
 * `needsEmbedding` on whatever comes back, so over-returning costs a `skipped`
 * count and nothing else. The one clause that CANNOT be pushed down is
 * `needsEmbedding`'s width check — `EmbedCriteria` carries no `dimensions` — so
 * a chunk whose stored vector is the wrong width but whose model and version
 * match would not be listed. It is unreachable while the column is
 * `halfvec(1024)`: a vector of any other width cannot be stored in the first
 * place, so a wrong width means the EMBEDDER is wrong, and nothing it produced
 * could be written either.
 */
export async function listBrainChunksForEmbedding(
  criteria: EmbedCriteria,
  ex: Executor = db(),
): Promise<StoredChunk[]> {
  return guard('listChunksForEmbedding', async () => {
    const rows = await ex.query(sql`
      select ${CHUNK_COLUMNS} from brain_chunk
       where embedding is null
          or embed_model is distinct from ${criteria.model}
          or embed_version is distinct from ${criteria.version}
       order by path, ordinal`);
    return rows.map(rowToStoredChunk);
  });
}

/**
 * One statement for the whole batch, and a second one ONLY to explain a short
 * write.
 *
 * The memory store throws `writeEmbeddings: no such chunk X`, so this must too —
 * but an `update ... from` that matches nothing simply updates fewer rows rather
 * than raising, which is what keeps the caller's transaction usable long enough
 * to ask which id was missing. Same ordering, and the same reason, as the fact
 * adapter's closers.
 */
export async function writeBrainEmbeddings(
  writes: readonly EmbeddingWrite[],
  ex: Executor = db(),
): Promise<void> {
  if (writes.length === 0) return;

  const deduped = lastWins(writes, (w) => w.chunkId);
  const payload = rowsOf(
    deduped.map((w) => ({
      chunk_id: w.chunkId,
      embedding: formatHalfvec(w.embedding, `writeEmbeddings[${w.chunkId}].embedding`),
      embed_model: w.model,
      embed_version: w.version,
      embedded_at: w.embeddedAt,
    })),
  );

  const updated = await guard('writeEmbeddings', () =>
    ex.execute(sql`
      update brain_chunk c
         set embedding     = x.embedding::halfvec(1024),
             embed_model   = x.embed_model,
             embed_version = x.embed_version,
             embedded_at   = x.embedded_at
        from jsonb_to_recordset(${payload}::jsonb) as x(
          chunk_id text, embedding text, embed_model text, embed_version text,
          embedded_at timestamptz)
       where c.chunk_id = x.chunk_id`),
  );
  if (updated >= deduped.length) return;

  const missing = await guard('writeEmbeddings', () =>
    ex.maybeOne(sql`
      select t.id from unnest(${deduped.map((w) => w.chunkId)}::text[]) as t(id)
       where not exists (select 1 from brain_chunk c where c.chunk_id = t.id)
       order by t.id limit 1`),
  );
  // Word for word what the memory store raises, so a test written against one
  // store passes against the other.
  const id = missing === null ? '(unknown)' : asText(missing.id, 'brain_chunk.chunk_id');
  throw new NotFoundError(`writeEmbeddings: no such chunk ${id}`);
}

/**
 * The port, bound to an executor.
 *
 * `executor` is resolved PER CALL, never captured in a default argument: a store
 * built at module scope and used inside a `withTx` must enlist in that
 * transaction, and `db()` only knows which one is running while it is running.
 */
export function createPostgresBrainStore(executor?: Executor): BrainStorePort {
  const ex = (): Executor => executor ?? db();

  return {
    readDocIndex: () => readBrainDocIndex(ex()),
    readChunkIndex: (paths) => readBrainChunkIndex(paths, ex()),
    upsertDocs: (docs) => upsertBrainDocs(docs, ex()),
    upsertChunks: (chunks) => upsertBrainChunks(chunks, ex()),
    deleteChunks: (chunkIds) => deleteBrainChunks(chunkIds, ex()),
    deleteDocs: (paths) => deleteBrainDocs(paths, ex()),
    listChunksForEmbedding: (criteria) => listBrainChunksForEmbedding(criteria, ex()),
    writeEmbeddings: (writes) => writeBrainEmbeddings(writes, ex()),
  };
}
