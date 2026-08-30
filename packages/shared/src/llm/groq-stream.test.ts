/**
 * THE STREAMING LEDGER — the failure paths first, on purpose.
 *
 * `callGroq` has one exit after the request: a response arrives whole, and its
 * `usage` block is authoritative. `callGroqStream` has SEVEN, because a stream
 * can end at any byte: the connection can drop mid-answer, the provider can go
 * silent forever without closing, the caller's own `onDelta` can throw, and the
 * final usage chunk — the only place the real token count lives — may simply
 * never arrive.
 *
 * Every one of those is a way to spend money and record nothing. That bug does
 * not throw, does not log, and does not change a single visible behaviour: the
 * answers still stream, the console still works, and the $20/day ceiling has
 * quietly become no ceiling at all, because the ledger it compares against
 * stopped counting. It is only discoverable from the invoice.
 *
 * So the abort and failure tests are written FIRST and read first, and the
 * happy path is at the bottom. Each one asserts the same two numbers — the
 * run's token total and the day's cents — because those two are the ceiling.
 * Nothing here needs a key, a network, or a clock we do not own.
 */
import { describe, it, expect } from 'vitest';
import { MODELS, callGroqStream, estimateCostCents, estimateTokens } from './groq.js';
import { createBudgetState } from './budget.js';
import type { BudgetLimits, BudgetState } from './budget.js';

const M = 1_000_000;

const LIMITS: BudgetLimits = {
  maxRunTokens: 10 * M,
  maxDailyCostCents: 2_000,
  maxToolDepth: 8,
};

/** One SSE frame in the shape Groq/OpenAI actually put on the wire. */
const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (content: string): string => frame({ choices: [{ delta: { content } }] });
const DONE = 'data: [DONE]\n\n';

const encoder = new TextEncoder();

/**
 * A fake `fetch` that plays a scripted stream.
 *
 * `chunks` are BYTE chunks, not frames — the two are different on purpose, so a
 * test can split one `data:` line across two reads the way a real socket does.
 * `then` decides how the body ends: closed, errored, or never (the silent
 * provider that the idle clock exists for).
 */
function streamingFetch(
  chunks: string[],
  opts: {
    status?: number;
    end?: 'close' | 'error' | 'hang';
    /** ms between chunks — a stream that is slow but ALIVE. */
    gapMs?: number;
    seen?: { signal?: AbortSignal; body?: string };
  } = {},
): typeof fetch {
  const { status = 200, end = 'close', gapMs = 0 } = opts;
  return (async (_url: string, init?: RequestInit) => {
    if (opts.seen) {
      opts.seen.signal = init?.signal ?? undefined;
      opts.seen.body = typeof init?.body === 'string' ? init.body : undefined;
    }
    // `pull`, not `start`: chunks must be handed over ONE READ AT A TIME, or
    // the error/hang at the end of the script races ahead of the bytes before
    // it (an errored ReadableStream discards whatever is still queued) and the
    // mid-stream tests would silently stop testing mid-stream.
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i]!));
          i += 1;
          return;
        }
        if (end === 'close') controller.close();
        else if (end === 'error') controller.error(new Error('connection reset by peer'));
        // 'hang' — never resolves. The provider that stopped talking without
        // hanging up, which no whole-request timeout on a long answer catches.
        else await new Promise(() => undefined);
      },
    });
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
}

/** The worst case this call pre-authorises against — and therefore the exact
 *  figure every failure path must commit, since a failure tells us nothing
 *  cheaper. */
function worstCase(messages: string[], maxTokens: number) {
  const promptTokens = messages.reduce((n, m) => n + estimateTokens(m), 0);
  return {
    promptTokens,
    tokens: promptTokens + maxTokens,
    cents: estimateCostCents(MODELS.strong, promptTokens, maxTokens),
  };
}

