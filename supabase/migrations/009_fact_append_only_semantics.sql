-- 009 — the append-only trigger forbade the one mutation the schema requires.
--
-- 002 blocks `new.valid is distinct from old.valid`. But closing `valid` is how
-- the world changing gets recorded — 002's own header says so — and
-- `FactStore.closeValid` (packages/world/src/fact/types.ts) is a REQUIRED port
-- method whose doc comment reads "the append-only trigger permits this". It did
-- not. Verified against this database on 2026-08-22: every closeValid raised
-- `fact values are append-only`. Nothing caught it because the in-memory
-- adapter has no trigger, so the entire Part 3 suite exercised a store the
-- Postgres one could never be.
--
-- The rule the trigger should have encoded is not "bounds are frozen" but
-- "history only ever grows":
--
--   a value is never rewritten            a correction is a NEW row
--   lower(valid) never moves              when something STARTED being true is
--                                         itself a recorded value; editing it
--                                         is falsification, not correction
--   upper(valid) may close, once          infinite → finite is the world
--                                         changing: the only legal mutation
--   upper(valid) never moves again        a wrong end date is corrected on the
--                                         ASSERTED axis — close asserted and
--                                         supersede — never by rewriting valid
--
-- and the identical discipline on `asserted`, because "when we stopped
-- believing it" is exactly as much of a record as "when it stopped being true".
-- An axis that can be rewritten is not an axis, it is a mutable field with a
-- temporal name, and the whole bitemporal argument collapses to SCD Type 2.

-- One function, applied to both axes, so the two can never drift apart. The
-- axis name is passed in only to make the error say which one was violated.
create or replace function fact_range_append_only(old_r tstzrange, new_r tstzrange, axis text)
returns void language plpgsql immutable
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new_r is not distinct from old_r then
    return;                                  -- untouched: nothing to judge
  end if;

  -- An empty range records nothing at all, and lower()/upper() both go null on
  -- it, so it would slip past every bound check below. Caught first.
  if isempty(new_r) then
    raise exception 'fact.% cannot be emptied — an interval that contains no instant asserts nothing', axis;
  end if;

  if lower(new_r) is distinct from lower(old_r) then
    raise exception 'lower(fact.%) is immutable — when it began is a recorded value, not a bound to be edited (was %, tried %)',
      axis, lower(old_r), lower(new_r);
  end if;

  -- Only the upper bound is left. It may be closed exactly once.
  if not upper_inf(old_r) then
    raise exception 'fact.% is already closed at % — re-closing or reopening rewrites recorded history; correct a wrong end by superseding the row',
      axis, upper(old_r);
  end if;

  -- Belt and braces. Postgres refuses to CONSTRUCT an inverted tstzrange, so in
  -- practice `tstzrange(lower, earlier)` fails before this trigger ever runs —
  -- this is the message of last resort, not the usual one.
  if upper(new_r) < lower(new_r) then
    raise exception 'fact.% would end (%) before it starts (%)', axis, upper(new_r), lower(new_r);
  end if;
end $$;

comment on function fact_range_append_only(tstzrange, tstzrange, text) is
  'Bitemporal bound discipline: lower immutable, upper closable once, infinite -> finite only. Shared by both axes so `valid` and `asserted` cannot drift apart.';

create or replace function fact_no_value_mutate() returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
begin
  -- A value is never rewritten. This half is unchanged from 002 and is the
  -- reason the table can be trusted at all.
  if (new.object_text is distinct from old.object_text)
     or (new.object_num is distinct from old.object_num)
     or (new.object_entity is distinct from old.object_entity)
     or (new.object_json is distinct from old.object_json) then
    raise exception 'fact values are append-only — close asserted and insert a replacement (fact_id=%)', old.fact_id;
  end if;

  perform fact_range_append_only(old.valid,    new.valid,    'valid');
  perform fact_range_append_only(old.asserted, new.asserted, 'asserted');

  -- Deliberately still mutable: `status` (setStatus is a port method, and
  -- retraction is how a fact dies), plus the descriptive columns. NOT guarded
  -- here, and worth knowing: entity_id, predicate and source_id can still be
  -- re-pointed by an UPDATE, which would silently re-attribute evidence. No
  -- code path does it today; it wants its own migration, not a widened one.
  return new;
end $$;

drop trigger if exists fact_append_only on fact;
create trigger fact_append_only before update on fact
  for each row execute function fact_no_value_mutate();

-- ── a fact is never deleted ─────────────────────────────────────────────────
-- 002 calls audit erasure "a real failure mode" and then guards only `events`.
-- Retraction is `status='retracted'`: the row stays queryable, which is the
-- entire point of asking "what did we believe on date D". A DELETE answers that
-- question with silence and leaves no trace that it ever could have.
--
-- CONSEQUENCE, on purpose: `fact.entity_id` is `on delete cascade` (001), so
-- `delete from entity` now FAILS for any entity carrying facts. That is the
-- right outcome — an entity row is a registry entry, and removing one must not
-- quietly take a body of evidence with it — but it converts a silent cascade
-- into a loud error, and merge/cleanup code has to retract or re-parent first.
create or replace function fact_no_delete() returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception 'fact is append-only: retract with status = ''retracted'', never DELETE (fact_id=%)', old.fact_id;
end $$;

drop trigger if exists fact_no_erase on fact;
create trigger fact_no_erase before delete on fact
  for each row execute function fact_no_delete();

comment on trigger fact_no_erase on fact is
  'No DELETE. Retraction is status=''retracted'' — the row stays queryable, because "what did we believe on date D" cannot be answered by a table that forgets.';
