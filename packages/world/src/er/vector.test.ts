import { describe, it, expect } from 'vitest';
import { normalizeName } from '../identity.js';
import { blockCandidates, trigramSimilarity } from './blocking.js';
import type { ErRecord } from './blocking.js';
import { VECTOR_THRESHOLD, cosineSimilarity, embeddingText, vectorCandidates } from './vector.js';
import type { EmbeddingPort } from './vector.js';

const rec = (id: string, raw: string, region?: string): ErRecord => ({
  id,
  name: normalizeName(raw),
  region: region ?? null,
});

/**
 * Deterministic stand-in for an embedding model. A lookup table for the pairs
 * the tests reason about, and a reproducible character-histogram fallback for
 * everything else — no keys, no network, no randomness.
 */
const TABLE: Record<string, number[]> = {
  'gta snow clearing | toronto': [0.9, 0.42, 0.1, 0.0],
  'greater toronto snow removal | toronto': [0.88, 0.46, 0.12, 0.0],
  'toronto plumbing | toronto': [0.1, 0.2, 0.95, 0.0],
  'maple leaf cleaning | toronto': [0.0, 0.0, 0.0, 1.0],
};

const fallback = (text: string): number[] => {
  const v = [0, 0, 0, 0];
  for (let i = 0; i < text.length; i++) {
    const idx = text.charCodeAt(i) % 4;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  return v;
};

const fakePort = (): EmbeddingPort & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((t) => TABLE[t] ?? fallback(t));
    },
  };
};

describe('cosineSimilarity', () => {
  it('is 1 for identical direction and -1 for opposite', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([2, 4, 6], [1, 2, 3])).toBeCloseTo(1, 12);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
  });

  it('returns 0 for a zero-magnitude vector instead of dividing by zero', () => {
    // NaN would sort unpredictably and compare false against every threshold,
    // so the failure would look like "no candidates" rather than an error.
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    expect(Number.isNaN(cosineSimilarity([0, 0], [0, 0]))).toBe(false);
  });

  it('throws on a dimension mismatch', () => {
    // Mixed models in one pool. A number computed across that is meaningless,
    // and a meaningless number that merges entities is worse than a crash.
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dimension mismatch/);
  });
});

describe('embeddingText', () => {
  it('embeds the normalized name and region only — never raw scraped text', () => {
    expect(embeddingText(rec('a', 'Jiffy On Demand Inc.', 'Toronto'))).toBe(
      'jiffy on demand | toronto',
    );
    expect(embeddingText(rec('b', 'Jiffy On Demand Inc.'))).toBe('jiffy on demand');
  });
});

describe('vectorCandidates is a SECOND blocker', () => {
  const pool = [
    rec('v1', 'GTA Snow Clearing', 'toronto'),
    rec('v2', 'Greater Toronto Snow Removal', 'toronto'),
    rec('v3', 'Toronto Plumbing', 'toronto'),
    rec('v4', 'Maple Leaf Cleaning', 'toronto'),
  ];
  const target = pool[0] as ErRecord;

  it('catches the abbreviation pair that trigram blocking cannot see', () => {
    // Character overlap between these two names is 0.146 — below any usable
    // block threshold. Trigrams are structurally blind to abbreviation.
    expect(trigramSimilarity('gta snow clearing', 'greater toronto snow removal')).toBeLessThan(
      0.25,
    );
    expect(blockCandidates(target, pool).map((c) => c.id)).not.toContain('v2');
  });

  it('proposes it as a candidate and nothing more', async () => {
    const port = fakePort();
    const out = await vectorCandidates(target, pool, port);
    expect(out.map((c) => c.id)).toEqual(['v2']);
    // Candidates only: no score, no band, nothing thresholdable as a decision.
    expect(Object.keys(out[0] ?? {}).sort()).toEqual(['id', 'similarity', 'via']);
    expect(out[0]?.via).toBe('vector');
    expect(out[0]?.similarity).toBeGreaterThanOrEqual(VECTOR_THRESHOLD);
  });

  it('excludes pairs the first blocker already found', async () => {
    const port = fakePort();
    const out = await vectorCandidates(target, pool, port, {
      exclude: new Set(['v2']),
    });
    expect(out).toEqual([]);
    // Excluded records are not even embedded — the cost saving is the point.
    expect(port.calls[0]).not.toContain('greater toronto snow removal | toronto');
  });

  it('never returns the target itself', async () => {
    const out = await vectorCandidates(target, pool, fakePort(), { threshold: -1 });
    expect(out.map((c) => c.id)).not.toContain('v1');
  });

  it('batches into ONE embed call, target first, in a stable order', async () => {
    const port = fakePort();
    await vectorCandidates(target, pool, port);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toEqual([
      'gta snow clearing | toronto',
      'greater toronto snow removal | toronto',
      'toronto plumbing | toronto',
      'maple leaf cleaning | toronto',
    ]);
  });

  it('sorts best-first and honours a limit', async () => {
    const out = await vectorCandidates(target, pool, fakePort(), { threshold: -1 });
    for (let i = 1; i < out.length; i++) {
      expect((out[i - 1] as { similarity: number }).similarity).toBeGreaterThanOrEqual(
        (out[i] as { similarity: number }).similarity,
      );
    }
    expect(
      await vectorCandidates(target, pool, fakePort(), { threshold: -1, limit: 2 }),
    ).toHaveLength(2);
  });

  it('skips exact-only names — a protected brand is not a vector problem either', async () => {
    const brands = [rec('b1', '3M', 'toronto'), rec('b2', '3M Innovations', 'toronto')];
    const port = fakePort();
    expect(await vectorCandidates(brands[0] as ErRecord, brands, port, { threshold: -1 })).toEqual(
      [],
    );
    expect(port.calls).toHaveLength(0);
  });

  it('does not call the port when there is nothing left to compare', async () => {
    const port = fakePort();
    expect(await vectorCandidates(target, [target], port)).toEqual([]);
    expect(port.calls).toHaveLength(0);
  });

  it('throws when the port returns the wrong number of vectors', async () => {
    const broken: EmbeddingPort = {
      async embed() {
        return [[1, 0, 0, 0]];
      },
    };
    await expect(vectorCandidates(target, pool, broken)).rejects.toThrow(/returned 1 vectors/);
  });

  it('surfaces a dimension mismatch from a mixed-model pool', async () => {
    const mixed: EmbeddingPort = {
      async embed(texts) {
        return texts.map((_t, i) => (i === 0 ? [1, 0, 0, 0] : [1, 0]));
      },
    };
    await expect(vectorCandidates(target, pool, mixed)).rejects.toThrow(/dimension mismatch/);
  });

  it('cannot rescue a same-trade neighbour — similarity is not identity', async () => {
    // "Toronto Plumbing" is a different company, and no threshold fixes that:
    // the representation measures topical similarity, not identity. This test
    // exists to record the limitation, not to celebrate a pass.
    const out = await vectorCandidates(target, pool, fakePort(), { threshold: -1 });
    const plumbing = out.find((c) => c.id === 'v3');
    expect(plumbing).toBeDefined();
    expect(plumbing?.similarity).toBeLessThan(VECTOR_THRESHOLD);
  });
});
