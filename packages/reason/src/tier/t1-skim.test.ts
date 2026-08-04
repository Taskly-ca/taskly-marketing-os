import { describe, it, expect } from 'vitest';
import {
  skimItems,
  createMemorySkimCache,
  skimCacheKey,
  DEFAULT_MATERIALITY_GATE,
  SKIM_BATCH_SIZE,
  SKIM_BODY_CHARS,
  SKIM_VERSION,
} from './t1-skim.js';
import type { SkimItem, SkimPort, SkimVerdict, SkimInput } from './t1-skim.js';

const item = (n: number, over: Partial<SkimItem> = {}): SkimItem => ({
  id: `sig-${n}`,
  contentHash: `hash-${n}`,
  title: `title ${n}`,
  body: `body ${n}`,
  ...over,
});

/** A port that records what it was asked and replays a scripted answer. */
const scriptedPort = (
  reply: (batch: readonly SkimInput[]) => readonly SkimVerdict[] | Promise<never>,
) => {
  const calls: Array<readonly SkimInput[]> = [];
  const port: SkimPort = {
    async skim(batch) {
      calls.push(batch);
      return reply(batch);
    },
  };
  return { port, calls };
};

/** The well-behaved model: every item comes back with a usable score. */
const goodPort = (score = 0.9) =>
  scriptedPort((batch) => batch.map((b) => ({ id: b.id, materiality: score, reason: 'ok' })));

const deps = (port: SkimPort) => ({ port, cache: createMemorySkimCache() });

describe('the gate', () => {
  it('stops an item scoring below the gate and passes one above it', async () => {
    const low = goodPort(0.1);
    const r1 = await skimItems([item(1)], deps(low.port));
    expect(r1.results[0]).toMatchObject({ proceed: false, materiality: 0.1 });

    const high = goodPort(0.8);
    const r2 = await skimItems([item(1)], deps(high.port));
    expect(r2.results[0]?.proceed).toBe(true);
  });

  it('accepts an override so the threshold can be tuned by outcome data', async () => {
    const { port } = goodPort(0.4);
    const r = await skimItems([item(1)], { ...deps(port), gate: 0.9 });
    expect(r.results[0]?.proceed).toBe(false);
    expect(DEFAULT_MATERIALITY_GATE).toBeGreaterThan(0);
    expect(DEFAULT_MATERIALITY_GATE).toBeLessThan(1);
  });
});

