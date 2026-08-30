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
import {
  MODELS,
  callGroq,
  callGroqStream,
  createBudgetState,
  type BudgetLimits,
  type GroqUsage,
} from '@tmos/shared';
import type { AskPort, AskResult, AskStreamPort } from '@tmos/research';

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

/**
 * THE SAME DOOR, STREAMING.
 *
 * Identical wiring to `createAsk` — same `AskConfig`, same required `onUsage`,
 * same one-budget-state-per-run — because the reasons for all three are about
 * the ceiling and the ceiling does not care how the bytes arrive. What is
 * genuinely different is worth stating:
 *
 * NO `json: true`. `createAsk` asks for a JSON object because its caller parses
 * the answer into `Point`s. Streaming exists so prose can be shown as it is
 * written, and a JSON envelope cannot be shown until it closes — a streamed
 * JSON object is a progress bar made of braces. So this port streams prose, and
 * anything that needs structure keeps using `createAsk`.
 *
 * `onUsage` IS ALSO CALLED FOR A FAILED CALL, which `createAsk` does not do,
 * and the divergence is deliberate. `callGroqStream` commits spend on a stream
 * that dies — the tokens were burned — so a failure that reported nothing would
 * leave the in-memory ledger and `ai_usage_log` disagreeing, and the daily
 * ceiling is rebuilt from the table on the next boot. Reporting only successes
 * is exactly how the reconstruction comes back too low.
 *
 * KNOWN GAP, for whoever wires the persistence: a stream that dies MID-BODY
 * returns `reason: 'network'`, which carries no `usage` field, so that one case
 * still commits in memory and logs nothing. Closing it means widening the
 * result union, which touches every existing `callGroq` caller — a serial
 * change, not this one.
 */
export function createAskStream(cfg: AskConfig): AskStreamPort {
  const state = createBudgetState();
  return {
    async askStream(system, user, maxTokens, onDelta): Promise<AskResult | null> {
      const res = await callGroqStream(
        {
          model: MODELS.strong,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          maxTokens,
          reasoningEffort: 'low',
          onDelta,
        },
        { apiKey: cfg.apiKey, state, limits: cfg.limits, runId: cfg.runId },
      );
      if (!res.ok) {
        // A refusal is free; an HTTP failure is not. Only the second one has a
        // usage figure to report.
        // `http` always carries usage; a crashed stream now carries it too.
        // Skipping the second case left `ai_usage_log` short of what the
        // in-memory ledger had already committed, and that table is what
        // rebuilds the daily ceiling after a restart — so every crashed stream
        // quietly raised tomorrow's budget.
        if (res.reason === 'http') await cfg.onUsage(res.usage, MODELS.strong);
        // `blocked` never reached a model and has no figure to report.
        else if (res.reason !== 'blocked' && res.usage) await cfg.onUsage(res.usage, MODELS.strong);
        return null;
      }
      await cfg.onUsage(res.usage, MODELS.strong);
      return { text: res.text, costCents: res.usage.costCents };
    },
  };
}
