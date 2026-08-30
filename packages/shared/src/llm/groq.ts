/**
 * The Groq adapter — the only place in this repo that talks to a model.
 *
 * Two rules make this file the chokepoint rather than merely a client:
 *
 *   1. Every call authorises against the budget BEFORE the request and commits
 *      actual usage AFTER it. A caller cannot skip that by construction,
 *      because the caller never sees an HTTP client.
 *   2. Usage is committed even when the call FAILS. Tokens spent on a request
 *      that errored after the model ran are still spent, and a ledger that only
 *      counts successes drifts under exactly the conditions where you most need
 *      it to be right.
 *
 * Uses `fetch` rather than the Groq SDK deliberately: the SDK adds a dependency
 * and a retry policy we would have to reason about anyway, and the surface we
 * need is one POST.
 */
import { authorizeSpend, commitSpend } from './budget.js';
import type { BudgetLimits, BudgetState, SpendOutcome } from './budget.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * The models this system may name, keyed by ROLE rather than by size.
 *
 * A call site knows whether it is skimming or deciding; it should not also have
 * to know which weights that implies this month. Groq retired
 * `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` — the API answers
 * `model_not_found` for both — and the only reason that was a small change is
 * that the ids live in exactly one place.
 *
 * `verifier` is not a third size. It is a different FAMILY, and that is a
 * correctness requirement rather than a preference: `reason/verify/adversarial`
 * refuses to run when the verifier's identity matches the writer's, because a
 * model asked to check its own output is scoring the continuation it would have
 * written. Two sizes of one family share the training and therefore the blind
 * spots, so `openai/gpt-oss-20b` may never verify `openai/gpt-oss-120b`. Qwen
 * is a different lineage entirely. Keep it that way.
 */
export const MODELS = {
  /** Classification, synthesis, T3 orchestration — everything that decides. */
  strong: 'openai/gpt-oss-120b',
  /** T1 skim. It runs over EVERY collected item, so cheap and fast is the
   *  whole specification; T1 triages, it never decides truth. */
  small: 'openai/gpt-oss-20b',
  /** The adversarial verifier. A different family from `strong`, on purpose. */
  verifier: 'qwen/qwen3.6-27b',
} as const;

/**
 * Price per MILLION tokens, in CENTS. Both halves of that matter, and the unit
 * is DERIVED from `estimateCostCents` rather than asserted here:
 *
 *     cents = (tokens / 1_000_000) * rate      ⇒  rate is cents per Mtok
 *
 * Groq publishes dollars per million, so each number below is the published
 * dollar figure × 100. The table this replaced used × 10 and so under-counted
 * every call tenfold — a $20 ceiling that only stops at $200 is not a ceiling.
 * `groq.test.ts` pins the unit with a worked example, because this is the one
 * number in the system whose being wrong is silent.
 *
 * Rates read from https://console.groq.com/docs/models on 2026-08-22.
 */
const PRICE_CENTS_PER_MTOK: Record<string, { in: number; out: number }> = {
  [MODELS.strong]: { in: 15, out: 60 }, // $0.15 in / $0.60 out per 1M
  [MODELS.small]: { in: 7.5, out: 30 }, // $0.075 in / $0.30 out per 1M
  // $0.60 in / $3.00 out per 1M. The verifier's output costs 5× the strong
  // model's, which is an argument for short refutations — never an argument for
  // verifying with a cheaper relative of the writer.
  [MODELS.verifier]: { in: 60, out: 300 },
};

/** An unlisted model is priced as the most expensive one we know. This is a
 *  deliberate over-estimate, NOT a published rate: over-estimating costs us a
 *  call, under-estimating costs money, and only one of those is recoverable. */
