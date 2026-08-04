import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BudgetDecision,
  BudgetPort,
  SpendRequest,
  T3Candidate,
  T3Executor,
} from './t3-orchestrator.js';
import { T3_DEFAULT_LIMITS, createT3Quota, rankCandidates, runT3 } from './t3-orchestrator.js';

const FIXED = new Date('2026-08-01T10:00:00Z');
const clock = () => FIXED;

const cand = (id: string, score: number, cost = 100, tokens = 5_000): T3Candidate => ({
  id,
  question: `q-${id}`,
  score,
  subjectRefs: [`company:${id}`],
  estimatedTokens: tokens,
  estimatedCostCents: cost,
});

/** An always-allowing port, plus a ledger so the test can see what was asked. */
function permissivePort() {
  const authorized: SpendRequest[] = [];
  const committed: SpendRequest[] = [];
  const port: BudgetPort = {
    authorize(req) {
      authorized.push(req);
      return { outcome: 'allowed' };
    },
    commit(req) {
      committed.push(req);
    },
  };
  return { port, authorized, committed };
}

/** Blocks on the Nth authorize call — the mid-run abort case. */
function blockingPort(blockOnCall: number, decision: BudgetDecision) {
  const authorized: SpendRequest[] = [];
  const committed: SpendRequest[] = [];
  const port: BudgetPort = {
    authorize(req) {
      authorized.push(req);
      return authorized.length === blockOnCall ? decision : { outcome: 'allowed' };
    },
    commit(req) {
      committed.push(req);
    },
  };
  return { port, authorized, committed };
}

const executor =
  (costs: Record<string, { cents: number; tokens: number }> = {}): T3Executor =>
  async (c) => ({
    actualCostCents: costs[c.id]?.cents ?? c.estimatedCostCents,
    actualTokens: costs[c.id]?.tokens ?? c.estimatedTokens,
  });

let quota: ReturnType<typeof createT3Quota>;
beforeEach(() => {
  quota = createT3Quota('2026-08-01');
});