describe('caching — the same item never costs twice', () => {
  it('makes zero port calls on a repeated batch', async () => {
    const { port, calls } = goodPort();
    const cache = createMemorySkimCache();
    const batch = [item(1), item(2), item(3)];

    const first = await skimItems(batch, { port, cache });
    expect(first.portCalls).toBe(1);
    expect(first.results.every((r) => r.cached)).toBe(false);

    const second = await skimItems(batch, { port, cache });
    expect(second.portCalls).toBe(0);
    expect(calls).toHaveLength(1);
    expect(second.results.every((r) => r.cached)).toBe(true);
    expect(second.results.map((r) => r.materiality)).toEqual(
      first.results.map((r) => r.materiality),
    );
  });

  it('keys on content, not on item id — a repost is free', async () => {
    const { port, calls } = goodPort();
    const cache = createMemorySkimCache();
    await skimItems([item(1)], { port, cache });
    const repost = await skimItems([item(2, { contentHash: 'hash-1' })], { port, cache });
    expect(repost.portCalls).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('sends one copy of a hash even when a batch contains it twice', async () => {
    const { port, calls } = goodPort();
    const r = await skimItems([item(1), item(2, { contentHash: 'hash-1' })], deps(port));
    expect(calls[0]).toHaveLength(1);
    expect(r.results).toHaveLength(2);
    expect(r.results.every((x) => x.materiality === 0.9)).toBe(true);
  });

  it('scopes the key to the skim version, so a retired prompt is not replayed', async () => {
    const { port, calls } = goodPort();
    const cache = createMemorySkimCache();
    await skimItems([item(1)], { port, cache });
    await skimItems([item(1)], { port, cache, version: 'skim@next' });
    expect(calls).toHaveLength(2);
    expect(skimCacheKey('hash-1', SKIM_VERSION)).not.toBe(skimCacheKey('hash-1', 'skim@next'));
  });
});

describe('a malformed model response abstains — it never drops an item', () => {
  const malformed = async (verdicts: unknown[], code: string) => {
    const { port } = scriptedPort(() => verdicts as SkimVerdict[]);
    const r = await skimItems([item(1)], deps(port));
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ id: 'sig-1', abstained: true, abstainCode: code });
    // An abstention is "needs a look", so it always survives the gate.
    expect(r.results[0]?.proceed).toBe(true);
    return r;
  };

  it('abstains when the model returns fewer verdicts than inputs', async () => {
    const { port } = scriptedPort(() => []);
    const r = await skimItems([item(1), item(2)], deps(port));
    expect(r.results.map((x) => x.abstainCode)).toEqual(['missing_verdict', 'missing_verdict']);
    expect(r.results.every((x) => x.proceed)).toBe(true);
  });

  it('abstains the orphan and reports an unknown id rather than mapping it anywhere', async () => {
    const { port } = scriptedPort(() => [{ id: 'sig-999', materiality: 0.9, reason: 'x' }]);
    const r = await skimItems([item(1)], deps(port));
    expect(r.unknownIds).toEqual(['sig-999']);
    expect(r.results[0]).toMatchObject({ abstained: true, abstainCode: 'missing_verdict' });
  });

  it('abstains on NaN', () =>
    malformed([{ id: 'sig-1', materiality: NaN, reason: 'x' }], 'malformed_score'));
  it('abstains above 1', () =>
    malformed([{ id: 'sig-1', materiality: 1.4, reason: 'x' }], 'malformed_score'));
  it('abstains below 0', () =>
    malformed([{ id: 'sig-1', materiality: -0.2, reason: 'x' }], 'malformed_score'));
  it('abstains on a string score', () =>
    malformed([{ id: 'sig-1', materiality: '0.9', reason: 'x' }], 'malformed_score'));
  it('abstains on a null score', () =>
    malformed([{ id: 'sig-1', materiality: null, reason: 'x' }], 'malformed_score'));
  it('abstains on Infinity', () =>
    malformed([{ id: 'sig-1', materiality: Infinity, reason: 'x' }], 'malformed_score'));
  it('abstains on a non-object row', () => malformed(['nope'], 'missing_verdict'));

  it('abstains when the model returns two contradicting verdicts for one item', async () => {
    const { port } = scriptedPort(() => [
      { id: 'sig-1', materiality: 0.9, reason: 'a' },
      { id: 'sig-1', materiality: 0.1, reason: 'b' },
    ]);
    const r = await skimItems([item(1)], deps(port));
    expect(r.results[0]).toMatchObject({ abstained: true, abstainCode: 'duplicate_verdict' });
  });

  it('abstains the whole batch when the port fails, and never caches that', async () => {
    const failing = scriptedPort(() => Promise.reject(new Error('budget refused')));
    const cache = createMemorySkimCache();
    const r = await skimItems([item(1), item(2)], { port: failing.port, cache });
    expect(r.results.every((x) => x.abstained && x.abstainCode === 'port_failed')).toBe(true);
    expect(r.results.every((x) => x.proceed)).toBe(true);

    // A transient failure must not poison the item forever.
    const recovered = goodPort(0.05);
    const retry = await skimItems([item(1), item(2)], { port: recovered.port, cache });
    expect(retry.portCalls).toBe(1);
    expect(retry.results.every((x) => x.abstained)).toBe(false);
  });

  it('keeps a usable score when only the reason is malformed', async () => {
    const { port } = scriptedPort(
      () => [{ id: 'sig-1', materiality: 0.8, reason: 42 }] as unknown as SkimVerdict[],
    );
    const r = await skimItems([item(1)], deps(port));
    expect(r.results[0]?.abstained).toBe(false);
    expect(r.results[0]?.reason.length).toBeGreaterThan(0);
  });
});

describe('batching and truncation keep the cheap tier cheap', () => {
  it('splits into batches of the documented size', async () => {
    const { port, calls } = goodPort();
    const many = Array.from({ length: SKIM_BATCH_SIZE + 5 }, (_, i) => item(i));
    const r = await skimItems(many, deps(port));
    expect(r.portCalls).toBe(2);
    expect(calls[0]).toHaveLength(SKIM_BATCH_SIZE);
    expect(calls[1]).toHaveLength(5);
    expect(r.results).toHaveLength(SKIM_BATCH_SIZE + 5);
  });

  it('truncates the body before it reaches the model', async () => {
    const { port, calls } = goodPort();
    await skimItems([item(1, { body: 'x'.repeat(SKIM_BODY_CHARS * 3) })], deps(port));
    expect(calls[0]?.[0]?.body.length).toBeLessThanOrEqual(SKIM_BODY_CHARS);
  });

  it('does not call the port at all for an empty input', async () => {
    const { port } = goodPort();
    const r = await skimItems([], deps(port));
    expect(r).toMatchObject({ portCalls: 0, results: [], unknownIds: [] });
  });
});