const DEFAULT_PRICE = { in: 60, out: 300 };

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqRequest {
  model: string;
  messages: GroqMessage[];
  /** Deterministic by default — a reasoning system that cannot reproduce its
   *  own output cannot be debugged. */
  temperature?: number;
  /**
   * Ceiling on COMPLETION tokens — and on a reasoning model that includes the
   * reasoning, which is why it is also the pre-authorisation figure below.
   */
  maxTokens?: number;
  /** Ask for a JSON object back. Groq honours OpenAI's response_format. */
  json?: boolean;
  /**
   * Reasoning models (the whole gpt-oss family) spend completion tokens
   * thinking before they answer, billed at the OUTPUT rate. Left at the
   * provider default a T1 skim pays for medium-effort reasoning on every item
   * it triages — and, worse, can exhaust `maxTokens` mid-thought and return
   * nothing, which with `json: true` surfaces as a 400 `json_validate_failed`
   * rather than as a short answer. Tiers that triage should ask for 'low'.
   *
   * THE ACCEPTED VALUES DIFFER BY MODEL and Groq rejects the wrong one with a
   * 400 rather than ignoring it. gpt-oss takes `low | medium | high`; qwen3.6
   * takes `none | default` and refuses `low`. That is not a detail: the
   * verifier is a qwen by requirement, and a 400 there returns `uncertain`,
   * which withholds every Finding while the pipeline reports no errors. Found
   * exactly that way, on the verifier's first live call, 2026-08-23.
   *
   * The union is therefore the union of both vocabularies, and choosing a value
   * the model accepts belongs to the caller that chose the model.
   */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'default';
}

export interface GroqUsage {
  promptTokens: number;
  completionTokens: number;
  costCents: number;
}

export type GroqResult =
  | { ok: true; text: string; usage: GroqUsage; model: string; latencyMs: number }
  | { ok: false; reason: 'blocked'; outcome: SpendOutcome }
  | { ok: false; reason: 'http'; status: number; detail: string; usage: GroqUsage }
  /**
   * `usage` is OPTIONAL here and present only from the streaming path.
   *
   * A stream that dies mid-body has burned tokens upstream and `callGroqStream`
   * commits them to the in-memory ledger — but with nothing to hand `onUsage`,
   * the caller wrote no `ai_usage_log` row. That table is what reconstructs the
   * daily ceiling after a restart, so the two ledgers disagreed and the durable
   * one is the survivor: every crashed stream quietly raised the next day's
   * budget. Optional because `callGroq` has no figure to offer at this point
   * and no existing caller reads the field.
   */
  | { ok: false; reason: 'network' | 'parse'; detail: string; usage?: GroqUsage };

