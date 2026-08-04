/**
 * The embedding blocker — a SECOND blocker, never a replacement and never a
 * decider.
 *
 * It runs on the pairs trigram blocking MISSED. Trigrams are character overlap,
 * so they are blind to anything that shares meaning without sharing letters:
 * abbreviations (`GTA Snow Clearing` / `Greater Toronto Snow Removal`),
 * translations and transliterations (`Ménage Total` / `Total Cleaning`,
 * `Sharma Plumbing` / `शर्मा प्लम्बिंग`). Those pairs are invisible to
 * `pg_trgm` at any threshold, and a pair that is never blocked can never be
 * matched.
 *
 * Three hard constraints, in force everywhere in this file:
 *
 *  1. It only ever WIDENS the candidate set. Trigram output is never filtered,
 *     re-ranked or overridden by anything here.
 *  2. It never auto-merges. The return type carries no score and no band on
 *     purpose — a caller cannot accidentally treat a cosine number as a
 *     decision, because there is nothing here to compare against a threshold.
 *  3. Embedding similarity conflates "similar business" with "same business".
 *     Two DIFFERENT plumbers in Toronto embed almost identically: same trade,
 *     same city, same phrasing. That is not a tuning problem to be solved with
 *     a higher threshold — it is what the representation measures. So this
 *     stage proposes; `scorePair` and the adjudicator dispose.
 *
 * No provider SDK is imported. The port is injected, which is also what makes
 * the tests deterministic and keyless.
 */
import { mayFuzzyMatch } from '../identity.js';
import type { ErRecord } from './blocking.js';

/** The entire surface we need from an embedding model. Deliberately one method. */
export interface EmbeddingPort {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * What gets embedded: normalized name plus coarse region, and nothing else.
 *
 * Never raw scraped text. Two reasons — a scraped blurb is attacker-controlled
 * input on its way to a model, and free text drags the vector toward the page's
 * marketing language rather than the entity's identity.
 */
export function embeddingText(rec: ErRecord): string {
  const region = rec.region?.trim().toLowerCase() ?? '';
  return region ? `${rec.name.norm} | ${region}` : rec.name.norm;
}

/**
 * Cosine similarity, with the two failure modes that actually happen made
 * explicit rather than silently producing NaN.
 *
 * A zero-magnitude vector returns 0: it carries no direction, so "how aligned
 * is it" has no answer, and 0/0 would poison every comparison downstream with
 * NaN — which sorts unpredictably and compares false against every threshold.
 * A dimension mismatch throws, because it means two different models' outputs
 * got mixed in one pool, and a number computed across that is meaningless.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Cosine cutoff for the second pass.
 *
 * Model-dependent and NOT transferable: short business names inside one vertical
 * sit in a narrow, crowded region of the space, so the useful cutoff for a
 * general-purpose sentence encoder lands far higher than the 0.5-ish that feels
 * natural for prose. 0.82 is where a small hand-checked GTA sample separated
 * abbreviation variants from same-trade neighbours; it must be re-measured for
 * any other model, and `labels.ts` is where that measurement lives.
 *
 * Raising it costs recall in the one place recall cannot be recovered. Lowering
 * it only costs scoring passes. When unsure, lower it.
 */
export const VECTOR_THRESHOLD = 0.82;

/** Candidates only. No score, no band, nothing that resembles a decision. */
export interface VectorCandidate {
  id: string;
  similarity: number;
  via: 'vector';
}

export interface VectorOptions {
  threshold?: number;
  /** Cost cap. A cap trades away recall — leave it unset unless the pool is huge. */
  limit?: number;
  /** Ids trigram blocking already found. Re-proposing them is pure waste. */
  exclude?: ReadonlySet<string>;
}

/**
 * Candidates from the embedding space, best first, EXCLUDING everything the
 * first blocker already produced.
 *
 * One `embed` call for the target and the whole pool together, in a stable
 * order: batching is the difference between one request and N, and the fixed
 * order keeps the call reproducible for a cache key.
 *
 * Exact-only names (protected brand, too short) are skipped here as well —
 * `3M` and `3M Innovations` embed close, and this stage has even less to say
 * about that pair than trigrams did.
 */
export async function vectorCandidates(
  target: ErRecord,
  pool: readonly ErRecord[],
  port: EmbeddingPort,
  opts: VectorOptions = {},
): Promise<VectorCandidate[]> {
  const threshold = opts.threshold ?? VECTOR_THRESHOLD;
  const exclude = opts.exclude ?? new Set<string>();

  const considered = pool.filter(
    (r) => r.id !== target.id && !exclude.has(r.id) && mayFuzzyMatch(target.name, r.name),
  );
  if (considered.length === 0) return [];

  const texts = [embeddingText(target), ...considered.map(embeddingText)];
  const vectors = await port.embed(texts);
  if (vectors.length !== texts.length) {
    throw new Error(`embedding port returned ${vectors.length} vectors for ${texts.length} texts`);
  }
  const targetVec = vectors[0];
  if (!targetVec) throw new Error('embedding port returned no vector for the target');

  const out: VectorCandidate[] = [];
  for (let i = 0; i < considered.length; i++) {
    const rec = considered[i];
    const vec = vectors[i + 1];
    if (!rec || !vec) continue;
    const similarity = cosineSimilarity(targetVec, vec);
    if (similarity >= threshold) out.push({ id: rec.id, similarity, via: 'vector' });
  }
  out.sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return opts.limit === undefined ? out : out.slice(0, opts.limit);
}
