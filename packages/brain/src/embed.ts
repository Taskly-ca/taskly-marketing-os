/**
 * Versioned, batched, diff-driven embedding of the Brain index.
 *
 * No provider SDK is imported and none may be: the embedder arrives as a PORT,
 * which is what keeps the budget chokepoint in `@tmos/shared/llm` the only place
 * a call can be made from, and what makes every test in this package
 * deterministic and keyless.
 *
 * The module has one job and one invariant. The job: embed the chunks that need
 * it and nothing else. The invariant: **never write a vector we are not certain
 * about.** A truncated, padded, mis-ordered or wrong-model vector is not a
 * degraded result — it is a silent one. It produces plausible-looking retrieval
 * forever, and the symptom ("the corpus got worse") points nowhere near the
 * cause. So a batch is validated whole and written whole, or discarded whole.
 */
import type { BrainStorePort, EmbeddingWrite, StoredChunk } from './ingest.js';

/** The entire surface we need from an embedding model — deliberately narrow. */
export interface EmbedderPort {
  /** Recorded per chunk, so a model swap is a queryable migration. */
  readonly model: string;
  readonly version: string;
  /** Must match the column width: `halfvec(1024)` in migration 008. */
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Chunks per provider request.
 *
 * Two forces. Upward: a 4,000-chunk corpus is 63 requests at 64 and 4,000 at 1,
 * and per-request latency dominates. Downward: a failed batch loses the whole
 * batch's work, and providers cap a request by TOKENS as well as by count —
 * Brain chunks are prose sections of roughly 200–800 tokens, so 64 lands near
 * 50k tokens, comfortably inside the ~100k budget typical of embedding
 * endpoints, while 256 would not be. 64 is the largest round number that is
 * safe on both axes; lower it for a long-chunk corpus, never raise it blind.
 */
export const DEFAULT_EMBED_BATCH = 64;

/**
 * What actually goes to the model: the heading path, then the body.
 *
 * A section's text alone loses where it came from — "two roles, not three" is
 * unanchored, while "SYSTEM.md › Roles" pins it. Cheap, and it is the difference
 * between retrieving a section and retrieving a sentence.
 */
export function embedInput(chunk: Pick<StoredChunk, 'heading' | 'text'>): string {
  const heading = chunk.heading.trim();
  return heading === '' ? chunk.text : `${heading}\n\n${chunk.text}`;
}

/**
 * Does this chunk need a (re-)embed against this embedder?
 *
 * The model/version comparison is the load-bearing part. Vectors from different
 * models are not comparable at all, and mixing them in one index does not fail —
 * it quietly returns worse neighbours. Making a model change re-embed the corpus
 * is the only way that stays a migration instead of a mystery.
 */
export function needsEmbedding(
  chunk: Pick<StoredChunk, 'embedding' | 'embedModel' | 'embedVersion'>,
  embedder: Pick<EmbedderPort, 'model' | 'version' | 'dimensions'>,
): boolean {
  if (!chunk.embedding) return true;
  if (chunk.embedModel !== embedder.model) return true;
  if (chunk.embedVersion !== embedder.version) return true;
  // A stored vector of a different width cannot be compared with a new one, and
  // a mixed-width index is a recall hole nothing reports.
  return chunk.embedding.length !== embedder.dimensions;
}

export type EmbedFailure =
  'provider_error' | 'vector_count_mismatch' | 'bad_vector' | 'store_failed';

export interface BatchFailure {
  chunkIds: string[];
  reason: EmbedFailure;
  detail: string;
}

export interface EmbedReport {
  model: string;
  version: string;
  embedded: number;
  failed: number;
  /** Candidates already carrying a current vector — a store that over-returns. */
  skipped: number;
  /** Pending work left for the next run by `max`. Not a failure. */
  deferred: number;
  batches: number;
  failures: BatchFailure[];
}

export type EmbedResult =
  | { ok: true; report: EmbedReport }
  | { ok: false; reason: 'store_failed' | 'bad_options'; detail: string };

export interface EmbedOptions {
  /** Injected — no `Date.now()` in library code. */
  now: () => Date;
  batchSize?: number;
  /** Cap on chunks per run, so a full re-embed drains across runs instead of
   *  becoming one unbounded job. */
  max?: number;
}

const detailOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Embed everything that needs it.
 *
 * Failure semantics mirror the collector contract: `ok: false` means we do not
 * know the state of the work (we could not even list it), while `ok: true` with
 * `failed > 0` means the run happened and some batches did not. Those are
 * different alerts, and collapsing them is how a broken provider looks like a
 * quiet one.
 */
export async function embedPending(
  store: BrainStorePort,
  embedder: EmbedderPort,
  opts: EmbedOptions,
): Promise<EmbedResult> {
  const batchSize = opts.batchSize ?? DEFAULT_EMBED_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    return { ok: false, reason: 'bad_options', detail: `batchSize must be >= 1, got ${batchSize}` };
  }
  if (!Number.isInteger(embedder.dimensions) || embedder.dimensions < 1) {
    return {
      ok: false,
      reason: 'bad_options',
      detail: `embedder.dimensions must be >= 1, got ${embedder.dimensions}`,
    };
  }