export function estimateCostCents(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = PRICE_CENTS_PER_MTOK[model] ?? DEFAULT_PRICE;
  return (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
}

/** ~4 chars per token. Crude, and deliberately so: it is used to pre-authorise
 *  a ceiling, and a tokenizer that drifts with the model would make the ceiling
 *  itself unreliable. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export interface GroqDeps {
  apiKey: string;
  state: BudgetState;
  limits: BudgetLimits;
  /** Run-token ceilings are enforced PER RUN, so every call must say which run
   *  it belongs to. Without it one long investigation could never be capped. */
  runId: string;
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Tool depth for the budget's depth cap. */
  toolDepth?: number;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

export async function callGroq(req: GroqRequest, deps: GroqDeps): Promise<GroqResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const maxTokens = req.maxTokens ?? 1024;

  const promptTokens = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  const estimated = estimateCostCents(req.model, promptTokens, maxTokens);

  const decision = authorizeSpend(deps.state, deps.limits, {
    runId: deps.runId,
    estimatedTokens: promptTokens + maxTokens,
    estimatedCostCents: estimated,
    toolDepth: deps.toolDepth ?? 0,
  });
  if (decision.outcome !== 'allowed') {
    return { ok: false, reason: 'blocked', outcome: decision.outcome };
  }

  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await doFetch(GROQ_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0,
        max_tokens: maxTokens,
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    // Nothing was consumed — the request never reached a model.
    return { ok: false, reason: 'network', detail: e instanceof Error ? e.message : String(e) };
  }
  clearTimeout(timer);

  const raw = await res.text();

  if (!res.ok) {
    // A non-2xx can still have burned prompt tokens upstream. Commit the
    // estimate rather than pretending the attempt was free.
    const usage: GroqUsage = { promptTokens, completionTokens: 0, costCents: estimated };
    commitSpend(deps.state, {
      runId: deps.runId,
      estimatedTokens: promptTokens,
      estimatedCostCents: usage.costCents,
      toolDepth: deps.toolDepth ?? 0,
    });
    return { ok: false, reason: 'http', status: res.status, detail: raw.slice(0, 400), usage };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'parse', detail: e instanceof Error ? e.message : String(e) };
  }

  const b = body as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };
  const text = b.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    return { ok: false, reason: 'parse', detail: 'response had no choices[0].message.content' };
  }

  // Prefer the provider's own counts over our estimate — the estimate exists to
  // authorise, the real number exists to account.
  const usage: GroqUsage = {
    promptTokens: b.usage?.prompt_tokens ?? promptTokens,
    completionTokens: b.usage?.completion_tokens ?? estimateTokens(text),
    costCents: 0,
  };
  usage.costCents = estimateCostCents(req.model, usage.promptTokens, usage.completionTokens);

  commitSpend(deps.state, {
    runId: deps.runId,
    estimatedTokens: usage.promptTokens + usage.completionTokens,
    estimatedCostCents: usage.costCents,
    toolDepth: deps.toolDepth ?? 0,
  });

  return {
    ok: true,
    text,
    usage,
    model: b.model ?? req.model,
    latencyMs: now() - started,
  };
}
/* ── STREAMING ─────────────────────────────────────────────────────────────
 *
 * `callGroqStream` exists so an answer can be shown while it is still being
 * written. Everything below is about keeping the two invariants at the top of
 * this file true when the response arrives as bytes over seconds rather than as
 * one JSON object, because both of them get harder:
 *
 *   1. PRE-AUTHORISE. Unchanged, and it has to be — the worst case is still
 *      `promptTokens + maxTokens`, since at authorisation time nobody knows how
 *      long the answer will be. A blocked call sends nothing.
 *
 *   2. COMMIT EVEN WHEN IT FAILS. This is where streaming is genuinely
 *      different. `callGroq` has one exit after the request; this has several,
 *      and most of them are failures: the socket drops mid-answer, the provider
 *      goes silent without hanging up, the caller's own `onDelta` throws, the
 *      final usage chunk never arrives. The model generated those tokens
 *      whether or not the bytes reached us. So the commit lives in a `finally`
 *      and is idempotent: there is no return path out of this function, and no
 *      exception through it, that leaves the day un-billed or bills it twice.
 *      A ledger that stops counting does not throw, does not log, and does not
 *      change one visible behaviour — the $20/day ceiling simply stops
 *      existing, and the first evidence is the invoice.
 *
 * THE TIMEOUT IS IDLE-BASED, NOT WHOLE-REQUEST. `DEFAULT_TIMEOUT_MS` bounds the
 * lifetime of a call, which is right when the answer arrives all at once and
 * wrong the moment it does not: an answer still producing tokens at 30s is
 * healthy, and killing it mid-sentence is a self-inflicted failure. What we
 * need to detect is SILENCE. The clock below is restarted by every chunk, so it
 * measures the gap between bytes rather than the duration of the request — a
 * stream may run for minutes provided it never stops talking.
 */

/**
 * How long the stream may say NOTHING before we give up on it. Deliberately
 * shorter than `DEFAULT_TIMEOUT_MS`: a healthy stream emits every few hundred
 * milliseconds, so 20s of silence is already pathological, and the only reason
 * we can be this strict is that this clock never punishes a long answer.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 20_000;

export interface GroqStreamRequest extends GroqRequest {
  /**
   * Called with each token as it lands. It runs inside this function's critical
   * section, so a throw here propagates to the caller — but only after the
   * ledger has been closed, never instead of it.
   */
  onDelta: (text: string) => void;
}

