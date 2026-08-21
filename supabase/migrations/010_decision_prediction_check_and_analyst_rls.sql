-- 010 — a constraint that constrained nothing, and a role that could see
-- nothing. Both failed silently, which is why both survived review.

-- ── 1. `decision_needs_prediction` never rejected anything ──────────────────
-- 003 calls the pair of constraints on `decision_record` "the whole mechanism,
-- in two constraints". One of them was decorative.
--
--   array_length('{}'::uuid[], 1)  →  NULL
--   NULL >= 1                      →  NULL
--   a CHECK that evaluates to NULL →  PASSES
--
-- So a decision with an EMPTY prediction array inserted cleanly. Verified on
-- this database, 2026-08-22: the insert succeeded. That is the exact shape of
-- failure the constraint exists to prevent — a decision recorded with nothing
-- falsifiable attached, which is a diary entry, not a decision record. And it
-- fails open: the mechanism reports success while doing nothing.
--
-- `coalesce(..., 0)` turns the empty array into a number the comparison can
-- actually reject. The sibling `jsonb_array_length(alternatives) >= 2` has no
-- such hole — `jsonb_array_length('[]')` is 0, not NULL — and is left alone.
-- Checked every CHECK in the schema: this was the only one.
alter table decision_record drop constraint if exists decision_needs_prediction;
alter table decision_record add constraint decision_needs_prediction
  check (coalesce(array_length(prediction_ids, 1), 0) >= 1);

comment on constraint decision_needs_prediction on decision_record is
  'A decision carries at least one prediction. coalesce() is load-bearing: array_length of an empty array is NULL, and a CHECK evaluating to NULL passes.';

-- ── 2. tmos_analyst was granted SELECT and could still read nothing ─────────
-- 006 grants the analytical role SELECT on six tables. 004 enabled RLS on
-- three of them (entity, fact, source) with policies `TO service_role` and
-- nothing else.
--
-- Grants and RLS are INDEPENDENT gates and a row must clear both. The role held
-- one key to a door with two locks, so `runAnalyticalQuery` returned an empty
-- result set — not an error, not a refusal, zero rows. That is precisely the
-- silent-wrong-answer failure this role was created to make impossible: "no
-- competitor charges more than $200" and "you cannot see the price table" are
-- the same output, and only one of them is true.
--
-- Policies land on all six granted tables, not only the three with RLS on
-- today. The other three get RLS in 011, and a permission that has to be
-- remembered at the moment it starts mattering is a permission that will not be.
do $$
declare t text;
begin
  foreach t in array array['entity','entity_identifier','fact','fact_conflict',
                           'predicate_def','source']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_analyst_read', t);
    execute format(
      'create policy %I on public.%I for select to tmos_analyst using (true)',
      t || '_analyst_read', t);
  end loop;
end $$;

-- `using (true)` and SELECT-only, deliberately. The row filter is not where
-- this boundary lives — the GRANT is. There is no write policy, no write grant,
-- and `default_transaction_read_only` on the role besides; a policy that only
-- ever names SELECT cannot be widened by adding a row predicate later.
--
-- Membership, not identity: the login role is provisioned out of band and
-- granted `tmos_analyst` (006). Postgres matches a policy's role by privilege
-- inheritance, so `TO tmos_analyst` covers every member — which is the only
-- reason the out-of-band credential story works at all.

-- The golden record was granted to nobody. 005 created it AFTER 006 was
-- written, so the enumerated grant list never learned about it. An analyst that
-- can read `fact` but not `golden_record` will hand-write a worse survivorship
-- query and quote its answer — the view exposes nothing the `fact` grant does
-- not already, and being security_invoker it is bound by the policy above.
grant select on golden_record to tmos_analyst;
