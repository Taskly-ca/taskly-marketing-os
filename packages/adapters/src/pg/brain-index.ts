/**
 * `BrainIndexPort` (packages/brain/src/retrieve.ts) as a read over
 * `brain_chunk join brain_doc` — migration 008.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO DO, and it is the whole design:
 *
 *   IT DOES NOT ENFORCE THE TRUST LADDER. `retrieve()` does, in TypeScript, on
 *   whatever the port returned — its own test seeds a port that ranks a
 *   superseded document FIRST and proves the ladder still drops it, with the
 *   comment "the port may be a naive select and a defence that depends on the
 *   caller is not a defence". Moving that guarantee into SQL would delete the
 *   defence and leave the appearance of one.
 *
 *   IT DOES NOT HIDE DRAFTS. `draft` is `context_only`: it may inform phrasing
 *   and may never ground a claim, and the second half of that sentence is
 *   `groundingSet` / `mayGroundFact`'s job. A `where status <> 'draft'` here
 *   would silently delete the first half.
 *
 * What it DOES filter is `superseded`, because that is the one rung whose rows
 * are not merely demoted but absent — 008 declares `brain_doc_retrievable_idx
 * ... where status <> 'superseded'` to serve exactly this predicate, and
 * `ingestSnapshot` already refuses to store chunks for such a document. Belt and
 * braces on a rung the schema, the ingest and the ladder all agree about; the
 * ladder is still the thing that guarantees it.
 *
 * The port is READ-ONLY on purpose (the write side is `BrainStorePort`), so
 * nothing in here issues anything but a select.
 */
import { db, sql, type Executor, type QueryRow, type SqlQuery } from '@tmos/db';
import type { BrainIndexCandidate, BrainIndexPort, BrainDocMeta, BrainQuery } from '@tmos/brain';
import { brainStatusSchema, brainTypeSchema } from '@tmos/contracts';
import type { BrainChunk } from '@tmos/contracts';

import { AdapterError, guard } from '../errors.js';
// `formatHalfvec` lives on the write side because the literal format is a
// property of the COLUMN, not of a direction of travel. One encoder, one place.
import { formatHalfvec } from './brain-store.js';
import { asNumber, asStringArray, asText, asTextOrNull, asUnion } from './values.js';

/**
 * `reviewed` is a `date` and is read as `to_char(...)`, NOT as a Date.
 *
 * `BrainDoc.reviewed` is the string `YYYY-MM-DD` and the driver hands a `date`
 * back as a JavaScript `Date` at LOCAL midnight — `toISOString()` on which
 * returns the previous day for every timezone west of UTC. A document reviewed
 * on the 1st would go stale a day early, silently, and only in some deployments.
 *
 * `text` is a column name in 008, so it is quoted everywhere.
 */
const CANDIDATE_COLUMNS = sql`
  c.chunk_id, c.ordinal, c.heading, c."text", c.chunk_sha,
  d.path, d.title, d.type, d.status,
  to_char(d.reviewed, 'YYYY-MM-DD') as reviewed,
  d.caveats, d.verify, d.superseded_by, d.doc_sha`;

/** Both stores raise this; the conformance suite matches on the message. */
export const NO_QUERY_MESSAGE =
  'search: a BrainQuery needs a vector or text — a search with neither is not a search, and ' +
  'returning the first rows in the table would look exactly like a working one';

export function rowToBrainCandidate(row: QueryRow): BrainIndexCandidate {
  const path = asText(row.path, 'brain_doc.path');
  const at = (column: string): string => `brain_doc[${path}].${column}`;

  const doc: BrainDocMeta = {
    path,
    title: asText(row.title, at('title')),
    type: asUnion(row.type, brainTypeSchema.options, at('type')),
    status: asUnion(row.status, brainStatusSchema.options, at('status')),
    reviewed: asTextOrNull(row.reviewed, at('reviewed')),
    caveats: asStringArray(row.caveats, at('caveats')),
    verify: asStringArray(row.verify, at('verify')),
    supersededBy: asStringArray(row.superseded_by, at('superseded_by')),
    docSha: asText(row.doc_sha, at('doc_sha')),
  };

  const chunkId = asText(row.chunk_id, at('chunk_id'));
  const chunkAt = (column: string): string => `brain_chunk[${chunkId}].${column}`;
  const chunk: BrainChunk = {
    chunkId,
    ordinal: asNumber(row.ordinal, chunkAt('ordinal')),
    heading: asText(row.heading, chunkAt('heading')),
    text: asText(row.text, chunkAt('text')),
    chunkSha: asText(row.chunk_sha, chunkAt('chunk_sha')),
  };

  return { chunk, doc, distance: asNumber(row.distance, chunkAt('distance')) };
}

