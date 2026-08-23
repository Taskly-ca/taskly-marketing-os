/**
 * Gemini embeddings — the one thing Groq cannot do.
 *
 * `brain_chunk.embedding` is `halfvec(1024)` and `EmbedderPort.dimensions` must
 * equal it. Groq serves no embedding endpoint at all, which has blocked brain
 * retrieval and vector entity resolution since Part 3 and is recorded in the
 * build tracker as needing "either a Gemini key or a local 1024-dim model".
 *
 * `gemini-embedding-001` is natively 3072 and supports **Matryoshka**
 * representation learning: the model is trained so that the first N dimensions
 * of its output are themselves a usable embedding, so asking for 1024 is a
 * supported output size and not a truncation we invented. That distinction is
 * the whole reason this file can exist without violating embed.ts's invariant —
 * "never write a vector we are not certain about" — and it is why
 * `outputDimensionality` is sent to the API rather than the vector being sliced
 * here. A slice of a non-MRL model is a silently wrong vector.
 *
 * NORMALISE AFTER TRUNCATION, AND ONLY THEN. Google's own guidance: the full
 * 3072-dim output is unit-normalised, and a Matryoshka prefix of a unit vector
 * is NOT unit-length. The index is `halfvec_cosine_ops`, so an unnormalised
 * vector still ranks correctly — cosine ignores magnitude — but any later
 * switch to inner product or L2, and any client that compares dot products,
 * silently ranks by length instead of by similarity. Normalising costs one pass
 * and removes a whole class of future wrongness.
 *
 * NO BUDGET CHOKEPOINT, ON PURPOSE — and this is the one place in the repo that
 * is true, so it needs stating. `shared/llm`'s ceilings are token- and
 * dollar-denominated against a chat completion; embeddings are a different unit
 * on a different price list, and running them through `BudgetState` would
 * charge them against a ceiling calibrated for reasoning calls. What guards
 * this instead is structural: `embedPending` only ever embeds chunks whose
 * content hash changed, so the steady-state cost of a corpus that is not being
 * edited is zero.
 */

const ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';

/** Matches `halfvec(1024)` in migration 008. Changing one requires changing both. */
export const GEMINI_EMBED_DIMENSIONS = 1024;

export const GEMINI_EMBED_MODEL = 'models/gemini-embedding-001';

/**
 * Pinned, and recorded per chunk so a model swap is a queryable migration
 * rather than a corpus with two incompatible vector spaces in it and no way to
 * tell which chunk is which.
 */
export const GEMINI_EMBED_VERSION = '001@1024';

/**
 * `RETRIEVAL_DOCUMENT` for the corpus.
 *
 * Gemini's asymmetric task types embed a document and a query into the same
 * space but with different instructions, and a corpus embedded as
 * `RETRIEVAL_QUERY` retrieves measurably worse. The distinction only matters if
 * both sides agree, so the query side is named here too rather than left to
 * whoever writes the search call.
 */
export const TASK_DOCUMENT = 'RETRIEVAL_DOCUMENT';
export const TASK_QUERY = 'RETRIEVAL_QUERY';

export interface GeminiEmbedOptions {
  readonly apiKey: string;
  /** `RETRIEVAL_DOCUMENT` when indexing, `RETRIEVAL_QUERY` when searching. */
  readonly taskType?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
}

interface BatchResponse {
  embeddings?: Array<{ values?: number[] }>;
  error?: { message?: string };
}

/** Unit-length, or the zero vector unchanged — dividing by zero is not a fix. */
export function normalize(vector: readonly number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return [...vector];
  return vector.map((v) => v / norm);
}

export interface GeminiEmbedder {
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export function createGeminiEmbedder(options: GeminiEmbedOptions): GeminiEmbedder {
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? ENDPOINT;
  const taskType = options.taskType ?? TASK_DOCUMENT;

  return {
    model: GEMINI_EMBED_MODEL,
    version: GEMINI_EMBED_VERSION,
    dimensions: GEMINI_EMBED_DIMENSIONS,

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const res = await doFetch(`${endpoint}?key=${encodeURIComponent(options.apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: GEMINI_EMBED_MODEL,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: GEMINI_EMBED_DIMENSIONS,
          })),
        }),
      });

      const body = (await res.json()) as BatchResponse;
      if (!res.ok) {
        throw new Error(`gemini embed failed: http ${res.status} ${body.error?.message ?? ''}`.trim());
      }

      const raw = body.embeddings ?? [];
      /**
       * COUNT AND ORDER ARE THE CONTRACT. `batchEmbedContents` answers in
       * request order, and `embedPending` zips the result against its batch by
       * INDEX — so a short or reordered response does not degrade retrieval, it
       * attaches the wrong vector to the right chunk, forever, invisibly.
       * Refusing the batch is the only safe answer, and embed.ts is built for
       * it: a batch is validated whole and written whole, or discarded whole.
       */
      if (raw.length !== texts.length) {
        throw new Error(
          `gemini returned ${raw.length} embeddings for ${texts.length} inputs — refusing the ` +
            'batch rather than pairing vectors with the wrong chunks',
        );
      }

      return raw.map((e, i) => {
        const values = e.values ?? [];
        if (values.length !== GEMINI_EMBED_DIMENSIONS) {
          throw new Error(
            `gemini vector ${i} has ${values.length} dimensions, expected ${GEMINI_EMBED_DIMENSIONS}`,
          );
        }
        // Truncated by the API via outputDimensionality; a Matryoshka prefix of
        // a unit vector is not unit-length, so this is where it becomes one.
        return normalize(values);
      });
    },
  };
}
