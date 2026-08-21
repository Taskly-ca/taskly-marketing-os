-- 001 — the append-only spine + entity registry.
--
-- Postgres IS the event bus. At ~10^-2 events/sec every heavier broker is a tax
-- (~55% of Kafka deployments run under 1 MB/s, already far above our volume).
-- `events` is the blackboard: audit, replay and provenance in one table.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists vector;
-- btree_gist: `fact` (002) indexes `gist (entity_id, valid)`. GiST has no default
-- operator class for uuid, so that index — and therefore the whole bitemporal
-- core — cannot be created without this. Found by applying 002 to a real
-- Postgres 17 for the first time on 2026-08-21; it had never been executed.
create extension if not exists btree_gist;

-- ── events ──────────────────────────────────────────────────────────────────
create table if not exists events (
  id              uuid primary key default gen_random_uuid(),
  occurred_at     timestamptz not null,            -- when it happened in the world
  recorded_at     timestamptz not null default now(), -- when we learned it
  type            text not null,
  source_id       uuid,
  entity_id       uuid,
  payload         jsonb not null default '{}'::jsonb,
  content_hash    text,
  -- Exactly-once is unachievable with LLMs (a "replay" is a different call), so
  -- we record the output once and reuse it on recovery. This key is how.
  idempotency_key text unique,
  -- correlation: one investigation is one query. causation: renders the chain
  -- that produced a belief. Without these, agent runs are mystical.
  correlation_id  uuid not null,
  causation_id    uuid
);
create index if not exists events_correlation_idx on events (correlation_id, recorded_at);
create index if not exists events_type_time_idx    on events (type, recorded_at desc);
create index if not exists events_entity_idx       on events (entity_id, recorded_at desc);

-- events are append-only. Enforced, not documented.
create or replace function events_no_mutate() returns trigger language plpgsql as $$
begin
  raise exception 'events is append-only (attempted % on id=%)', tg_op, old.id;
end $$;
drop trigger if exists events_immutable on events;
create trigger events_immutable before update or delete on events
  for each row execute function events_no_mutate();

-- ── sources ─────────────────────────────────────────────────────────────────
create table if not exists source (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null,
  name                 text not null,
  tier                 text not null check (tier in ('first_party','primary','trade','aggregator','farm')),
  region               text check (region in ('ca','in','global')),
  cursor               text,
  etag                 text,                       -- 304s cost nothing: the biggest crawl-budget lever
  last_ok_at           timestamptz,
  consecutive_failures int not null default 0,
  visibility           text not null default 'internal' check (visibility in ('internal','restricted')),
  -- Naive voting fails because sources copy each other: three blogs quoting one
  -- press release is ONE observation. Copy-chains collapse before counting.
  derives_from         uuid references source(id),
  -- Running Beta posterior over "was this source later confirmed or refuted".
  reliability_alpha    numeric not null default 1,
  reliability_beta     numeric not null default 1,
  created_at           timestamptz not null default now()
);

-- ── entities + identifiers ──────────────────────────────────────────────────
create table if not exists entity (
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null,                        -- open: registered by a DomainPack
  name        text not null,
  name_norm   text not null,
  region      text check (region in ('ca','in','global')),
  created_at  timestamptz not null default now()
);
create index if not exists entity_name_trgm_idx on entity using gin (name_norm gin_trgm_ops);
create index if not exists entity_type_idx      on entity (entity_type);

-- Hard identity keys. For competitive intel the registrable domain is a
-- near-perfect key: an exact match auto-merges with no scoring at all.
create table if not exists entity_identifier (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id) on delete cascade,
  kind       text not null,                         -- domain | social | bundle_id | linkedin_id
  value_norm text not null,
  source_id  uuid references source(id),
  confidence real not null default 1.0,
  unique (kind, value_norm)                          -- the auto-merge guarantee
);

-- ── predicate registry = the open schema AND the semantic layer ─────────────
-- Predicates are DATA, not DDL: adding one never requires a migration or a
-- re-ingest. It also doubles as the semantic layer the query tools describe,
-- which is what turns silent-wrong answers into loud refusals.
create table if not exists predicate_def (
  predicate   text primary key,
  entity_type text not null,
  datatype    text not null check (datatype in ('text','num','entity','json')),
  unit        text,
  cardinality text not null default 'one' check (cardinality in ('one','many')),
  status      text not null default 'proposed' check (status in ('proposed','active','deprecated')),
  description text not null,
  aliases     text[] not null default '{}',
  superseded_by text references predicate_def(predicate),
  occurrences int not null default 0,               -- promote after recurring across N sources
  created_at  timestamptz not null default now()
);
