import { describe, expect, it } from 'vitest';
import type { BudgetPort, SpendOutcome, SpendRequest } from './chat.js';
import {
  ACCEPTANCE_TTL_MS,
  CEILING_MULTIPLIER,
  acceptEstimate,
  createRunLedger,
  estimate,
  estimateAccuracy,
  startRun,
  type Acceptance,
  type CancelToken,
  type ResearchPort,
  type ResearchRequest,
  type RunDeps,
  type RunReport,
} from './deep-research.js';

const T0 = '2026-08-05T12:00:00.000Z';
const at = (msAfterT0 = 0) => new Date(Date.parse(T0) + msAfterT0);

const request = (over: Partial<ResearchRequest> = {}): ResearchRequest => ({
  investigationId: 'inv-1',
  question: 'Did any GTA competitor change what they charge posters this month?',
  tier: 't2_correlate',
  sourceCount: 10,
  maxCostCents: 500,
  ...over,
});

const fakeBudget = (outcome: SpendOutcome = 'allowed') => {
  const committed: SpendRequest[] = [];
  const port: BudgetPort = {
    authorize: () => (outcome === 'allowed' ? { outcome } : { outcome, reason: 'day ceiling hit' }),
    commit: (r) => {
      committed.push(r);
    },
  };
  const spentCents = () => committed.reduce((n, r) => n + r.estimatedCostCents, 0);
  return { port, committed, spentCents };
};

/** `count` steps, each costing `costCents`. Cost is fixed so a run's actual
 *  spend is a fact of the test, not of a random walk. */
const fakePort = (count: number, costCents: number): ResearchPort => ({
  plan: () =>
    Array.from({ length: count }, (_, i) => ({
      label: `step ${i + 1}`,
      run: () => Promise.resolve({ costCents, tokens: costCents * 100, note: `note ${i + 1}` }),
    })),
});

const depsOf = (over: Partial<RunDeps> = {}): RunDeps => ({
  research: fakePort(4, 25),
  budget: fakeBudget().port,
  ledger: createRunLedger(),
  now: () => at(),
  ...over,
});

const accepted = (req = request(), acceptedAt = at()): Acceptance =>
  acceptEstimate({ token: 'tok-1', estimate: estimate(req), at: acceptedAt });

describe('estimate', () => {
  it('is deterministic and says in plain language what it will do', () => {
    const e = estimate(request());
    expect(e).toEqual(estimate(request()));
    expect(e.estimatedCostCents).toBe(80);
    expect(e.estimatedLatencyMs).toBe(20_000);
    expect(e.tier).toBe('t2_correlate');
    expect(e.whatItWillDo).toMatch(/cross-check/i);
    expect(e.whatItWillDo).toContain('10 sources');
    expect(e.whatItWillDo).toContain('$0.80');
    // The ceiling is part of what the reader is shown, not fine print.
    expect(e.whatItWillDo).toContain('$1.20');
    expect(e.ceilingCents).toBe(Math.ceil(80 * CEILING_MULTIPLIER));
  });

  it('never lets the ceiling exceed the investigation cap', () => {
    expect(estimate(request({ maxCostCents: 90 })).ceilingCents).toBe(90);
  });
});

