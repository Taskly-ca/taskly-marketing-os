/**
 * THE MODEL, THROUGH THE ONLY DOOR THAT CAN SPEND.
 *
 * `callGroq` owns the per-run token ceiling, the per-day dollar ceiling, the
 * tool-depth cap and the killswitch. Research is the most expensive thing in
 * TMOS — it puts eight documents through a strong model — so it is the last
 * place to bypass that, and rule 1 of AGENTS.md forbids it outright.
 *
 * A blocked or failed call returns **null**, never a fallback. This matters
 * more here than anywhere else in the system: the tempting failure mode is to
 * answer the question from the model's own memory when retrieval fails, and the
 * result is a fluent, uncited essay that is indistinguishable from a successful
 * run. The pipeline turns null into a short answer that names the failure.
 *
 * Usage is handed back through `onUsage` rather than written here, because the
 * `ai_usage_log` insert needs a database handle and this package's job is the
 * provider call. The daily ceiling is reconstructed from that table on restart,
 * so a caller that drops the callback silently un-caps the day — which is why
 * it is a required argument and not an optional one.
 */
import { MODELS, callGroq, createBudgetState, type BudgetLimits, type GroqUsage } from '@tmos/shared';
import type { AskPort, AskResult } from '@tmos/research';

export interface AskConfig {
  readonly apiKey: string;
  readonly limits: BudgetLimits;
  readonly runId: string;
  /** Called after every successful call so the caller can log the spend. */
  readonly onUsage: (usage: GroqUsage, model: string) => void | Promise<void>;
}

export function createAsk(cfg: AskConfig): AskPort {
  // One budget state per research run: the run-level token ceiling is meant to
  // bound THIS question, not to be shared with a competitor watch that happens
  // to be running in the same process.
  const state = createBudgetState();
  return {
    async ask(system, user, maxTokens): Promise<AskResult | null> {
      const res = await callGroq(
        {
          model: MODELS.strong,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          maxTokens,
          json: true,
          reasoningEffort: 'low',
        },
        { apiKey: cfg.apiKey, state, limits: cfg.limits, runId: cfg.runId },
      );
      if (!res.ok) return null;
      await cfg.onUsage(res.usage, MODELS.strong);
      return { text: res.text, costCents: res.usage.costCents };
    },
  };
}