const USER = 'what should we do about snow removal in October';
const deps = (state: BudgetState, fetchImpl: typeof fetch, extra: object = {}) => ({
  apiKey: 'test',
  state,
  limits: LIMITS,
  runId: 'stream',
  fetchImpl,
  now: () => 0,
  ...extra,
});
const req = (onDelta: (t: string) => void, maxTokens = 1024) => ({
  model: MODELS.strong,
  messages: [{ role: 'user' as const, content: USER }],
  maxTokens,
  onDelta,
});

/* ── 1. the ceiling still stops the call BEFORE any HTTP ──────────────────── */

describe('pre-authorisation survives streaming', () => {
  it('a blocked call makes no request and moves no money', async () => {
    const state = createBudgetState();
    state.dailyCostCents = 1_999.99; // one call short of the $20 day
    let called = 0;
    const seen: string[] = [];
    const fetchImpl = (async () => {
      called += 1;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await callGroqStream(
      req((t) => seen.push(t)),
      deps(state, fetchImpl),
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('blocked');
    // The whole point: not one byte was sent, so not one token was burned.
    expect(called).toBe(0);
    expect(seen).toEqual([]);
    expect(state.dailyCostCents).toBe(1_999.99);
    expect(state.runTokens.get('stream')).toBeUndefined();
  });

  it('authorises the WORST case — prompt + the full maxTokens, not the deltas we got', async () => {
    // A stream that returns two words must still have been authorised for the
    // whole completion ceiling, because at authorisation time nobody knows how
    // long the answer will be. Under-authorising is how a run walks past its
    // token cap one short answer at a time.
    const state = createBudgetState();
    const limits: BudgetLimits = { ...LIMITS, maxRunTokens: 100 };
    const res = await callGroqStream(
      req(() => {}, 1024),
      {
        ...deps(state, streamingFetch([delta('hi'), DONE])),
        limits,
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('blocked');
    if (res.reason !== 'blocked') return;
    expect(res.outcome).toBe('blocked_run_tokens');
  });
});

/* ── 2. every way a stream can die still bills ────────────────────────────── */

describe('a stream that dies has still burned tokens', () => {
  it('MID-STREAM ERROR: commits the estimate, keeps the deltas already delivered', async () => {
    const state = createBudgetState();
    const got: string[] = [];
    const w = worstCase([USER], 1024);

    const res = await callGroqStream(
      req((t) => got.push(t)),
      deps(state, streamingFetch([delta('the '), delta('answer ')], { end: 'error' })),
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('network');
    // Text that arrived is still text that arrived — the caller has it.
    expect(got).toEqual(['the ', 'answer ']);
    // And the model generated a full completion server-side whether or not the
    // socket lived long enough to hand it to us. Bill the worst case: a partial
    // read is not evidence of a partial generation.
    expect(state.dailyCostCents).toBeCloseTo(w.cents, 9);
    expect(state.runTokens.get('stream')).toBe(w.tokens);
  });

  it('IDLE STREAM: aborts, commits, and actually cancels the request', async () => {
    const state = createBudgetState();
    const seen: { signal?: AbortSignal } = {};
    const w = worstCase([USER], 1024);
    const got: string[] = [];

    const res = await callGroqStream(
      req((t) => got.push(t)),
      deps(state, streamingFetch([delta('start')], { end: 'hang', seen }), { idleTimeoutMs: 40 }),
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('network');
    // `blocked` is the one failure variant with no `detail`, so narrow before
    // reading it — an expect() does not narrow a union for the type checker.
    if (res.reason === 'blocked') throw new Error('expected a network failure');
    expect(res.detail).toMatch(/idle/i);
    expect(got).toEqual(['start']);
    // Aborting the controller is what releases the upstream connection. Without
    // it we stop reading but the provider keeps generating — and keeps billing.
    expect(seen.signal?.aborted).toBe(true);
    expect(state.dailyCostCents).toBeCloseTo(w.cents, 9);
  });

  it('SLOW BUT ALIVE: a long answer past the idle window is NOT aborted', async () => {
    // The reason the timeout had to become idle-based. Eight chunks 25ms apart
    // run 200ms — five times the 40ms window — and every one of them resets the
    // clock, because the clock measures SILENCE, not duration. A whole-request
    // timeout would kill this answer mid-sentence and call it a network error.
    const state = createBudgetState();
    const got: string[] = [];
    const chunks = [...Array(8).keys()].map((i) => delta(`${i}`));

    const res = await callGroqStream(
      req((t) => got.push(t)),
      deps(state, streamingFetch([...chunks, DONE], { gapMs: 25 }), { idleTimeoutMs: 40 }),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe('01234567');
    expect(got).toHaveLength(8);
  });

  it('NO USAGE CHUNK: the answer is fine, and the day is billed the estimate', async () => {
    // `stream_options.include_usage` is requested, but a provider that drops it
    // (or a proxy that eats the final chunk) must not make the call free. The
    // returned usage and the committed usage are deliberately the SAME numbers:
    // `ai_usage_log` is what rebuilds tomorrow's ceiling, so a result that
    // reports less than it spent un-caps the next boot.
    const state = createBudgetState();
    const w = worstCase([USER], 1024);

    const res = await callGroqStream(
      req(() => {}),
      deps(state, streamingFetch([delta('a'), delta('b'), DONE])),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe('ab');
    expect(res.usage.costCents).toBeCloseTo(w.cents, 9);
    expect(state.dailyCostCents).toBeCloseTo(w.cents, 9);
    expect(state.runTokens.get('stream')).toBe(w.tokens);
  });

  it('NON-2XX: commits the estimate, exactly as callGroq does', async () => {
    const state = createBudgetState();
    const w = worstCase([USER], 1024);
    const res = await callGroqStream(
      req(() => {}),
      deps(state, streamingFetch(['{"error":{"message":"rate limited"}}'], { status: 429 })),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('http');
    if (res.reason !== 'http') return;
    expect(res.status).toBe(429);
    expect(res.detail).toContain('rate limited');
    expect(state.dailyCostCents).toBeCloseTo(w.cents, 9);
  });

  it('CONNECT FAILURE: nothing reached a model, so nothing is billed', async () => {
    // The one path that must NOT commit, and the reason the others must. DNS
    // failure and connection refused happen before a single prompt token is
    // read; billing them would drift the ledger in the other direction.
    const state = createBudgetState();
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const res = await callGroqStream(
      req(() => {}),
      deps(state, fetchImpl),
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('network');
    expect(state.dailyCostCents).toBe(0);
    expect(state.runTokens.get('stream')).toBeUndefined();
  });

  it("CALLER'S onDelta THROWS: the throw propagates, the ledger still closes", async () => {
    // Streaming hands control to caller code inside our critical section, which
    // `callGroq` never did. A render bug in the console must not be able to
    // skip a commit — the commit is in a `finally` for exactly this.
    const state = createBudgetState();
    const w = worstCase([USER], 1024);

    await expect(
      callGroqStream(
        req(() => {
          throw new Error('render blew up');
        }),
        deps(state, streamingFetch([delta('x'), DONE])),
      ),
    ).rejects.toThrow('render blew up');

    expect(state.dailyCostCents).toBeCloseTo(w.cents, 9);
    expect(state.runTokens.get('stream')).toBe(w.tokens);
  });

  it('commits ONCE — an error AFTER the usage chunk does not double-bill', async () => {
    // The mirror of the un-capping bug: committing twice makes the ceiling
    // arrive early and looks like a working budget, so nobody investigates.
    const state = createBudgetState();
    const usageFrame = frame({ choices: [], usage: { prompt_tokens: M, completion_tokens: M } });

    const res = await callGroqStream(
      req(() => {}),
      deps(state, streamingFetch([delta('ok'), usageFrame], { end: 'error' })),
    );

    expect(res.ok).toBe(false);
    // 1M in + 1M out on the strong model is 75¢ — the real figure, once.
    expect(state.dailyCostCents).toBe(75);
    expect(state.runTokens.get('stream')).toBe(2 * M);
  });
});

/* ── 3. the ceiling holds end-to-end, in cents ────────────────────────────── */

describe('the daily ceiling still stops streaming calls', () => {
  it('$20/day buys 26 million-token streams, not 266', async () => {
    // The assertion the non-streaming suite makes, re-run through the new door:
    // 26 × 75¢ = 1950¢, and the 27th is refused. If `callGroqStream` commits a
    // smaller number than the stream actually reported — by dropping the usage
    // chunk, by skipping a failed call, by any factor at all — this count grows
    // and NOTHING else in the system notices.
    const state = createBudgetState();
    const limits: BudgetLimits = { ...LIMITS, maxRunTokens: Number.MAX_SAFE_INTEGER };
    const usageFrame = frame({ choices: [], usage: { prompt_tokens: M, completion_tokens: M } });

    let allowed = 0;
    for (let i = 0; i < 100; i += 1) {
      const res = await callGroqStream(
        req(() => {}, M),
        {
          ...deps(state, streamingFetch([delta('x'), usageFrame, DONE])),
          limits,
          runId: 'ceiling',
        },
      );
      if (!res.ok) break;
      allowed += 1;
    }

    expect(allowed).toBe(26);
    expect(state.dailyCostCents).toBe(1_950);
  });
});

/* ── 4. the wire format ───────────────────────────────────────────────────── */

describe('SSE parsing', () => {
  it('reassembles a frame split across byte chunks', async () => {
    // The classic streaming bug: a `data:` line arrives in two reads, the
    // parser sees two halves of JSON, and silently drops the token. It looks
    // like the model skipped a word, not like a parser fault.
    const state = createBudgetState();
    const whole = delta('hello');
    const cut = Math.floor(whole.length / 2);
    const got: string[] = [];

    const res = await callGroqStream(
      req((t) => got.push(t)),
      deps(state, streamingFetch([whole.slice(0, cut), whole.slice(cut), DONE])),
    );

    expect(res.ok).toBe(true);
    expect(got).toEqual(['hello']);
  });

  it('ignores keep-alives, comments and non-data lines', async () => {
    const state = createBudgetState();
    const got: string[] = [];
    const res = await callGroqStream(
      req((t) => got.push(t)),
      deps(
        state,
        streamingFetch([
          ': keep-alive\n\n',
          'event: message\n',
          delta('a'),
          '\n',
          delta('b'),
          DONE,
        ]),
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe('ab');
    expect(got).toEqual(['a', 'b']);
  });

  it('stops at [DONE] and does not read past it', async () => {
    const state = createBudgetState();
    const got: string[] = [];
    const res = await callGroqStream(
      req((t) => got.push(t)),
      // 'hang' proves termination came from [DONE] and not from the body
      // closing — a parser that waits for EOF would sit here until the idle
      // clock fired and report a spurious network failure on a good answer.
      deps(state, streamingFetch([delta('a'), DONE, delta('never')], { end: 'hang' }), {
        idleTimeoutMs: 5_000,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe('a');
    expect(got).toEqual(['a']);
  });

  it("reads usage from Groq's x_groq envelope as well as the OpenAI field", async () => {
    // Groq puts the final usage under `x_groq.usage` on some models and under
    // the OpenAI-compatible top-level `usage` on others. Reading only one of
    // them silently falls back to the estimate — which over-bills rather than
    // under-bills, so it would never be noticed from the ledger alone.
    const state = createBudgetState();
    const res = await callGroqStream(
      req(() => {}),
      deps(
        state,
        streamingFetch([
          delta('x'),
          frame({ choices: [], x_groq: { usage: { prompt_tokens: M, completion_tokens: M } } }),
          DONE,
        ]),
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.usage.promptTokens).toBe(M);
    expect(res.usage.costCents).toBe(75);
    expect(state.dailyCostCents).toBe(75);
  });
});

/* ── 5. the happy path, last ──────────────────────────────────────────────── */

describe('a completed stream', () => {
  it('streams deltas in order and returns the assembled text with real usage', async () => {
    const state = createBudgetState();
    const got: string[] = [];
    const seen: { body?: string } = {};

    const res = await callGroqStream(
      req((t) => got.push(t)),
      deps(
        state,
        streamingFetch(
          [
            delta('Snow '),
            delta('removal '),
            delta('demand'),
            frame({
              choices: [{ delta: {}, finish_reason: 'stop' }],
              model: MODELS.strong,
              usage: { prompt_tokens: 2_000, completion_tokens: 500 },
            }),
            DONE,
          ],
          { seen },
        ),
      ),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(got).toEqual(['Snow ', 'removal ', 'demand']);
    expect(res.text).toBe('Snow removal demand');
    expect(res.model).toBe(MODELS.strong);
    expect(res.usage.promptTokens).toBe(2_000);
    expect(res.usage.completionTokens).toBe(500);
    expect(res.usage.costCents).toBeCloseTo(estimateCostCents(MODELS.strong, 2_000, 500), 9);
    expect(state.dailyCostCents).toBeCloseTo(res.usage.costCents, 9);
    expect(state.runTokens.get('stream')).toBe(2_500);
  });

  it('asks for the stream and for the usage chunk that pays for it', async () => {
    // `include_usage` is not optional politeness — without it every completed
    // stream falls back to the estimate, and the ledger permanently over-bills.
    const state = createBudgetState();
    const seen: { body?: string } = {};
    await callGroqStream(
      req(() => {}),
      deps(state, streamingFetch([delta('a'), DONE], { seen })),
    );
    const body = JSON.parse(seen.body ?? '{}') as {
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
      max_tokens?: number;
    };
    expect(body.stream).toBe(true);
    expect(body.stream_options?.include_usage).toBe(true);
    expect(body.max_tokens).toBe(1024);
  });
});

describe('a crashed stream reports what it billed', () => {
  /**
   * The in-memory ledger and `ai_usage_log` must not disagree.
   *
   * `callGroqStream` commits spend when a stream dies mid-body, because the
   * tokens were burned upstream. But the `network` variant carried no figure,
   * so the caller had nothing to write to `ai_usage_log` — and that table is
   * what reconstructs the daily ceiling after a restart. The durable ledger is
   * the survivor, so every crashed stream quietly raised the next day's budget.
   */
  it('carries usage when the stream goes idle', async () => {
    const state = createBudgetState();
    const w = worstCase([USER], 1024);
    const res = await callGroqStream(
      req(() => undefined),
      deps(state, streamingFetch([delta('start')], { end: 'hang' }), { idleTimeoutMs: 40 }),
    );
    expect(res.ok).toBe(false);
    if (res.ok || res.reason === 'blocked') throw new Error('expected a network failure');
    expect(res.usage).toBeDefined();
    // The figure reported is exactly the figure committed — a caller that logs
    // it cannot under-report what the ceiling already spent.
    expect(res.usage?.costCents).toBeCloseTo(w.cents, 9);
    expect(state.dailyCostCents).toBeCloseTo(w.cents, 9);
  });

  it('carries usage when the socket dies mid-body', async () => {
    const state = createBudgetState();
    const w = worstCase([USER], 1024);
    const res = await callGroqStream(
      req(() => undefined),
      deps(state, streamingFetch([delta('start')], { end: 'error' })),
    );
    expect(res.ok).toBe(false);
    if (res.ok || res.reason === 'blocked') throw new Error('expected a network failure');
    expect(res.usage?.costCents).toBeCloseTo(w.cents, 9);
  });
});
