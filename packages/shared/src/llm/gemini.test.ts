/**
 * The Gemini embedder, without a network.
 *
 * embed.ts states the invariant this file has to hold up: **never write a
 * vector we are not certain about.** A truncated, padded, mis-ordered or
 * wrong-model vector is not a degraded result, it is a silent one — plausible
 * retrieval forever, with the symptom pointing nowhere near the cause. So every
 * case below is about refusing rather than about succeeding.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  GEMINI_EMBED_DIMENSIONS,
  TASK_DOCUMENT,
  TASK_QUERY,
  createGeminiEmbedder,
  normalize,
} from './gemini.js';

const vector = (n = GEMINI_EMBED_DIMENSIONS, fill = 0.5): number[] => Array.from({ length: n }, () => fill);

/** Records the request body, because what we SEND is most of the contract. */
function respondWith(body: unknown, status = 200) {
  const sent: string[] = [];
  const fn = vi.fn(async (_url: string, init: { body?: string }) => {
    if (init.body !== undefined) sent.push(init.body);
    return new Response(JSON.stringify(body), { status });
  });
  return Object.assign(fn, { sent });
}

const embedderWith = (fetchStub: ReturnType<typeof respondWith>, taskType?: string) =>
  createGeminiEmbedder({ apiKey: 'k', fetch: fetchStub as never, taskType });

describe('normalize', () => {
  it('makes a vector unit length', () => {
    const n = normalize([3, 4]);
    expect(Math.hypot(...n)).toBeCloseTo(1, 12);
  });

  it('leaves the zero vector alone rather than dividing by zero', () => {
    expect(normalize([0, 0])).toEqual([0, 0]);
  });
});

describe('createGeminiEmbedder', () => {
  it('asks for exactly the column width, and asks the API to do the truncation', async () => {
    const f = respondWith({ embeddings: [{ values: vector() }] });
    await embedderWith(f).embed(['hello']);

    const body = JSON.parse(String(f.sent[0])) as {
      requests: Array<{ outputDimensionality: number; taskType: string }>;
    };
    // Sent to the API, never sliced here: a slice of a non-Matryoshka model is
    // a silently wrong vector, and only the API knows which the model is.
    expect(body.requests[0]?.outputDimensionality).toBe(GEMINI_EMBED_DIMENSIONS);
    expect(body.requests[0]?.taskType).toBe(TASK_DOCUMENT);
  });

  it('embeds a query into the same space with the other task type', async () => {
    const f = respondWith({ embeddings: [{ values: vector() }] });
    await embedderWith(f, TASK_QUERY).embed(['hello']);

    const body = JSON.parse(String(f.sent[0])) as { requests: Array<{ taskType: string }> };
    expect(body.requests[0]?.taskType).toBe(TASK_QUERY);
  });

  it('returns unit vectors — a Matryoshka prefix of a unit vector is not one', async () => {
    const f = respondWith({ embeddings: [{ values: vector() }] });
    const [v] = await embedderWith(f).embed(['hello']);

    expect(v).toHaveLength(GEMINI_EMBED_DIMENSIONS);
    expect(Math.hypot(...(v ?? []))).toBeCloseTo(1, 10);
  });

  it('REFUSES a short response rather than pairing vectors with the wrong chunks', async () => {
    // `embedPending` zips by index. A short response does not degrade
    // retrieval; it attaches the wrong vector to the right chunk, forever.
    const f = respondWith({ embeddings: [{ values: vector() }] });
    await expect(embedderWith(f).embed(['a', 'b'])).rejects.toThrow(/refusing the batch/);
  });

  it('refuses a vector of the wrong width', async () => {
    const f = respondWith({ embeddings: [{ values: vector(768) }] });
    await expect(embedderWith(f).embed(['a'])).rejects.toThrow(/768 dimensions, expected 1024/);
  });

  it('surfaces the API error rather than an empty result', async () => {
    const f = respondWith({ error: { message: 'API key not valid' } }, 400);
    await expect(embedderWith(f).embed(['a'])).rejects.toThrow(/API key not valid/);
  });

  it('does not call the API for an empty batch', async () => {
    const f = respondWith({});
    await expect(embedderWith(f).embed([])).resolves.toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('declares the width the column expects', () => {
    // `halfvec(1024)` in migration 008. Changing one requires changing both.
    expect(embedderWith(respondWith({})).dimensions).toBe(1024);
  });
});
