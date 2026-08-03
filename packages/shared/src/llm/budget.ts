/**
 * THE BUDGET CHOKEPOINT.
 *
 * Every LLM call in TMOS passes through here. No framework provides this —
 * documented runaway incidents range from $15 in 10 minutes to $47,000 over
 * 11 days, and CrewAI has published single runs at $414. A lint rule blocks
 * direct provider imports so there is no path around this module.
 *
 * Mirrors the `ai_usage_log` pattern already shipped in the marketplace:
 * outcomes are explicit, and a refusal is a first-class result rather than a
 * thrown surprise.
 */

export type SpendOutcome =
  | 'allowed'
  | 'blocked_run_tokens'
  | 'blocked_daily_cost'
  | 'blocked_tool_depth'
  | 'blocked_killswitch';

export interface BudgetLimits {
  /** Hard ceiling for a single run (one investigation / one pipeline pass). */
  maxRunTokens: number;
  /** Hard ceiling across the UTC day, all runs, all tiers. */
  maxDailyCostCents: number;
  /** Max nested tool calls before we stop — the runaway-loop backstop. */
  maxToolDepth: number;
}

export interface SpendRequest {
  runId: string;
  estimatedTokens: number;
  estimatedCostCents: number;
  toolDepth: number;
}

export interface BudgetDecision {
  outcome: SpendOutcome;
  /** Present whenever outcome !== 'allowed'. Callers surface this; they never
   *  retry blindly past a ceiling. */
  reason?: string;
}

export interface BudgetState {
  runTokens: Map<string, number>;
  dailyCostCents: number;
  day: string;
  killswitch: boolean;
}

export const createBudgetState = (day = utcDay()): BudgetState => ({
  runTokens: new Map(),
  dailyCostCents: 0,
  day,
  killswitch: false,
});

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Pure decision function — no I/O, so it is trivially testable and cannot be
 * bypassed by mocking a client. `commit` records the spend only when allowed.
 */
export function authorizeSpend(
  state: BudgetState,
  limits: BudgetLimits,
  req: SpendRequest,
  now: Date = new Date(),
): BudgetDecision {
  // Day rollover resets the daily ledger before any check.
  const today = utcDay(now);
  if (state.day !== today) {
    state.day = today;
    state.dailyCostCents = 0;
  }

  if (state.killswitch) {
    return { outcome: 'blocked_killswitch', reason: 'killswitch engaged' };
  }

  if (req.toolDepth > limits.maxToolDepth) {
    return {
      outcome: 'blocked_tool_depth',
      reason: `tool depth ${req.toolDepth} exceeds ${limits.maxToolDepth}`,
    };
  }

  const spentThisRun = state.runTokens.get(req.runId) ?? 0;
  if (spentThisRun + req.estimatedTokens > limits.maxRunTokens) {
    return {
      outcome: 'blocked_run_tokens',
      reason: `run ${req.runId} would reach ${spentThisRun + req.estimatedTokens} tokens, ceiling ${limits.maxRunTokens}`,
    };
  }

  if (state.dailyCostCents + req.estimatedCostCents > limits.maxDailyCostCents) {
    return {
      outcome: 'blocked_daily_cost',
      reason: `daily spend would reach ${state.dailyCostCents + req.estimatedCostCents}c, ceiling ${limits.maxDailyCostCents}c`,
    };
  }

  return { outcome: 'allowed' };
}

/** Record actual spend after a successful call. Only ever called on 'allowed'. */
export function commitSpend(state: BudgetState, req: SpendRequest): void {
  state.runTokens.set(req.runId, (state.runTokens.get(req.runId) ?? 0) + req.estimatedTokens);
  state.dailyCostCents += req.estimatedCostCents;
}

export function engageKillswitch(state: BudgetState): void {
  state.killswitch = true;
}
