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

/** Groq's per-million-token prices, in cents, for the models we use.
 *  Estimates are for the BUDGET, not for billing — they only need to be close
 *  enough that a runaway is caught before it is expensive. */
const PRICE_CENTS_PER_MTOK: Record<string, { in: number; out: number }> = {
  'llama-3.3-70b-versatile': { in: 5.9, out: 7.9 },
  'llama-3.1-8b-instant': { in: 0.5, out: 0.8 },
};

const DEFAULT_PRICE = { in: 6, out: 8 };

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
  maxTokens?: number;
  /** Ask for a JSON object back. Groq honours OpenAI's response_format. */
  json?: boolean;
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
