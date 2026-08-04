import { describe, expect, it } from 'vitest';
import type { EvidenceList, ToolImpl, WorkerContext, WorkerResult, WorkerSpec } from './workers.js';
import {
  MIN_SPAN_CHARS,
  WORKER_TOKEN_BUDGET_DEFAULT,
  compressWorkerResult,
  estimateTokens,
  runWorkers,
} from './workers.js';

const OBSERVED = '2026-08-01T09:00:00Z';

const ev = (
  n: number,
  span = `Jiffy listed a flat $${n}9 rate for drain clearing in Toronto.`,
) => ({
  url: `https://example.com/a${n}`,
  span,
  observed_at: OBSERVED,
});

const list = (...items: ReturnType<typeof ev>[]): EvidenceList => items as unknown as EvidenceList;

const tools: Record<string, ToolImpl> = {
  search: async (input) => `search:${input}`,
  fetch: async (input) => `fetch:${input}`,
  gsc: async (input) => `gsc:${input}`,
};

const spec = (
  id: string,
  toolNames: readonly string[],
  run: (ctx: WorkerContext) => Promise<WorkerResult>,
): WorkerSpec => ({ id, tools: toolNames, run });

const opts = (overrides: Partial<Parameters<typeof runWorkers>[1]> = {}) => ({
  question: 'what did Jiffy change?',
  tools,
  maxToolDepth: 3,
  tokenBudget: WORKER_TOKEN_BUDGET_DEFAULT,
  ...overrides,
});

describe('tool scope isolation', () => {
  it('refuses a tool the worker does not own', async () => {
    const thief = spec('thief', ['search'], async (ctx) => {
      await ctx.toolbox.call('gsc', 'q'); // owned by another worker
      return { evidence: list(ev(1)) };
    });
    const honest = spec('honest', ['search'], async (ctx) => {
      await ctx.toolbox.call('search', 'q');
      return { evidence: list(ev(2)) };
    });

    const res = await runWorkers([thief, honest], opts());
    const bad = res.outcomes.find((o) => o.workerId === 'thief');
    const good = res.outcomes.find((o) => o.workerId === 'honest');

    expect(bad?.status).toBe('failed');
    expect(bad).toMatchObject({ code: 'tool_scope' });
    expect(bad?.status === 'failed' && bad.detail).toContain('gsc');
    // One worker's scope violation must not take the run down with it.
    expect(good?.status).toBe('ok');
  });

  it('exposes only the owned tool names to the worker', async () => {
    let seen: readonly string[] = [];
    const w = spec('w', ['search', 'fetch'], async (ctx) => {
      seen = ctx.toolbox.names;
      return { evidence: list(ev(1)) };
    });
    await runWorkers([w], opts());
    expect(seen).toEqual(['fetch', 'search']);
  });
});

describe('tool depth cap', () => {
  it('refuses a recursive worker past the configured depth', async () => {
    const recursive = spec('recursive', ['search'], async (ctx) => {
      let box = ctx.toolbox;
      for (let i = 0; i < 50; i++) {
        await box.call('search', `hop-${i}`);
        box = box.descend();
      }
      return { evidence: list(ev(1)) };
    });
    const shallow = spec('shallow', ['search'], async (ctx) => {
      await ctx.toolbox.call('search', 'q');
      return { evidence: list(ev(2)) };
    });

    const res = await runWorkers([recursive, shallow], opts({ maxToolDepth: 3 }));
    const failed = res.outcomes.find((o) => o.workerId === 'recursive');

    expect(failed?.status).toBe('failed');
    expect(failed).toMatchObject({ code: 'tool_depth' });
    expect(failed?.status === 'failed' && failed.detail).toContain('3');
    expect(res.outcomes.find((o) => o.workerId === 'shallow')?.status).toBe('ok');
  });
});

