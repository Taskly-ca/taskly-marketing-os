-- 011 — anon and authenticated could rewrite the calibration set.
--
-- Supabase grants SELECT/INSERT/UPDATE/DELETE to `anon` and `authenticated` on
-- every new table in `public`, by default privilege, at creation time. 004
-- enabled RLS on 9 of 21 tables. The other 12 were reachable through PostgREST
-- with nothing but the publishable key:
--
--   belief_update · brain_chunk · brain_doc · entity_identifier · er_label
--   fact_conflict · finding_feedback · playbook · playbook_run
--   predicate_def · predicate_occurrence · retention_policy
--
-- Two of those are load-bearing in a way that is worse than data loss. `er_label`
-- is the ER calibration set — every auto-merge threshold is fitted to it, and
-- 006 spends a paragraph explaining that a calibration set which can disagree
-- with itself is worse than none because it still produces a number. Anyone with
-- the key could have inserted rows into it. `predicate_def` is the semantic
-- layer every query tool reads to decide what a question even means.
--
-- The fix is not "enable RLS on the other twelve". That is the same fix as last
-- time and it failed the same way: it depends on someone remembering, once per
-- table, forever. TMOS is server-side only — no browser ever holds these keys,
-- `.env.example` asks for the SERVICE ROLE key and a direct `DATABASE_URL` —
-- so the correct posture is that these two roles have no privileges here at
-- all, and no way to acquire them by default when the next table lands.
--
-- WHAT IS DELIBERATELY NOT DONE: revoking USAGE on schema `public`. That looks
-- like the stronger lever and is not available. USAGE is held by PUBLIC
-- (`=U/pg_database_owner` in nspacl), so revoking it from anon and authenticated
-- individually changes nothing, and revoking it from PUBLIC — measured on this
-- database — also strips `authenticator`, `pgbouncer`, `supabase_auth_admin`,
-- `supabase_realtime_admin`, `supabase_replication_admin` and
-- `supabase_storage_admin`, i.e. the connection pooler and the platform. Schema
-- USAGE only lets a role REACH an object; it never grants access to one. The
-- object privileges below are the gate, which is why they must be complete.

create or replace function tmos_secure_public_schema()
returns table (tables_seen int, rls_enabled int, policies_added int)
language plpgsql
set search_path = public, pg_catalog, pg_temp
as $$
declare
  t record;
  n_seen int := 0; n_rls int := 0; n_pol int := 0;
begin
  -- 1. no privileges, present tense.
  revoke all on all tables    in schema public from anon, authenticated;
  revoke all on all sequences in schema public from anon, authenticated;
  revoke all on all routines  in schema public from anon, authenticated;

  -- 2. every table carries RLS and a service_role policy. Belt to the grants'
  --    braces: if a grant is ever restored by hand or by the platform, the row
  --    filter is still there and still says service_role only.
  for t in
    select c.oid, c.relname, c.relrowsecurity
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'r'
     order by c.relname
  loop
    n_seen := n_seen + 1;
    if not t.relrowsecurity then
      execute format('alter table public.%I enable row level security', t.relname);
      n_rls := n_rls + 1;
    end if;
    if not exists (select 1 from pg_policy p
                    where p.polrelid = t.oid and p.polname = t.relname || '_service_all') then
      execute format(
        'create policy %I on public.%I for all to service_role using (true) with check (true)',
        t.relname || '_service_all', t.relname);
      n_pol := n_pol + 1;
    end if;
  end loop;

  return query select n_seen, n_rls, n_pol;
end $$;

comment on function tmos_secure_public_schema() is
  'Idempotent lockdown of schema public: strip anon/authenticated, ensure RLS + a service_role policy on every table. CALL THIS AT THE END OF ANY MIGRATION THAT CREATES A TABLE — that is cheaper than remembering the rule.';

-- Not executable by the roles it exists to constrain (functions are EXECUTE-to-
-- PUBLIC by default, which is its own quiet default worth knowing about).
revoke all on function tmos_secure_public_schema() from public;

select * from tmos_secure_public_schema();

-- 3. and for tables that do not exist yet. Supabase's grants come from a
--    default ACL owned by `postgres` (our migrations) and one owned by
--    `supabase_admin` (platform-created objects). The first is ours to change.
--    The second is not — `postgres` is not a member of `supabase_admin` — so it
--    is attempted and its failure is reported rather than swallowed; it only
--    governs objects the platform itself creates in `public`, of which we have
--    none.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated';
  execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon, authenticated';
  execute 'alter default privileges for role supabase_admin in schema public revoke all on functions from anon, authenticated';
exception when insufficient_privilege then
  raise notice 'supabase_admin default privileges left as-is (postgres is not a member) — only affects objects the platform creates in public';
end $$;

-- RESIDUE, measured after applying this: 337 functions in `public` still grant
-- EXECUTE to anon and authenticated, and cannot be revoked from here. Every one
-- of them belongs to an extension installed into `public` (btree_gist 188,
-- vector 118, pg_trgm 31) and is owned by `supabase_admin`, so a REVOKE issued
-- by `postgres` is a no-op with a warning rather than an error — which is
-- exactly how this would go unnoticed. None of our own six functions grants
-- anything to either role. The residue is harmless because these are pure
-- computational functions (`similarity`, `halfvec_cosine_ops` support, GiST
-- support): they read no table, and with zero table privileges there is nothing
-- for a caller to reach through them. Recorded so it is not rediscovered later
-- as a regression.

-- `tmos_analyst` is untouched by all of the above: it was never granted through
-- anon or authenticated, its six SELECTs are enumerated in 006, and 010 gave it
-- the RLS policies the new `enable row level security` calls above would
-- otherwise have shut it out of. That ordering is load-bearing — 010 before 011.