describe('startRun — acceptance', () => {
  it('rejects an acceptance whose estimate has drifted', async () => {
    const acc = accepted(request({ sourceCount: 10 }));
    const r = await startRun(request({ sourceCount: 40 }), acc, depsOf());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('estimate_drifted');
    // The reader accepted 80c; the run would have cost 260c. Both must be named.
    expect(r.detail).toContain('80');
    expect(r.detail).toContain('260');
  });

  it('rejects an acceptance older than the window', async () => {
    const acc = accepted(request(), at(0));
    const deps = depsOf({ now: () => at(ACCEPTANCE_TTL_MS + 1) });
    const r = await startRun(request(), acc, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('acceptance_expired');
  });

  it('accepts one still inside the window', async () => {
    const acc = accepted(request(), at(0));
    const r = await startRun(request(), acc, depsOf({ now: () => at(ACCEPTANCE_TTL_MS - 1) }));
    expect(r.ok).toBe(true);
  });

  it('rejects an acceptance for a different investigation', async () => {
    const acc = accepted(request({ investigationId: 'inv-2' }));
    const r = await startRun(request(), acc, depsOf());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('wrong_investigation');
  });

  it('refuses when the investigation cap sits below the estimate', async () => {
    const req = request({ maxCostCents: 50 });
    const r = await startRun(req, accepted(req), depsOf());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('ceiling_below_estimate');
  });

  it('cannot start two runs from the same acceptance token', async () => {
    const acc = accepted();
    const budget = fakeBudget();
    const deps = depsOf({ ledger: createRunLedger(), budget: budget.port });
    const first = await startRun(request(), acc, deps);
    const second = await startRun(request(), acc, deps);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('duplicate_acceptance');
    expect(budget.spentCents()).toBe(100);
  });
});

describe('startRun — spend', () => {
  it('surfaces blocked_daily_cost rather than swallowing it', async () => {
    const budget = fakeBudget('blocked_daily_cost');
    const r = await startRun(request(), accepted(), depsOf({ budget: budget.port }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('budget_blocked');
    expect(r.budgetOutcome).toBe('blocked_daily_cost');
    expect(r.detail).toContain('day ceiling hit');
    expect(budget.spentCents()).toBe(0);
  });

  it('aborts at the ceiling instead of continuing, and keeps the spend honest', async () => {
    const budget = fakeBudget();
    const deps = depsOf({ research: fakePort(6, 25), budget: budget.port });
    const r = await startRun(request(), accepted(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.outcome).toBe('aborted_ceiling');
    expect(r.report.stepsCompleted).toBe(5);
    expect(r.report.stepsPlanned).toBe(6);
    expect(r.report.actualCostCents).toBe(125);
    expect(budget.spentCents()).toBe(125);
  });

  it('commits spend already incurred when cancelled', async () => {
    const budget = fakeBudget();
    let steps = 0;
    const cancel: CancelToken = { cancelled: () => steps >= 2 };
    const research: ResearchPort = {
      plan: () =>
        Array.from({ length: 4 }, (_, i) => ({
          label: `step ${i + 1}`,
          run: () => {
            steps += 1;
            return Promise.resolve({ costCents: 25, tokens: 2500, note: `note ${i + 1}` });
          },
        })),
    };
    const r = await startRun(
      request(),
      accepted(),
      depsOf({ research, budget: budget.port, cancel }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.outcome).toBe('cancelled');
    expect(r.report.stepsCompleted).toBe(2);
    // Cancelling does not make the first two steps free.
    expect(budget.spentCents()).toBe(50);
    expect(r.report.actualCostCents).toBe(50);
  });

  it('reports actual against estimated', async () => {
    const r = await startRun(request(), accepted(), depsOf());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.outcome).toBe('completed');
    expect(r.report.estimatedCostCents).toBe(80);
    expect(r.report.actualCostCents).toBe(100);
    expect(r.report.costRatio).toBe(1.25);
    expect(r.report.notes).toEqual(['note 1', 'note 2', 'note 3', 'note 4']);
  });

  it('emits progress a caller can render', async () => {
    const seen: string[] = [];
    const deps = depsOf({
      onProgress: (p) => seen.push(`${p.stepIndex}/${p.stepCount} ${p.label}`),
    });
    await startRun(request(), accepted(), deps);
    expect(seen).toEqual(['1/4 step 1', '2/4 step 2', '3/4 step 3', '4/4 step 4']);
  });
});

describe('estimateAccuracy', () => {
  const report = (estimated: number, actual: number): RunReport => ({
    token: 't',
    investigationId: 'inv-1',
    outcome: 'completed',
    estimatedCostCents: estimated,
    actualCostCents: actual,
    costRatio: Number((actual / estimated).toFixed(2)),
    stepsCompleted: 1,
    stepsPlanned: 1,
    notes: [],
  });

  it('shows a repeated under-estimate rather than hiding it in an average', () => {
    const a = estimateAccuracy([report(100, 200), report(100, 250), report(100, 300)]);
    expect(a.runs).toBe(3);
    expect(a.medianRatio).toBe(2.5);
    expect(a.worstRatio).toBe(3);
    expect(a.systematicUnderEstimate).toBe(true);
  });

  it('does not call one overrun systematic', () => {
    const a = estimateAccuracy([report(100, 95), report(100, 300), report(100, 90)]);
    expect(a.medianRatio).toBe(0.95);
    expect(a.systematicUnderEstimate).toBe(false);
  });

  it('ignores runs that spent nothing', () => {
    expect(estimateAccuracy([report(100, 0)]).runs).toBe(0);
  });
});
