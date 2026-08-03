import { describe, it, expect } from 'vitest';
import {
  authorizeSpend,
  commitSpend,
  createBudgetState,
  engageKillswitch,
  type BudgetLimits,
} from './budget.js';

const limits: BudgetLimits = {
  maxRunTokens: 100_000,
  maxDailyCostCents: 2_000, // $20/day
  maxToolDepth: 8,
};

const req = (over: Partial<Parameters<typeof authorizeSpend>[2]> = {}) => ({
  runId: 'run-1',
  estimatedTokens: 1_000,
  estimatedCostCents: 10,
  toolDepth: 1,
  ...over,
});

describe('budget chokepoint', () => {
  it('allows a call inside every ceiling', () => {
    expect(authorizeSpend(createBudgetState(), limits, req()).outcome).toBe('allowed');
  });

  it('BLOCKS when the run token ceiling would be breached', () => {
    const s = createBudgetState();
    commitSpend(s, req({ estimatedTokens: 99_500 }));
    const d = authorizeSpend(s, limits, req({ estimatedTokens: 1_000 }));
    expect(d.outcome).toBe('blocked_run_tokens');
    expect(d.reason).toContain('ceiling');
  });

  it('BLOCKS when the daily dollar ceiling would be breached', () => {
    const s = createBudgetState();
    commitSpend(s, req({ estimatedCostCents: 1_995 }));
    expect(authorizeSpend(s, limits, req({ estimatedCostCents: 10 })).outcome).toBe(
      'blocked_daily_cost',
    );
  });

  it('BLOCKS runaway tool recursion', () => {
    expect(authorizeSpend(createBudgetState(), limits, req({ toolDepth: 9 })).outcome).toBe(
      'blocked_tool_depth',
    );
  });

  it('BLOCKS everything once the killswitch is engaged', () => {
    const s = createBudgetState();
    engageKillswitch(s);
    expect(authorizeSpend(s, limits, req()).outcome).toBe('blocked_killswitch');
  });

  it('isolates ceilings per run — one run cannot exhaust another', () => {
    const s = createBudgetState();
    commitSpend(s, req({ runId: 'run-a', estimatedTokens: 99_999 }));
    expect(authorizeSpend(s, limits, req({ runId: 'run-b' })).outcome).toBe('allowed');
  });

  it('resets the daily ledger on UTC day rollover', () => {
    const s = createBudgetState('2026-08-02');
    commitSpend(s, req({ estimatedCostCents: 1_999 }));
    const d = authorizeSpend(s, limits, req(), new Date('2026-08-03T00:05:00Z'));
    expect(d.outcome).toBe('allowed');
    expect(s.dailyCostCents).toBe(0);
  });

  it('does not record spend for a refused call', () => {
    const s = createBudgetState();
    engageKillswitch(s);
    authorizeSpend(s, limits, req());
    expect(s.dailyCostCents).toBe(0);
  });
});
