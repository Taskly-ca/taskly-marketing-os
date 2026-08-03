import { describe, it, expect } from 'vitest';
import { createMemoryStore, PredictionRejected } from './store.js';
import { writePrediction } from './write.js';
import { runDueResolvers } from './runner.js';
import type { ResolverContext, ResolverSpec } from '../resolver/types.js';

const goodResolver: ResolverSpec = {
  kind: 'http_json',
  spec: 'data.category_count > 40',
  source_url: 'https://example.test/api/categories',
  fallback: 'annul',
};

const ctxWith = (count: number): ResolverContext => ({
  fetchJson: async () => ({ data: { category_count: count } }),
});

const base = {
  claim: "Jiffy's Toronto category count exceeds 40 by 2026-11-01",
  p: 0.35,
  author: 'human:nishant',
  resolve_at: '2026-11-01T00:00:00.000Z',
  resolver: goodResolver,
  evidence: { snapshot: 'categories page as of 2026-08-03', count: 31 },
  now: new Date('2026-08-03T00:00:00.000Z'),
};

describe('prediction write path', () => {
  it('accepts a prediction whose resolver dry-runs', async () => {
    const store = createMemoryStore();
    const rec = await writePrediction(store, base, ctxWith(31));
    expect(rec.outcome).toBeNull();
    expect(rec.evidence_snapshot_hash).toHaveLength(64);
  });

  it('REJECTS a prediction whose resolver cannot dry-run — the core gate', async () => {
    const store = createMemoryStore();
    await expect(
      writePrediction(store, base, { fetchJson: async () => ({ data: {} }) }), // path missing
    ).rejects.toThrow(/not machine-scoreable/);
    expect(await store.all()).toHaveLength(0); // nothing was written
  });

  it('REJECTS a vague claim that names no threshold', async () => {
    const store = createMemoryStore();
    await expect(
      writePrediction(store, { ...base, claim: 'traction' }, ctxWith(31)),
    ).rejects.toBeInstanceOf(PredictionRejected);
  });

  it('REJECTS p at 0 or 1 — a log score of a certainty is infinite', async () => {
    const store = createMemoryStore();
    await expect(writePrediction(store, { ...base, p: 1 }, ctxWith(31))).rejects.toThrow(
      /p must be/,
    );
    await expect(writePrediction(store, { ...base, p: 0 }, ctxWith(31))).rejects.toThrow(
      /p must be/,
    );
  });

  it('REJECTS an untagged author — humans and agents must be scored apart', async () => {
    const store = createMemoryStore();
    await expect(
      writePrediction(store, { ...base, author: 'nishant' }, ctxWith(31)),
    ).rejects.toThrow(/human:<id> or agent:/);
  });

  it('freezes the evidence snapshot: same evidence hashes equal, different differs', async () => {
    const store = createMemoryStore();
    const a = await writePrediction(store, base, ctxWith(31));
    const b = await writePrediction(store, { ...base, id: 'x' }, ctxWith(31));
    const c = await writePrediction(
      store,
      { ...base, id: 'y', evidence: { snapshot: 'different' } },
      ctxWith(31),
    );
    expect(a.evidence_snapshot_hash).toBe(b.evidence_snapshot_hash);
    expect(a.evidence_snapshot_hash).not.toBe(c.evidence_snapshot_hash);
  });
});

describe('resolution runner', () => {
  it('resolves a due prediction to 1 when the threshold is met', async () => {
    const store = createMemoryStore();
    await writePrediction(store, base, ctxWith(31));
    const s = await runDueResolvers(store, ctxWith(45), new Date('2026-11-02T00:00:00.000Z'));
    expect(s.resolved).toBe(1);
    expect((await store.all())[0]!.outcome).toBe(1);
  });

  it('ANNULS rather than guessing when the source is unreachable', async () => {
    const store = createMemoryStore();
    await writePrediction(store, base, ctxWith(31));
    const s = await runDueResolvers(
      store,
      {
        fetchJson: async () => {
          throw new Error('502');
        },
      },
      new Date('2026-11-02T00:00:00.000Z'),
    );
    expect(s.annulled).toBe(1);
    const row = (await store.all())[0]!;
    expect(row.outcome).toBe('annulled');
    expect(row.annul_reason).toContain('fetch failed');
  });

  it('does not touch predictions that are not yet due', async () => {
    const store = createMemoryStore();
    await writePrediction(store, base, ctxWith(31));
    const s = await runDueResolvers(store, ctxWith(45), new Date('2026-09-01T00:00:00.000Z'));
    expect(s.scanned).toBe(0);
  });

  it('is idempotent — a second run does not re-resolve', async () => {
    const store = createMemoryStore();
    await writePrediction(store, base, ctxWith(31));
    const when = new Date('2026-11-02T00:00:00.000Z');
    await runDueResolvers(store, ctxWith(45), when);
    const second = await runDueResolvers(store, ctxWith(10), when);
    expect(second.scanned).toBe(0);
    expect((await store.all())[0]!.outcome).toBe(1);
  });
});
