-- 006 — two gaps found while building the world model, each caught by a
-- different part of it, neither fixable from application code.

-- ── 1. an ER label pair must be unique, unordered ───────────────────────────
-- `er_label` is not a log. It is the regression suite and the calibration set:
-- thresholds are fitted against it and every precision number quoted about
-- entity resolution is computed from it.
--
-- Without a uniqueness constraint the table happily accepts (A,B)='match' and
-- (B,A)='no_match'. Nothing errors. The pair is simply counted twice, once as a
-- true positive and once as a false one, and every precision figure derived
-- from the set is quietly wrong — including the ones used to decide where the
-- auto-merge threshold goes. A calibration set that can silently disagree with
-- itself is worse than no calibration set, because it still produces a number.
--
-- The pair is UNDIRECTED: labelling (A,B) is labelling (B,A). Indexing on
-- least/greatest enforces that without forcing every caller to remember to sort
-- its arguments first.
create unique index if not exists er_label_pair_uidx
  on er_label (least(left_entity, right_entity), greatest(left_entity, right_entity));

comment on index er_label_pair_uidx is
  'One human verdict per unordered entity pair. Re-labelling is an UPDATE (or an explicit delete + insert), never a second row — two contradictory rows would silently corrupt every ER precision number.';

-- A pair is also never a self-match; that row is always a mistake and it would
-- inflate precision with a free true positive.
alter table er_label drop constraint if exists er_label_not_self;
alter table er_label add constraint er_label_not_self check (left_entity <> right_entity);

-- ── 2. a real boundary for the analytical escape hatch ──────────────────────
-- `runAnalyticalQuery` (packages/world/src/query/tools.ts) rejects anything that
-- is not a single read-only SELECT, using keyword and shape checks. Those checks
-- are defence in depth and nothing more. Parser-level blocklists are routinely
-- bypassed, and ours is a regex over a string.
--
-- The boundary that actually holds is the one the database enforces: a role that
-- has no write privilege to lose. If the blocklist is defeated, the query still
-- cannot write, because the grants do not exist.
--
-- This role deliberately has NOLOGIN and no password. Credentials do not belong
-- in a migration in a repository. Provision a login role out of band and grant
-- it membership:
--
--     create role tmos_analyst_login login password '…';
--     grant tmos_analyst to tmos_analyst_login;
--
-- Then point ONLY the analytical executor at it. The application's normal
-- connection must keep using its own role — routing writes through this one
-- would defeat the entire purpose.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tmos_analyst') then
    create role tmos_analyst nologin;
  end if;
end $$;

revoke all on all tables in schema public from tmos_analyst;
grant usage on schema public to tmos_analyst;

-- Read-only, and explicitly enumerated. `grant select on all tables` would also
-- hand over any future table, including ones added for a reason that has nothing
-- to do with analysis.
grant select on entity, entity_identifier, fact, fact_conflict, predicate_def, source to tmos_analyst;

-- No access to anything holding a belief we have not published, our own
-- decisions, or consent records — an ad-hoc query is exploration, not an
-- audit path.
revoke all on belief, belief_update, prediction, decision_record, consent from tmos_analyst;

-- A runaway analytical query is a denial of service against the whole system.
-- The tool takes a statementTimeoutMs parameter, but that is set by the caller;
-- this one cannot be raised by the session using it.
alter role tmos_analyst set statement_timeout = '30s';
alter role tmos_analyst set idle_in_transaction_session_timeout = '60s';
-- Belt and braces: even if a write grant is added by mistake later, the role
-- cannot use it.
alter role tmos_analyst set default_transaction_read_only = on;

comment on role tmos_analyst is
  'Read-only role backing runAnalyticalQuery. The keyword blocklist in application code is defence in depth; THIS is the security boundary. NOLOGIN by design — grant membership to a separate login role provisioned out of band.';
