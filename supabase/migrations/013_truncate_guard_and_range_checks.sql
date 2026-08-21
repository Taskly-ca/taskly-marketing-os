-- 013 — three holes the first real run found, all of the same kind: a rule the
-- schema states in a comment but does not enforce on every path that reaches it.

-- ── append-only is bypassable by TRUNCATE ───────────────────────────────────
--
-- `events_no_mutate` (001) and `fact_no_value_mutate`/`fact_no_erase` (009) are
-- ROW triggers, and TRUNCATE does not fire row triggers. Verified against this
-- database on 2026-08-22 as the ordinary application role: DELETE was refused
-- with "events is append-only", and `truncate events cascade` in the very next
-- statement took all 257 rows.
--
-- That is the whole audit trail — provenance, replay, and the one question the
-- bitemporal model exists to answer ("what did we believe on date D") — erasable
-- in a single statement by the role the worker runs as every day.
--
-- A statement-level trigger is the fix rather than `revoke truncate`, because it
-- holds for every role including a future one nobody remembers to revoke, and it
-- fails loudly with a reason instead of a bare permission error.
create or replace function tmos_no_truncate() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception
    '% is append-only: TRUNCATE would erase the audit trail. Row triggers do not '
    'fire on TRUNCATE, which is why this one is statement-level. If you genuinely '
    'mean to reset a development database, drop this trigger explicitly first.',
    tg_table_name;
end $$;

drop trigger if exists events_no_truncate on events;
create trigger events_no_truncate before truncate on events
  for each statement execute function tmos_no_truncate();

drop trigger if exists fact_no_truncate on fact;
create trigger fact_no_truncate before truncate on fact
  for each statement execute function tmos_no_truncate();

-- ── an empty range can still be INSERTed ────────────────────────────────────
--
-- 009 guards UPDATE and DELETE. This is an INSERT, so it slips past: Postgres
-- normalises `tstzrange(T0, T0)` to `empty`, after which `lower()` and `upper()`
-- are both NULL. The row is then undecodable — and because facts are read per
-- entity, it takes EVERY later read of that entity down with it, not just its
-- own. A poisoned row that reads as a poisoned entity.
--
-- The adapter refuses this client-side too. That is not redundancy: the adapter
-- keeps the caller's transaction alive to report a useful error, and this keeps
-- the guarantee true for anything that does not go through the adapter.
alter table fact
  add constraint fact_ranges_non_empty
  check (not isempty(valid) and not isempty(asserted));

-- ── a Finding with no subject ───────────────────────────────────────────────
--
-- `findingSchema` says `.min(1)` and the sibling `evidence` column has its
-- CHECK; `subject_refs` never got one. A finding about nothing in particular
-- cannot be routed to an entity page, ranked by subject, or superseded by the
-- next sighting — it is only reachable by scrolling the feed.
--
-- Written with coalesce because `array_length('{}', 1)` is NULL and a NULL CHECK
-- PASSES — the exact hole 010 closed on `decision_record.prediction_ids`.
alter table finding
  add constraint finding_needs_subject
  check (coalesce(array_length(subject_refs, 1), 0) >= 1);
