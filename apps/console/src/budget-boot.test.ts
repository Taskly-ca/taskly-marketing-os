/**
 * THE CEILING THAT WAS NEVER A CEILING.
 *
 * `BudgetState` is a number in a process. `maxDailyCostCents` therefore bounded
 * spend per PROCESS LIFETIME, not per UTC day — migration 012 says so in as
 * many words, and it is worse than that here: `createAsk` mints a FRESH
 * `createBudgetState()` for every run, so even two answers in one process each
 * got the whole $20. Restart the console twice and the "daily" ceiling has been
 * handed out three times.
 *
 * `ai_usage_log` exists for exactly this. These tests cover the arithmetic that
 * turns the day's committed rows back into a ledger — the database read itself
 * is a one-line query and is not what goes wrong.
 */
import { describe, expect, it } from 'vitest';

import type { BudgetLimits } from '@tmos/shared';

import { noteSpend, refuseForBudget, seedBudgetState } from './budget-boot.js';

const LIMITS: BudgetLimits = {
  maxRunTokens: 100_000,
  maxDailyCostCents: 2_000,
  maxToolDepth: 4,
};

const at = (iso: string): Date => new Date(iso);

describe('seedBudgetState', () => {
  it('starts the day already holding what the ledger says was spent', () => {
    const state = seedBudgetState(1_450, '2026-08-31');
    expect(state.dailyCostCents).toBe(1_450);
    expect(state.day).toBe('2026-08-31');
    // A boot is not a killswitch reset, and it inherits no run ledger: the
    // per-run token cap belongs to a run in flight, and none is.
    expect(state.killswitch).toBe(false);
    expect(state.runTokens.size).toBe(0);
  });

  it('never seeds a negative or fractional ledger', () => {
    // `sum()` over an empty day is null, and a caller coercing that lands on
    // NaN — which compares false against every ceiling and un-caps the day.
    expect(seedBudgetState(Number.NaN, '2026-08-31').dailyCostCents).toBe(0);
    expect(seedBudgetState(-5, '2026-08-31').dailyCostCents).toBe(0);
    expect(seedBudgetState(12.7, '2026-08-31').dailyCostCents).toBe(13);
  });
});

describe('refuseForBudget', () => {
  it('allows a run when the reconstructed day leaves headroom', () => {
    const state = seedBudgetState(100, '2026-08-31');
    expect(refuseForBudget(state, LIMITS, 5, at('2026-08-31T12:00:00Z'))).toBeNull();
  });

  it('refuses — with the figures — once the day is spent', () => {
    const state = seedBudgetState(1_999, '2026-08-31');
    const refusal = refuseForBudget(state, LIMITS, 5, at('2026-08-31T12:00:00Z'));
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('2000');
  });

  it('is the whole point: yesterday’s spend refuses today’s first run before the fix', () => {
    // Without reconstruction this state reads 0 and the run proceeds. With it,
    // a console restarted at 23:00 does not get a second $20.
    const cold = seedBudgetState(0, '2026-08-31');
    const warm = seedBudgetState(2_000, '2026-08-31');
    expect(refuseForBudget(cold, LIMITS, 5, at('2026-08-31T23:00:00Z'))).toBeNull();
    expect(refuseForBudget(warm, LIMITS, 5, at('2026-08-31T23:00:00Z'))).not.toBeNull();
  });

  it('rolls over at UTC midnight rather than at process start', () => {
    const state = seedBudgetState(2_000, '2026-08-31');
    expect(refuseForBudget(state, LIMITS, 5, at('2026-09-01T00:00:01Z'))).toBeNull();
    expect(state.day).toBe('2026-09-01');
    expect(state.dailyCostCents).toBe(0);
  });
});

describe('noteSpend', () => {
  it('accumulates across runs, so two answers in one process share one ceiling', () => {
    const state = seedBudgetState(0, '2026-08-31');
    noteSpend(state, 'run-a', 900, at('2026-08-31T10:00:00Z'));
    noteSpend(state, 'run-b', 900, at('2026-08-31T10:05:00Z'));
    expect(state.dailyCostCents).toBe(1_800);
    // The third would cross the ceiling — which is the behaviour `createAsk`'s
    // per-run budget state cannot produce on its own.
    expect(refuseForBudget(state, LIMITS, 300, at('2026-08-31T10:10:00Z'))).not.toBeNull();
  });

  it('drops the previous day rather than carrying it forward', () => {
    const state = seedBudgetState(1_900, '2026-08-31');
    noteSpend(state, 'run-c', 50, at('2026-09-01T00:30:00Z'));
    expect(state.day).toBe('2026-09-01');
    expect(state.dailyCostCents).toBe(50);
  });
});