describe('evidence, not prose', () => {
  it('rejects a worker that returns prose with no span', async () => {
    // The cast is the point: the TYPE forbids an empty evidence list, so this
    // shape is only reachable by lying to the compiler. The runtime check
    // catches exactly that case.
    const proseOnly = spec('prose', ['search'], async () => ({
      evidence: [] as unknown as EvidenceList,
      notes: 'Jiffy appears to have repriced its plumbing line across the GTA.',
    }));

    const res = await runWorkers([proseOnly], opts());
    expect(res.outcomes[0]).toMatchObject({ status: 'rejected', code: 'no_evidence' });
    expect(res.retrievedUrls).toEqual([]);
  });

  it('rejects an evidence item whose span is too short to locate', async () => {
    const w = spec('w', ['search'], async () => ({
      evidence: list({ url: 'https://example.com/a', span: 'up', observed_at: OBSERVED }),
    }));
    const res = await runWorkers([w], opts());
    expect(res.outcomes[0]).toMatchObject({ status: 'rejected', code: 'invalid_evidence' });
    expect(res.outcomes[0]?.status === 'rejected' && res.outcomes[0].detail).toContain(
      String(MIN_SPAN_CHARS),
    );
  });

  it('rejects a malformed url and a malformed observed_at', async () => {
    const badUrl = spec('badurl', [], async () => ({
      evidence: list({ url: 'not-a-url', span: 'a long enough span here', observed_at: OBSERVED }),
    }));
    const badDate = spec('baddate', [], async () => ({
      evidence: list({
        url: 'https://example.com/a',
        span: 'a long enough span here',
        observed_at: 'yesterday',
      }),
    }));
    const res = await runWorkers([badUrl, badDate], opts());
    expect(res.outcomes.every((o) => o.status === 'rejected')).toBe(true);
  });
});

describe('compression', () => {
  it('never splits an evidence span — it drops whole items', () => {
    const long = 'x'.repeat(400);
    const items = list(ev(1, long), ev(2, long), ev(3, long), ev(4, long));
    const out = compressWorkerResult({ evidence: items }, 120);

    expect(out.evidence.length).toBeGreaterThan(0);
    expect(out.evidence.length).toBeLessThan(4);
    // Every surviving span is byte-identical to the one the worker produced.
    for (const kept of out.evidence) {
      expect(items.some((i) => i.span === kept.span && i.url === kept.url)).toBe(true);
    }
    expect(out.report.dropped).toBe(4 - out.evidence.length);
  });

  it('keeps one oversized span whole and reports being over budget', () => {
    const huge = 'y'.repeat(5_000);
    const out = compressWorkerResult({ evidence: list(ev(1, huge)) }, 100);
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]?.span).toBe(huge);
    expect(out.report.overBudget).toBe(true);
  });

  it('truncates prose notes but never evidence', () => {
    const notes = 'word '.repeat(2_000);
    const out = compressWorkerResult({ evidence: list(ev(1)), notes }, 400);
    expect(out.report.notesTruncated).toBe(true);
    expect(estimateTokens(out.notes)).toBeLessThanOrEqual(estimateTokens(notes));
    expect(out.evidence[0]?.span).toBe(ev(1).span);
  });

  it('dedupes identical url+span pairs', () => {
    const out = compressWorkerResult({ evidence: list(ev(1), ev(1), ev(2)) }, 10_000);
    expect(out.evidence).toHaveLength(2);
  });

  it('holds every worker inside the 1k-2k token envelope by default', async () => {
    const noisy = spec('noisy', [], async () => ({
      evidence: list(...Array.from({ length: 200 }, (_, i) => ev(i, 'z'.repeat(300)))),
    }));
    const res = await runWorkers([noisy], opts());
    const first = res.outcomes[0];
    expect(first?.status).toBe('ok');
    expect(first?.status === 'ok' && first.compression.estimatedTokens).toBeLessThanOrEqual(
      WORKER_TOKEN_BUDGET_DEFAULT,
    );
  });
});

describe('determinism and failure isolation', () => {
  it('a throwing worker does not fail the run', async () => {
    const boom = spec('boom', [], async () => {
      throw new Error('upstream 503');
    });
    const fine = spec('fine', [], async () => ({ evidence: list(ev(9)) }));
    const res = await runWorkers([boom, fine], opts());
    expect(res.outcomes.find((o) => o.workerId === 'boom')).toMatchObject({
      status: 'failed',
      code: 'threw',
    });
    expect(res.outcomes.find((o) => o.workerId === 'fine')?.status).toBe('ok');
  });

  it('schedules by worker id and returns identical output for identical input', async () => {
    const mk = () => [
      spec('zulu', [], async () => ({ evidence: list(ev(3)) })),
      spec('alpha', [], async () => ({ evidence: list(ev(1)) })),
      spec('mike', [], async () => ({ evidence: list(ev(2)) })),
    ];
    const a = await runWorkers(mk(), opts());
    const b = await runWorkers(mk(), opts());
    expect(a.outcomes.map((o) => o.workerId)).toEqual(['alpha', 'mike', 'zulu']);
    expect(a).toEqual(b);
  });

  it('reports retrieved urls for the L0 url-was-retrieved check', async () => {
    const w = spec('w', [], async () => ({ evidence: list(ev(1), ev(2)) }));
    const res = await runWorkers([w], opts());
    expect(res.retrievedUrls).toEqual(['https://example.com/a1', 'https://example.com/a2']);
  });
});
