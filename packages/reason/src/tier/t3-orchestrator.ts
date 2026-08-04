/**
 * T3 — the deep tier, and the only one that can run up a bill.
 *
 * Its defining property is that it CANNOT overspend, and that has to be
 * structural rather than a promise. Two things make it so:
 *
 *   1. A hard daily quota on RUNS and on SPEND. When it is gone, T3 stops
 *      promoting and says so in the return value. It does not quietly fall
 *      back to a cheaper model or a shallower search — a system that runs
 *      cheaper when it is out of budget produces worse answers with no signal
 *      that it did, which is the failure a reader cannot detect.
 *   2. Every spend goes through `BudgetPort`, wired by the caller to
 *      `@tmos/shared/llm/budget`. Nothing here calls a provider.
 *
 * Candidates RANK COMPETITIVELY into the remaining quota; they do not pass a
 * threshold. A threshold admits however many candidates happen to clear it,
 * which is the same as having no ceiling on a busy day.
 *
 * Strict rank order, with one deliberate consequence: when the top-ranked
 * candidate does not fit the remaining spend, we stop. We do NOT skip ahead to
 * a cheaper, lower-ranked one. Filling leftover quota with lesser work is
 * precisely the silent degradation described above, wearing a thrift costume.
 */

/* ── the budget port ──────────────────────────────────────────────────────── */

/**
 * Structurally identical to `@tmos/shared/llm/budget`. It is redeclared rather
 * than imported because `@tmos/reason` does not depend on `@tmos/shared` and
 * package.json is a locked file — the caller wires `authorizeSpend` /
 * `commitSpend` (bound to a BudgetState + BudgetLimits) into this port. That
 * seam is also what lets a test drive a `blocked_*` outcome without a fixture
 * for the whole ledger.
 */
export type SpendOutcome =
  | 'allowed'
  | 'blocked_run_tokens'
  | 'blocked_daily_cost'
  | 'blocked_tool_depth'
  | 'blocked_killswitch';

export interface SpendRequest {
  runId: string;
  estimatedTokens: number;
  estimatedCostCents: number;
  toolDepth: number;
}

export interface BudgetDecision {
  outcome: SpendOutcome;
  reason?: string;
}

export interface BudgetPort {
  authorize(req: SpendRequest): BudgetDecision;
  commit(req: SpendRequest): void;
}

/* ── candidates & quota ───────────────────────────────────────────────────── */

/**
 * Pre-scored by T2. Declared locally on purpose: T3 must not import T2's module
 * to know what a candidate is, or the two tiers cannot be changed independently.
 */
export interface T3Candidate {
  id: string;
  question: string;
  /** Higher is better. A rank, never a threshold. */
  score: number;
  subjectRefs: readonly string[];
  estimatedTokens: number;
  estimatedCostCents: number;
}

export interface T3Limits {
  maxRunsPerDay: number;
  maxSpendCentsPerDay: number;
  maxToolDepth: number;
}

/**
 * Deliberately small, matching the env defaults' philosophy that a wrong config
 * should cost pennies and stop.
 *
 * - maxRunsPerDay 3 — T3 is for questions worth a deep run, and there are not
 *   three of those most days. A fourth is far more likely to be a scheduling
 *   bug than a fourth good question.
 * - maxSpendCentsPerDay 1200 — 60% of the TMOS_MAX_DAILY_COST_CENTS default
 *   (2000c). T0-T2 run continuously and must not be starved by one deep run;
 *   the remaining 800c/day is theirs. It also puts the average T3 run at 400c.
 * - maxToolDepth 4 — enough for search → fetch → extract → one follow-up, and
 *   four levels below the TMOS_MAX_TOOL_DEPTH default of 8, so a runaway is
 *   caught here with headroom rather than at the global backstop.
 */
export const T3_DEFAULT_LIMITS: T3Limits = {
  maxRunsPerDay: 3,
  maxSpendCentsPerDay: 1_200,
  maxToolDepth: 4,
};

/** Mutable per-day ledger. The caller owns it so it survives across calls. */
export interface T3Quota {
  day: string;
  runsUsed: number;
  spendCentsUsed: number;
}

export const createT3Quota = (day: string): T3Quota => ({ day, runsUsed: 0, spendCentsUsed: 0 });

/* ── results ──────────────────────────────────────────────────────────────── */

export interface T3Promotion {
  candidateId: string;
  runId: string;
  status: 'ok' | 'failed';
  costCents: number;
  tokens: number;
  detail: string | null;
}

export type T3DeferralReason =
  'quota_runs_exhausted' | 'quota_spend_exhausted' | 'aborted_after_block';

export interface T3Deferral {
  candidateId: string;
  reason: T3DeferralReason;
}

export interface T3Block {
  candidateId: string;
  outcome: SpendOutcome;
  reason: string;
}

export interface T3Accounting {
  runsUsed: number;
  runsRemaining: number;
  authorizedCents: number;
  committedCents: number;
  authorizedTokens: number;
  committedTokens: number;
  spendRemainingCents: number;
}

export interface T3Exhaustion {
  by: 'runs' | 'spend' | 'budget_port';
  detail: string;
}

export interface T3Result {
  promoted: readonly T3Promotion[];
  deferred: readonly T3Deferral[];
  blocked: readonly T3Block[];
  accounting: T3Accounting;
  /** The signal a reader needs: this answer is short because we ran out, not
   *  because there was nothing more to find. */
  quotaExhausted: boolean;
  exhaustion: T3Exhaustion | null;
}

export interface T3Execution {
  actualTokens: number;
  actualCostCents: number;
}

export interface T3ExecContext {
  runId: string;
  toolDepth: number;
}

