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
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
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
  | { ok: false; reason: 'network' | 'parse'; detail: string };

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