export interface GroqStreamDeps extends GroqDeps {
  /** Max silence between chunks. See `DEFAULT_IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number;
}

/**
 * One SSE `data:` payload, in the shape Groq and OpenAI put on the wire.
 *
 * Groq reports the final token counts under `x_groq.usage` on some models and
 * under the OpenAI-compatible top-level `usage` on others. Reading only one of
 * the two makes half the models fall back to the estimate — which OVER-bills,
 * so it never shows up as a runaway and never gets found.
 */
interface StreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  model?: string;
}

/** Distinguishable from any legitimate read result, so the race below can be
 *  decided by identity rather than by shape. */
const IDLE: unique symbol = Symbol('idle-timeout');

/** Resolves once the stream has been quiet for `ms`. The timer handle comes
 *  back with it because the alarm MUST be cancelled the instant a chunk wins
 *  the race — one uncancelled timer per chunk keeps the process alive well past
 *  the answer and, on a long stream, holds thousands of them at once. */
function idleAlarm(ms: number): {
  promise: Promise<typeof IDLE>;
  timer: ReturnType<typeof setTimeout>;
} {
  let timer!: ReturnType<typeof setTimeout>;
  const promise = new Promise<typeof IDLE>((resolve) => {
    timer = setTimeout(() => resolve(IDLE), ms);
  });
  return { promise, timer };
}