  let candidates: StoredChunk[];
  try {
    candidates = await store.listChunksForEmbedding({
      model: embedder.model,
      version: embedder.version,
    });
  } catch (e) {
    return { ok: false, reason: 'store_failed', detail: `listChunksForEmbedding: ${detailOf(e)}` };
  }

  // The store's filter is an optimisation; this is the correctness boundary. An
  // adapter that over-returns costs a `skipped` count, never a wasted call.
  const pending = candidates
    .filter((c) => needsEmbedding(c, embedder))
    .sort((a, b) => a.path.localeCompare(b.path) || a.ordinal - b.ordinal);
  const work = opts.max === undefined ? pending : pending.slice(0, Math.max(0, opts.max));

  const report: EmbedReport = {
    model: embedder.model,
    version: embedder.version,
    embedded: 0,
    failed: 0,
    skipped: candidates.length - pending.length,
    deferred: pending.length - work.length,
    batches: 0,
    failures: [],
  };

  for (let i = 0; i < work.length; i += batchSize) {
    const batch = work.slice(i, i + batchSize);
    const chunkIds = batch.map((c) => c.chunkId);
    report.batches++;

    let vectors: number[][];
    try {
      vectors = await embedder.embed(batch.map(embedInput));
    } catch (e) {
      report.failed += batch.length;
      report.failures.push({ chunkIds, reason: 'provider_error', detail: detailOf(e) });
      continue;
    }

    // Validate the batch BEFORE writing any of it. A short response means the
    // text→vector mapping is gone; writing the vectors we did get would attach
    // them to the wrong chunks, and nothing downstream could ever detect it.
    const bad = validateBatch(vectors, batch.length, embedder.dimensions);
    if (bad) {
      report.failed += batch.length;
      report.failures.push({ chunkIds, ...bad });
      continue;
    }

    const embeddedAt = opts.now().toISOString();
    const writes: EmbeddingWrite[] = [];
    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const vector = vectors[j];
      if (!chunk || !vector) continue; // unreachable past validateBatch
      writes.push({
        chunkId: chunk.chunkId,
        embedding: vector,
        model: embedder.model,
        version: embedder.version,
        embeddedAt,
      });
    }

    try {
      await store.writeEmbeddings(writes);
      report.embedded += writes.length;
    } catch (e) {
      report.failed += batch.length;
      report.failures.push({ chunkIds, reason: 'store_failed', detail: detailOf(e) });
    }
  }

  return { ok: true, report };
}

function validateBatch(
  vectors: number[][],
  expected: number,
  dimensions: number,
): { reason: EmbedFailure; detail: string } | null {
  if (vectors.length !== expected) {
    return {
      reason: 'vector_count_mismatch',
      detail: `provider returned ${vectors.length} vectors for ${expected} texts`,
    };
  }
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!v) return { reason: 'bad_vector', detail: `vector ${i} is missing` };
    if (v.length !== dimensions) {
      return {
        reason: 'bad_vector',
        detail: `vector ${i} has ${v.length} dimensions, expected ${dimensions}`,
      };
    }
    for (let j = 0; j < v.length; j++) {
      const x = v[j];
      if (typeof x !== 'number' || !Number.isFinite(x)) {
        return {
          reason: 'bad_vector',
          detail: `vector ${i} component ${j} is not a finite number`,
        };
      }
    }
  }
  return null;
}