describe('competitive ranking', () => {
  it('ranks by score desc with a stable id tiebreak', () => {
    const ordered = rankCandidates([cand('b', 0.5), cand('a', 0.5), cand('c', 0.9)]);
    expect(ordered.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('promotes the highest-ranked candidates, not everything above a threshold', async () => {
    const res = await runT3({
      runId: 'run-1',
      candidates: [cand('low', 0.1), cand('high', 0.9), cand('mid', 0.5)],
      quota,
      limits: { maxRunsPerDay: 2, maxSpendCentsPerDay: 10_000, maxToolDepth: 4 },
      deps: { budget: permissivePort().port, clock, execute: executor() },
    });

    expect(res.promoted.map((p) => p.candidateId)).toEqual(['high', 'mid']);
    expect(res.deferred.map((d) => d.candidateId)).toEqual(['low']);
  });
});

describe('hard daily quota', () => {
  it('makes run exhaustion VISIBLE and stops promoting', async () => {
    const res = await runT3({
      runId: 'run-1',
      candidates: [cand('a', 0.9), cand('b', 0.8), cand('c', 0.7)],
      quota,
      limits: { maxRunsPerDay: 1, maxSpendCentsPerDay: 10_000, maxToolDepth: 4 },
      deps: { budget: permissivePort().port, clock, execute: executor() },
    });

    expect(res.quotaExhausted).toBe(true);
    expect(res.exhaustion).toMatchObject({ by: 'runs' });
    expect(res.promoted).toHaveLength(1);
    expect(res.deferred.map((d) => d.reason)).toEqual([
      'quota_runs_exhausted',
      'quota_runs_exhausted',
    ]);
    expect(res.accounting.runsRemaining).toBe(0);
  });

  it('stops promoting on spend exhaustion rather than dropping to cheaper work', async () => {
    const res = await runT3({
      runId: 'run-1',
      // 'cheap' would fit in the leftover budget. Promoting it instead of
      // stopping is exactly the silent quality degradation this tier forbids.
      candidates: [cand('big', 0.9, 800), cand('alsobig', 0.8, 800), cand('cheap', 0.1, 5)],
      quota,
      limits: { maxRunsPerDay: 9, maxSpendCentsPerDay: 1_000, maxToolDepth: 4 },
      deps: { budget: permissivePort().port, clock, execute: executor() },
    });

    expect(res.promoted.map((p) => p.candidateId)).toEqual(['big']);
    expect(res.quotaExhausted).toBe(true);
    expect(res.exhaustion).toMatchObject({ by: 'spend' });
    expect(res.deferred.map((d) => d.candidateId)).toEqual(['alsobig', 'cheap']);
    expect(res.deferred.every((d) => d.reason === 'quota_spend_exhausted')).toBe(true);
  });

  it('carries quota across calls in the same UTC day and resets on rollover', async () => {
    const args = {
      runId: 'run-1',
      candidates: [cand('a', 0.9)],
      quota,
      limits: { maxRunsPerDay: 1, maxSpendCentsPerDay: 10_000, maxToolDepth: 4 },
      deps: { budget: permissivePort().port, clock, execute: executor() },
    };
    const first = await runT3(args);
    expect(first.promoted).toHaveLength(1);

    const second = await runT3({ ...args, candidates: [cand('b', 0.9)] });
    expect(second.promoted).toHaveLength(0);
    expect(second.quotaExhausted).toBe(true);

    const nextDay = await runT3({
      ...args,
      candidates: [cand('c', 0.9)],
      deps: { ...args.deps, clock: () => new Date('2026-08-02T00:01:00Z') },
    });
    expect(nextDay.promoted.map((p) => p.candidateId)).toEqual(['c']);
  });

  it('defaults are conservative and inside the shared daily ceiling', () => {
    expect(T3_DEFAULT_LIMITS.maxRunsPerDay).toBeLessThanOrEqual(5);
    // TMOS_MAX_DAILY_COST_CENTS defaults to 2000c; T3 may not claim all of it.
    expect(T3_DEFAULT_LIMITS.maxSpendCentsPerDay).toBeLessThan(2_000);
    // TMOS_MAX_TOOL_DEPTH defaults to 8; T3 stops well before the backstop.
    expect(T3_DEFAULT_LIMITS.maxToolDepth).toBeLessThan(8);
  });
});

describe('budget port', () => {
  it('routes every promotion through authorize and commits only what ran', async () => {
    const { port, authorized, committed } = permissivePort();
    const res = await runT3({
      runId: 'run-1',
      candidates: [cand('a', 0.9, 100, 5_000)],
      quota,
      limits: T3_DEFAULT_LIMITS,
      deps: { budget: port, clock, execute: executor({ a: { cents: 60, tokens: 3_000 } }) },
    });

    expect(authorized).toHaveLength(1);
    expect(authorized[0]).toMatchObject({
      runId: 'run-1:a',
      estimatedCostCents: 100,
      toolDepth: T3_DEFAULT_LIMITS.maxToolDepth,
    });
    expect(committed[0]).toMatchObject({ estimatedCostCents: 60, estimatedTokens: 3_000 });
    expect(res.accounting.authorizedCents).toBe(100);
    expect(res.accounting.committedCents).toBe(60);
  });

  it('a blocked_daily_cost mid-run aborts without corrupting accounting', async () => {
    const { port, committed } = blockingPort(2, {
      outcome: 'blocked_daily_cost',
      reason: 'daily spend would reach 2100c, ceiling 2000c',
    });
    const res = await runT3({
      runId: 'run-1',
      candidates: [cand('a', 0.9, 100), cand('b', 0.8, 100), cand('c', 0.7, 100)],
      quota,
      limits: { maxRunsPerDay: 9, maxSpendCentsPerDay: 10_000, maxToolDepth: 4 },
      deps: { budget: port, clock, execute: executor() },
    });

    expect(res.promoted.map((p) => p.candidateId)).toEqual(['a']);
    expect(res.blocked).toEqual([
      {
        candidateId: 'b',
        outcome: 'blocked_daily_cost',
        reason: 'daily spend would reach 2100c, ceiling 2000c',
      },
    ]);
    // The blocked candidate was authorized-and-refused: it must not appear in
    // either authorized or committed totals, and 'c' must never be attempted.
    expect(res.accounting.authorizedCents).toBe(100);
    expect(res.accounting.committedCents).toBe(100);
    expect(committed).toHaveLength(1);
    expect(res.deferred).toEqual([{ candidateId: 'c', reason: 'aborted_after_block' }]);
    expect(res.quotaExhausted).toBe(true);
    expect(res.exhaustion).toMatchObject({ by: 'budget_port' });
    // Quota state reflects exactly the one run that actually happened.
    expect(quota.runsUsed).toBe(1);
    expect(quota.spendCentsUsed).toBe(100);
  });

  it('surfaces a tool-depth block from the port and promotes nothing', async () => {
    const { port } = blockingPort(1, {
      outcome: 'blocked_tool_depth',
      reason: 'tool depth 12 exceeds 8',
    });
    const res = await runT3({
      runId: 'run-1',
      candidates: [cand('a', 0.9)],
      quota,
      limits: { maxRunsPerDay: 3, maxSpendCentsPerDay: 5_000, maxToolDepth: 12 },
      deps: { budget: port, clock, execute: executor() },
    });
    expect(res.promoted).toHaveLength(0);
    expect(res.blocked[0]).toMatchObject({ outcome: 'blocked_tool_depth' });
    expect(quota.runsUsed).toBe(0);
  });

  it('counts a failed execution as spent — never under-report a run we started', async () => {
    const { port } = permissivePort();
    const res = await runT3({
      runId: 'run-1',
      candidates: [cand('a', 0.9, 100)],
      quota,
      limits: T3_DEFAULT_LIMITS,
      deps: {
        budget: port,
        clock,
        execute: async () => {
          throw new Error('worker pool died');
        },
      },
    });
    expect(res.promoted[0]).toMatchObject({ candidateId: 'a', status: 'failed' });
    expect(res.accounting.committedCents).toBe(100);
    expect(quota.runsUsed).toBe(1);
  });
});

describe('determinism', () => {
  it('same inputs produce an identical result', async () => {
    const run = async () =>
      runT3({
        runId: 'run-1',
        candidates: [cand('b', 0.5), cand('a', 0.5), cand('c', 0.9)],
        quota: createT3Quota('2026-08-01'),
        limits: { maxRunsPerDay: 2, maxSpendCentsPerDay: 10_000, maxToolDepth: 4 },
        deps: { budget: permissivePort().port, clock, execute: executor() },
      });
    expect(await run()).toEqual(await run());
  });

  it('an empty candidate list is not an exhausted quota', async () => {
    const res = await runT3({
      runId: 'run-1',
      candidates: [],
      quota,
      limits: T3_DEFAULT_LIMITS,
      deps: { budget: permissivePort().port, clock, execute: executor() },
    });
    expect(res.quotaExhausted).toBe(false);
    expect(res.exhaustion).toBeNull();
  });
});