export async function callGroqStream(
  req: GroqStreamRequest,
  deps: GroqStreamDeps,
): Promise<GroqResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const maxTokens = req.maxTokens ?? 1024;
  const idleMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const toolDepth = deps.toolDepth ?? 0;

  const promptTokens = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  const estimated = estimateCostCents(req.model, promptTokens, maxTokens);

  const decision = authorizeSpend(deps.state, deps.limits, {
    runId: deps.runId,
    estimatedTokens: promptTokens + maxTokens,
    estimatedCostCents: estimated,
    toolDepth,
  });
  if (decision.outcome !== 'allowed') {
    return { ok: false, reason: 'blocked', outcome: decision.outcome };
  }

  const started = now();
  const controller = new AbortController();

  let res: Response;
  try {
    res = await doFetch(GROQ_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0,
        max_tokens: maxTokens,
        stream: true,
        // Not optional politeness: without it the stream ends with no token
        // counts at all, every completed call falls back to the worst-case
        // estimate, and the ledger permanently over-bills.
        stream_options: { include_usage: true },
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    // Same reasoning as `callGroq`: a DNS failure or a refused connection
    // happens before a single prompt token is read, so nothing was consumed and
    // billing it would drift the ledger the other way. This is the ONLY path
    // past authorisation that does not commit.
    return { ok: false, reason: 'network', detail: e instanceof Error ? e.message : String(e) };
  }

  /* Everything below is billable, so everything below sits inside the
   * try/finally that closes the ledger. */
  let seenPrompt: number | undefined;
  let seenCompletion: number | undefined;
  let committed = false;

  /**
   * Uses the provider's own counts when the usage chunk arrived and the
   * pre-authorised worst case when it did not — a stream that died tells us
   * nothing cheaper, and a partial read is not evidence of a partial
   * generation. This same figure is what the caller gets back, because
   * `ai_usage_log` is what rebuilds tomorrow's ceiling: a result that reports
   * less than it committed un-caps the next boot.
   */
  const resolveUsage = (): GroqUsage => {
    const p = seenPrompt ?? promptTokens;
    const c = seenCompletion ?? maxTokens;
    return { promptTokens: p, completionTokens: c, costCents: estimateCostCents(req.model, p, c) };
  };

  /** The one and only commit site, and idempotent so the `finally` can run it
   *  unconditionally without double-billing a path that already returned. */
  const closeLedger = (): void => {
    if (committed) return;
    committed = true;
    const usage = resolveUsage();
    commitSpend(deps.state, {
      runId: deps.runId,
      estimatedTokens: usage.promptTokens + usage.completionTokens,
      estimatedCostCents: usage.costCents,
      toolDepth,
    });
  };

  // Latched if the caller's own callback throws. A render bug in the console
  // must not be reported as a provider failure — that points the investigation
  // at the wrong system entirely — and the two are indistinguishable by the
  // time they reach the outer `catch`, so the origin is recorded at the throw.
  let callerThrew = false;

  try {
    if (!res.ok) {
      const raw = await res.text();
      // A non-2xx can still have burned prompt tokens upstream, exactly as in
      // `callGroq`. The `finally` bills it.
      return {
        ok: false,
        reason: 'http',
        status: res.status,
        detail: raw.slice(0, 400),
        usage: resolveUsage(),
      };
    }
    if (!res.body) {
      return { ok: false, reason: 'network', detail: 'streamed response had no body' };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let model = req.model;
    let sawDone = false;
    let wentIdle = false;

    while (!sawDone && !wentIdle) {
      const read = reader.read();
      // A fresh alarm per chunk IS the reset: this only ever measures the gap
      // since the last byte, which is why a slow-but-alive answer survives.
      const alarm = idleAlarm(idleMs);
      let winner: Awaited<typeof read> | typeof IDLE;
      try {
        winner = await Promise.race([read, alarm.promise]);
      } finally {
        clearTimeout(alarm.timer);
      }

      if (winner === IDLE) {
        // The read is still outstanding and will reject once we abort. Swallow
        // that or it surfaces seconds later as an unhandled rejection attached
        // to nothing.
        void read.catch(() => undefined);
        // Aborting is what actually releases the upstream request. Merely
        // stopping our own read leaves the provider generating — and billing.
        controller.abort();
        void reader.cancel().catch(() => undefined);
        wentIdle = true;
        break;
      }

      if (winner.done) break;
      buffer += decoder.decode(winner.value, { stream: true });

      // Only COMPLETE lines are consumed; the remainder stays buffered. A
      // `data:` line routinely arrives split across two reads, and a parser
      // that forgets that drops the token silently — which reads as the model
      // skipping a word, not as a parser fault.
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue; // blanks, `event:`, `:` keep-alives
        const payload = line.slice('data:'.length).trim();
        if (payload === '[DONE]') {
          sawDone = true;
          break;
        }
        let parsed: StreamChunk;
        try {
          parsed = JSON.parse(payload) as StreamChunk;
        } catch {
          // One malformed frame is not worth discarding a whole answer for, and
          // no repair is available: skip it and keep reading.
          continue;
        }
        if (parsed.model) model = parsed.model;
        const usage = parsed.usage ?? parsed.x_groq?.usage;
        if (usage) {
          seenPrompt = usage.prompt_tokens ?? seenPrompt;
          seenCompletion = usage.completion_tokens ?? seenCompletion;
        }
        const piece = parsed.choices?.[0]?.delta?.content;
        if (typeof piece === 'string' && piece.length > 0) {
          text += piece;
          try {
            req.onDelta(piece);
          } catch (e) {
            callerThrew = true;
            throw e;
          }
        }
      }
    }

    if (sawDone) void reader.cancel().catch(() => undefined);

    if (wentIdle) {
      return { ok: false, reason: 'network', detail: `stream idle for ${idleMs}ms`, usage: resolveUsage() };
    }

    // Note what is NOT an error here: zero content deltas. `callGroq` treats a
    // missing `message.content` as a parse failure because the SHAPE was wrong;
    // an empty stream is a well-formed zero-length completion, which is a model
    // outcome for the caller to judge rather than a transport fault.
    return { ok: true, text, usage: resolveUsage(), model, latencyMs: now() - started };
  } catch (e) {
    // Whatever went wrong, we have stopped reading. Release the upstream
    // request or the provider keeps generating — and keeps billing — into a
    // socket nobody is listening to. Aborting a finished fetch is a no-op.
    controller.abort();
    // A reset socket, a chunk that never came — or the caller's own callback
    // throwing, which is re-thrown rather than disguised as a network error.
    if (callerThrew) throw e;
    // Carries the committed figure for the same reason the idle path does: the
    // `finally` bills this, and a caller with nothing to log leaves the durable
    // ledger short of the in-memory one.
    return {
      ok: false,
      reason: 'network',
      detail: e instanceof Error ? e.message : String(e),
      usage: resolveUsage(),
    };
  } finally {
    closeLedger();
  }
}
