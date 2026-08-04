-- 005 — the world model's read paths: ER blocking, hard-key lookup, the golden
-- record VIEW, and the indexes the typed query tools actually hit.
--
-- Nothing here changes what is true. It changes what is answerable in time to
-- be useful, which for an intelligence system is nearly the same thing.

create extension if not exists pg_trgm;

-- ── entity resolution: blocking ─────────────────────────────────────────────
-- Fuzzy name matching is O(n²) without a blocking step, and a trigram GIN index
-- IS the blocking step: it turns "compare every pair" into "compare the handful
-- that share trigrams". 001 already creates this; repeated idempotently so the
-- world model's read paths are guaranteed present regardless of apply order.
create index if not exists entity_name_trgm_idx on entity using gin (name_norm gin_trgm_ops);

-- ── hard-key lookup ─────────────────────────────────────────────────────────
-- `unique (kind, value_norm)` in 001 already serves the exact lookup and the
-- auto-merge guarantee, so it is NOT duplicated here. What is missing is the
-- other two directions we actually query:
--
--   1. "every key this entity carries" — the entity page, sourceCoverage, and
--      the merge path that has to move identifiers between entities.
create index if not exists entity_identifier_entity_idx on entity_identifier (entity_id);
--   2. "who owns this value, whatever kind it is" — a scraped string is often a
--      domain OR a handle and we do not know which until we have looked.
create index if not exists entity_identifier_value_idx on entity_identifier (value_norm);

-- ── the golden record is a VIEW, not a table ────────────────────────────────
-- A materialized golden record is a SECOND source of truth. From the moment it
-- is written it drifts from the facts underneath it: a correction lands, a
-- source is retracted, a rule changes — and the table keeps serving the old
-- answer until something remembers to rebuild it. Nothing ever remembers.
-- Derived on read, it cannot be stale.
--
-- The rule below is `mostRecent` — latest `valid` lower bound, ties broken by
-- confidence then fact_id so the answer is deterministic. That is deliberately
-- the ONLY rule expressed in SQL. Per-predicate survivorship (mostReliable,
-- mostFrequent with copy-chain collapse, longestHeld) lives in application code
-- (`packages/world/src/golden.ts`) because it encodes domain knowledge SQL
-- cannot express: that a price should follow recency while a founding year
-- should not, and that three blogs quoting one press release are one voice.
--
-- security_invoker: RLS is enabled on `fact` (004). Without this the view would
-- run as its owner and quietly bypass the policies protecting the rows it reads.
create or replace view golden_record with (security_invoker = true) as
select distinct on (f.entity_id, f.predicate)
  f.entity_id,
  f.predicate,
  f.fact_id,                       -- every field traces back to its evidence
  f.source_id,
  f.confidence,
  f.object_text,
  f.object_num,
  f.object_entity,
  f.object_json,
  lower(f.valid)  as valid_from,
  f.observed_at,
  'mostRecent'::text as survivorship_rule
from fact f
where f.status = 'active'
  and upper_inf(f.asserted)        -- what we believe NOW …
  and f.valid @> now()             -- … about NOW
order by f.entity_id, f.predicate, lower(f.valid) desc, f.confidence desc, f.fact_id;

comment on view golden_record is
  'Derived per-entity current best value. A view, never a table: a materialized golden record is a second source of truth that drifts. Default rule mostRecent; per-predicate rules live in packages/world/src/golden.ts.';

-- ── query-tool access paths ─────────────────────────────────────────────────

-- entitiesMatching: "who charges more than X", "who is in category Y". The
-- partial predicate keeps the index to rows we currently believe, which is the
-- only set that tool ever looks at.
--
-- CAVEAT on the text one: a btree entry cannot exceed ~2.7 KB, so an INSERT of
-- a very long `object_text` would fail on this index rather than on the table.
-- That is acceptable only because the predicates this tool filters on are
-- short categorical values (category, city, plan name). A long free-text
-- predicate must not be filtered through here — hash the value, or give it its
-- own expression index — and this comment is the warning that it is possible.
create index if not exists fact_predicate_text_idx on fact (predicate, object_text)
  where status = 'active' and upper_inf(asserted) and object_text is not null;
create index if not exists fact_predicate_num_idx on fact (predicate, object_num)
  where status = 'active' and upper_inf(asserted) and object_num is not null;

-- Reverse edge traversal: "which entities point AT this one" (parent_of,
-- acquired_by). Without it every relationship question is a sequential scan.
create index if not exists fact_object_entity_idx on fact (object_entity)
  where object_entity is not null;

-- getFactHistory / whatChanged: the correction trail is a chain of supersedes
-- pointers, walked in the child→parent direction.
create index if not exists fact_supersedes_idx on fact (supersedes) where supersedes is not null;

-- whatChanged asks a window question on the ASSERTED axis ("what did we learn
-- between these two instants"). The gist index in 002 is built for containment
-- of an instant, not for ordering by lower bound, so this expression index is
-- what makes the window scan cheap.
create index if not exists fact_asserted_from_idx on fact (entity_id, lower(asserted) desc);

-- sourceCoverage: how many facts, from how many sources, back this entity.
create index if not exists fact_entity_source_idx on fact (entity_id, source_id);

-- The copy-chain walk behind "how many INDEPENDENT sources" — resolving a
-- source to its root is a recursive walk up derives_from, and without this it
-- is a scan of `source` per hop.
create index if not exists source_derives_from_idx on source (derives_from)
  where derives_from is not null;

-- conflictsOpen: 002 already indexes open conflicts per entity. The missing
-- access path is the triage view — open conflicts across ALL entities for one
-- predicate, which is how a systematically bad extractor gets spotted.
create index if not exists fact_conflict_open_predicate_idx
  on fact_conflict (predicate, valid_instant desc) where status = 'open';
