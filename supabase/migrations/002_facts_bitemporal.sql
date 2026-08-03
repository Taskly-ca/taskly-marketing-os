-- 002 — the bitemporal world model.
--
-- Two time axes, and the distinction between them is the single most damaging
-- error in this class of system:
--   valid    = when the fact was TRUE IN THE WORLD
--   asserted = when WE BELIEVED IT
--
-- Correcting our own mistake closes `asserted` and inserts a replacement (the
-- old belief stays queryable). The world changing closes `valid` and inserts a
-- new row. Conflating the two is exactly what breaks SCD Type 2, which cannot
-- represent retroactive corrections at all.
--
-- This is also why we do NOT use classical event sourcing: "what did we believe
-- on date D" is a bitemporal READ, not a state reconstruction.

create table if not exists fact (
  fact_id     uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id) on delete cascade,
  predicate   text not null references predicate_def(predicate),
  object_text   text,
  object_num    numeric,
  object_entity uuid references entity(id),
  object_json   jsonb,
  valid       tstzrange not null,
  asserted    tstzrange not null default tstzrange(now(), null),
  source_id   uuid not null references source(id),
  observed_at timestamptz not null,     -- distinct from valid_from: tells a stale
                                        -- scrape apart from a real change
  confidence  real not null default 0.5,
  method      text not null check (method in ('llm_extract','scrape','api','human')),
  -- Version everything that touched a fact, so an improved extractor can RE-RUN
  -- and correct (new asserted interval) rather than overwrite.
  evidence    jsonb not null default '{}'::jsonb,  -- {url, snippet, hash, extractor_version, prompt_version}
  supersedes  uuid references fact(fact_id),
  status      text not null default 'active' check (status in ('active','retracted','disputed'))
);

create index if not exists fact_valid_idx    on fact using gist (entity_id, valid);
create index if not exists fact_asserted_idx on fact using gist (entity_id, asserted);
-- The hot path: current best value per predicate.
create index if not exists fact_current_idx  on fact (entity_id, predicate)
  where upper_inf(asserted) and status = 'active';

-- Facts are append-only. A correction is a new row, never an UPDATE of a value.
create or replace function fact_no_value_mutate() returns trigger language plpgsql as $$
begin
  if (new.object_text is distinct from old.object_text)
     or (new.object_num is distinct from old.object_num)
     or (new.object_entity is distinct from old.object_entity)
     or (new.object_json is distinct from old.object_json)
     or (new.valid is distinct from old.valid) then
    raise exception 'fact values are append-only — close asserted and insert a replacement (fact_id=%)', old.fact_id;
  end if;
  return new;
end $$;
drop trigger if exists fact_append_only on fact;
create trigger fact_append_only before update on fact
  for each row execute function fact_no_value_mutate();

-- ── conflicts are rows, not log lines ───────────────────────────────────────
-- Type the conflict BEFORE resolving it. A competitor raising their price is a
-- TEMPORAL change, not a factual conflict — misclassifying that is the most
-- common and most damaging error here. Only factual conflicts get fused, and
-- losers are retracted, never deleted (audit erasure is a real failure mode).
create table if not exists fact_conflict (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id) on delete cascade,
  predicate    text not null references predicate_def(predicate),
  valid_instant timestamptz not null,
  fact_ids     uuid[] not null,
  kind         text not null check (kind in ('temporal','factual','opinion')),
  status       text not null default 'open' check (status in ('open','resolved','unresolvable')),
  resolution   text,
  resolved_by  text,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists fact_conflict_open_idx on fact_conflict (entity_id) where status = 'open';

-- ── entity-resolution review queue = regression suite + calibration set ─────
create table if not exists er_label (
  id           uuid primary key default gen_random_uuid(),
  left_entity  uuid not null references entity(id) on delete cascade,
  right_entity uuid not null references entity(id) on delete cascade,
  score        real not null,
  llm_verdict  text,
  llm_rationale text,
  human_verdict text not null check (human_verdict in ('match','no_match','unsure')),
  decided_by   text not null,
  decided_at   timestamptz not null default now()
);