export type T3Executor = (c: T3Candidate, ctx: T3ExecContext) => Promise<T3Execution>;

export interface T3Deps {
  budget: BudgetPort;
  /** Injected — no Date.now() in library code. */
  clock: () => Date;
  execute: T3Executor;
}

export interface T3Args {
  runId: string;
  candidates: readonly T3Candidate[];
  quota: T3Quota;
  limits: T3Limits;
  deps: T3Deps;
}

/* ── ranking ──────────────────────────────────────────────────────────────── */

/** Score descending, id ascending. Total and stable: no tie can reorder. */
export const rankCandidates = (candidates: readonly T3Candidate[]): T3Candidate[] =>
  [...candidates].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/* ── the run ──────────────────────────────────────────────────────────────── */

export async function runT3(args: T3Args): Promise<T3Result> {
  const { runId, quota, limits, deps } = args;

  // Day rollover before any accounting, so a run at 00:01 is not refused by
  // yesterday's ledger.
  const today = utcDay(deps.clock());
  if (quota.day !== today) {
    quota.day = today;
    quota.runsUsed = 0;
    quota.spendCentsUsed = 0;
  }

  const promoted: T3Promotion[] = [];
  const deferred: T3Deferral[] = [];
  const blocked: T3Block[] = [];
  let authorizedCents = 0;
  let authorizedTokens = 0;
  let committedCents = 0;
  let committedTokens = 0;
  let exhaustion: T3Exhaustion | null = null;
  let aborted = false;
  let spendStopped = false;

  const runsLeft = () => limits.maxRunsPerDay - quota.runsUsed;
  const spendLeft = () => limits.maxSpendCentsPerDay - quota.spendCentsUsed;

  for (const c of rankCandidates(args.candidates)) {
    if (aborted) {
      deferred.push({ candidateId: c.id, reason: 'aborted_after_block' });
      continue;
    }
    if (runsLeft() <= 0) {
      exhaustion ??= { by: 'runs', detail: `${limits.maxRunsPerDay} T3 runs used today` };
      deferred.push({ candidateId: c.id, reason: 'quota_runs_exhausted' });
      continue;
    }
    if (spendStopped || c.estimatedCostCents > spendLeft()) {
      // Stop here, and stay stopped. See the header: once the top-ranked
      // candidate no longer fits, promoting the cheap ones behind it is the
      // silent downgrade this tier exists to refuse.
      spendStopped = true;
      exhaustion ??= {
        by: 'spend',
        detail: `${c.estimatedCostCents}c needed, ${spendLeft()}c of ${limits.maxSpendCentsPerDay}c left today`,
      };
      deferred.push({ candidateId: c.id, reason: 'quota_spend_exhausted' });
      continue;
    }

    const candidateRunId = `${runId}:${c.id}`;
    const request: SpendRequest = {
      runId: candidateRunId,
      estimatedTokens: c.estimatedTokens,
      estimatedCostCents: c.estimatedCostCents,
      toolDepth: limits.maxToolDepth,
    };

    const decision = deps.budget.authorize(request);
    if (decision.outcome !== 'allowed') {
      // Nothing was spent, so nothing is committed and no quota is consumed.
      // The refusal is terminal for this pass: retrying the next candidate
      // against a ceiling we have just hit is how a limiter becomes a loop.
      blocked.push({ candidateId: c.id, outcome: decision.outcome, reason: decision.reason ?? '' });
      exhaustion ??= { by: 'budget_port', detail: `${decision.outcome}: ${decision.reason ?? ''}` };
      aborted = true;
      continue;
    }

    authorizedCents += c.estimatedCostCents;
    authorizedTokens += c.estimatedTokens;

    let actual: T3Execution;
    let status: 'ok' | 'failed' = 'ok';
    let detail: string | null = null;
    try {
      actual = await deps.execute(c, { runId: candidateRunId, toolDepth: limits.maxToolDepth });
    } catch (err) {
      // A run that started and threw still consumed tokens upstream. Commit the
      // estimate: over-reporting spend costs us a slot, under-reporting costs
      // money, and only one of those is recoverable.
      status = 'failed';
      detail = err instanceof Error ? err.message : String(err);
      actual = { actualTokens: c.estimatedTokens, actualCostCents: c.estimatedCostCents };
    }

    deps.budget.commit({
      runId: candidateRunId,
      estimatedTokens: actual.actualTokens,
      estimatedCostCents: actual.actualCostCents,
      toolDepth: limits.maxToolDepth,
    });
    committedCents += actual.actualCostCents;
    committedTokens += actual.actualTokens;
    quota.runsUsed += 1;
    quota.spendCentsUsed += actual.actualCostCents;

    promoted.push({
      candidateId: c.id,
      runId: candidateRunId,
      status,
      costCents: actual.actualCostCents,
      tokens: actual.actualTokens,
      detail,
    });
  }

  // Exhaustion is reported even when nothing was left to defer, so a caller can
  // tell "we answered everything" from "we ran out at the same moment".
  if (!exhaustion && runsLeft() <= 0) {
    exhaustion = { by: 'runs', detail: `${limits.maxRunsPerDay} T3 runs used today` };
  }
  if (!exhaustion && spendLeft() <= 0) {
    exhaustion = { by: 'spend', detail: `${limits.maxSpendCentsPerDay}c T3 budget used today` };
  }

  return {
    promoted,
    deferred,
    blocked,
    accounting: {
      runsUsed: quota.runsUsed,
      runsRemaining: Math.max(0, runsLeft()),
      authorizedCents,
      committedCents,
      authorizedTokens,
      committedTokens,
      spendRemainingCents: Math.max(0, spendLeft()),
    },
    quotaExhausted: exhaustion !== null,
    exhaustion,
  };
}
