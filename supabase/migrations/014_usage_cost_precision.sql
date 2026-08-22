-- 014 — the spend ledger could not represent what a call costs.
--
-- `ai_usage_log.cost_cents` was `int`. A triage call over twenty headlines on
-- the small model costs about 0.025¢, which rounds to ZERO — so six real calls
-- wrote six rows totalling 0¢, and `composition.ts` reconstructed the day's
-- spend as 0 no matter how much had actually been spent.
--
-- That is worse than the bug 012 set out to fix. 012 created this table so the
-- daily ceiling would survive a restart; at integer precision it survives as a
-- number that is always zero, which is a ceiling that never binds while looking
-- like one that does.
--
-- numeric, not micro-cents-as-int: `budget.ts` compares against
-- `maxDailyCostCents` in cents, and a unit that only the ledger understands is
-- the kind of mismatch that produced the 10x cost-table error already fixed
-- this week.
alter table ai_usage_log
  alter column cost_cents type numeric(14, 6) using cost_cents::numeric;

comment on column ai_usage_log.cost_cents is
  'Cents, fractional. A small-model triage call is ~0.025 — an integer column '
  'rounded every real call to 0 and made the daily ceiling unenforceable.';
