/**
 * THE DAILY CEILING, REBUILT FROM THE LEDGER INSTEAD OF FROM ZERO.
 *
 * `BudgetState` is a number in a process (`packages/shared/src/llm/budget.ts`),
 * so `maxDailyCostCents` has never bounded a DAY. It bounds a process lifetime.
 * Migration 012 says so in its own comment — "a daily dollar ceiling that resets
 * on deploy is not a ceiling" — created `ai_usage_log` for exactly this, wrote
 * the reconstruct query into the table comment, and then nothing ever ran it.
 *
 * It is worse than one reset per restart. `createAsk` and `createAskStream`
 * each mint a FRESH `createBudgetState()` per run, deliberately, so that one
 * question's token cap is not shared with a competitor watch. The side effect is
 * that the DOLLAR ledger is not shared either: two answers in one process each
 * saw an empty day and each got the whole $20. The per-run ceiling is doing all
 * the work and the daily one is decorative.
 *
 * WHAT THIS FIXES AND WHAT IT DOES NOT. Widening `AskConfig` to accept a shared
 * `BudgetState` would fix it at the chokepoint, and that is a change inside
 * `packages/**` that every existing caller would have to follow — a serial
 * change, not this one. So the console holds ONE reconstructed state for the
 * process, checks it before starting an answer, and adds each answer's cost
 * back into it. That makes the ceiling real at the door where the expensive
 * runs are started, which is where the $20 actually goes. A run that gets past
 * the door still spends under its own per-run cap; the day's total is bounded
 * at admission rather than mid-run, and that difference is the honest limit of
 * this fix.
 *
 * THE ADAPTER NEVER READS THE CLOCK — the day is passed in, as everywhere else
 * in this repo, so "which UTC day is it" is one decision made by the caller
 * rather than three made in three files.
 */
import { db, sql, type Executor } from '@tmos/db';
import {
  authorizeSpend,
  commitSpend,
  createBudgetState,
  utcDay,
  type BudgetLimits,
  type BudgetState,
} from '@tmos/shared';

/**
 * The day's committed spend, from the table that survives a restart.
 *
 * Only `allowed` rows count, because only `allowed` reaches `commitSpend` — a
 * blocked call spent nothing and summing it would make the ceiling tighten
 * every time it fired. This is migration 012's own query, and
 * `ai_usage_day_idx` is the partial index built for it.
 *
 * `::bigint`, not `::int`: the sum of a day of int4 costs can exceed int4 even
 * though no single row can, and an overflow here throws rather than returning a
 * wrong ledger — but the coercion to a JS number happens once, here, rather than
 * leaving node-postgres's numeric-as-string to be added to a number somewhere
 * downstream and produce '0' + 5 = '05'.
 */
async function readCommittedSpendCents(day: string, ex: Executor = db()): Promise<number> {
  const row = await ex.one<{ cents: string | number }>(sql`
    select coalesce(sum(cost_cents), 0)::bigint as cents
      from ai_usage_log
     where utc_day = ${day}::date and outcome = 'allowed'`);
  return Number(row.cents);
}

/**
 * A `BudgetState` that starts the day where the ledger left it.
 *
 * The clamp is not defensive noise. `sum()` over a day with no rows is NULL,
 * and a caller that coerces NULL lands on `NaN` — which compares false against
 * every ceiling, so a broken read would silently un-cap the day rather than
 * fail. Rounding is because `cost_cents` is an integer column and a fractional
 * ledger cannot be compared honestly against an integer ceiling.
 */
export function seedBudgetState(spentCents: number, day: string): BudgetState {
  const state = createBudgetState(day);
  state.dailyCostCents = Number.isFinite(spentCents) ? Math.max(0, Math.round(spentCents)) : 0;
  return state;
}

/**
 * May a run costing roughly `estimateCents` start?
 *
 * Reuses `authorizeSpend` rather than comparing two numbers, so the day
 * rollover, the killswitch and the arithmetic are the chokepoint's and cannot
 * drift from it. `estimatedTokens` is 0 on purpose: the per-RUN token cap
 * belongs to the run's own budget state inside `createAsk`, and borrowing this
 * one's `runTokens` map would double-count against a ceiling that is already
 * enforced where the tokens are actually spent.
 *
 * Returns the reason, or null. A string is the whole result because the caller's
 * job is to put it on the wire — a refusal the reader cannot see is
 * indistinguishable from the system being broken.
 */
export function refuseForBudget(
  state: BudgetState,
  limits: BudgetLimits,
  estimateCents: number,
  now: Date,
): string | null {
  const decision = authorizeSpend(
    state,
    limits,
    { runId: 'answer:preflight', estimatedTokens: 0, estimatedCostCents: estimateCents, toolDepth: 0 },
    now,
  );
  if (decision.outcome === 'allowed') return null;
  return decision.reason ?? decision.outcome;
}

/** Add a finished run's cost to the day, so the next run sees it. */
export function noteSpend(state: BudgetState, runId: string, costCents: number, now: Date): void {
  // Rollover BEFORE the add, or a run finishing at 00:00:01 is charged to a day
  // that ended — and the new day starts already holding the old day's total.
  const today = utcDay(now);
  if (state.day !== today) {
    state.day = today;
    state.dailyCostCents = 0;
  }
  commitSpend(state, {
    runId,
    estimatedTokens: 0,
    estimatedCostCents: Math.max(0, Math.round(costCents)),
    toolDepth: 0,
  });
}

/* ── the process-wide ledger ────────────────────────────────────────────── */

let current: BudgetState | null = null;

/**
 * Read the day out of `ai_usage_log` and hold it for the process.
 *
 * Called once at boot so the first question of the day pays the read rather
 * than the founder waiting for it mid-answer. It is safe to call again: a
 * second call on the same UTC day is a no-op, and one after midnight rebuilds.
 */
export async function primeBudget(now: Date = new Date(), ex: Executor = db()): Promise<BudgetState> {
  const day = utcDay(now);
  if (current !== null && current.day === day) return current;
  current = seedBudgetState(await readCommittedSpendCents(day, ex), day);
  return current;
}

/**
 * The ledger, reconstructing it if boot could not.
 *
 * Fails OPEN — a state seeded at zero — when the table cannot be read, and says
 * so on stderr. Refusing every answer because Postgres hiccupped would be a
 * worse failure than the one this module fixes, and the per-run ceiling inside
 * `callGroq` is still in force either way: failing open puts us back where the
 * system already was, which is a known hole rather than a new one.
 */
export async function dailyBudget(now: Date = new Date(), ex: Executor = db()): Promise<BudgetState> {
  try {
    return await primeBudget(now, ex);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.warn(`budget: could not read ai_usage_log (${why}) — today's ceiling starts empty`);
    current = seedBudgetState(0, utcDay(now));
    return current;
  }
}