/**
 * How the query is ranked, and which rows are eligible at all.
 *
 * VECTOR WINS WHEN BOTH ARE SUPPLIED. `BrainQuery` documents `text` as "the
 * fallback when embeddings are unavailable", and `distance` as "SMALLER is
 * closer, matching pgvector's `<=>`" — one number, one meaning. A hybrid score
 * (RRF, or a weighted blend) is neither a cosine distance nor comparable across
 * two queries, so writing one into that field would make the contract's own
 * sentence false while still returning plausible numbers. Precedence is
 * documented and tested instead of blended and hoped for.
 *
 * NEITHER IS REFUSED. Returning "the first `limit` rows" for an empty query is
 * indistinguishable, from the caller's side, from a search that worked.
 */
function rankingFor(query: BrainQuery): { distance: SqlQuery; eligible: SqlQuery } {
  if (query.vector !== undefined) {
    // Length is checked before the statement is built: `::halfvec(1024)` on a
    // 512-wide literal raises 22000, and a raised exception aborts the caller's
    // whole transaction. Same class either way, just earlier.
    const literal = formatHalfvec(query.vector, 'search.vector');
    return {
      // `<=>` is cosine distance, which is what `brain_chunk_embedding_idx`
      // (hnsw ... halfvec_cosine_ops) is built for. Any other operator here
      // silently drops to a sequential scan over the corpus.
      distance: sql`c.embedding <=> ${literal}::halfvec(1024)`,
      // An unembedded chunk has no distance at all: `null <=> v` is null, which
      // sorts LAST in an ascending order rather than raising, so it would arrive
      // as a candidate with a null distance and fail decoding. A VECTOR SEARCH
      // THEREFORE SEES ONLY THE EMBEDDED PART OF THE CORPUS — mid-backfill that
      // is a smaller corpus, not an error, and nothing reports it.
      eligible: sql`c.embedding is not null`,
    };
  }

  if (query.text !== undefined) {
    // No index serves this: 008 has no GIN index over the chunk text, adding one
    // is a migration and migrations are a serial lane. It is a sequential scan
    // over a corpus of thousands of rows, which is survivable and honest, and it
    // is the FALLBACK path rather than the hot one.
    const tsv = sql`to_tsvector('english', c.heading || ' ' || c."text")`;
    // `websearch_to_tsquery` never raises on arbitrary input (`plainto_` does
    // not either, but this one honours quotes and `-`), so a user's question
    // goes in as typed. All-stopword input yields an empty query that matches
    // nothing, which is the truthful answer to "what matches 'the'".
    const tsq = sql`websearch_to_tsquery('english', ${query.text})`;
    return {
      // Normalisation flag 32 is `rank / (rank + 1)`, so the rank lands in
      // [0, 1) and `1 - rank` is a DISTANCE: smaller is closer, the direction
      // `BrainIndexCandidate` promises. It is NOT commensurable with a cosine
      // distance — never mix the two in one ranked list.
      distance: sql`1 - ts_rank_cd(${tsv}, ${tsq}, 32)`,
      eligible: sql`${tsv} @@ ${tsq}`,
    };
  }

  throw new AdapterError(NO_QUERY_MESSAGE);
}

export async function searchBrainIndex(
  query: BrainQuery,
  ex: Executor = db(),
): Promise<BrainIndexCandidate[]> {
  const { distance, eligible } = rankingFor(query);
  // `limit` is a candidate budget from a caller, not a column: a negative or
  // fractional one is a type error in Postgres rather than a smaller result.
  const limit = Math.max(0, Math.trunc(query.limit));

  return guard('search', async () => {
    const rows = await ex.query(sql`
      select ${CANDIDATE_COLUMNS}, ${distance} as distance
        from brain_chunk c
        join brain_doc d on d.path = c.path
       where d.status <> 'superseded'
         and ${eligible}
       order by distance, d.path, c.ordinal
       limit ${limit}`);
    return rows.map(rowToBrainCandidate);
  });
}

/**
 * The port, bound to an executor. Resolved PER CALL, never captured in a default
 * argument — see `createPostgresBrainStore`.
 */
export function createPostgresBrainIndex(executor?: Executor): BrainIndexPort {
  const ex = (): Executor => executor ?? db();

  return { search: (query) => searchBrainIndex(query, ex()) };
}
