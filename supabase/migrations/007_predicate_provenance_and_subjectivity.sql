-- 007 — two rules the application layer enforces that the database could not,
-- found while building predicate promotion and conflict typing.

-- ── 1. promotion needs DISTINCT SOURCES, not a counter ──────────────────────
-- `predicate_def.occurrences` is a single integer, so the only rule it can
-- express is "this was seen N times". That is the wrong rule. One chatty source
-- emitting the same malformed attribute forty times looks identical to forty
-- sources independently converging on a real one — and only the second is
-- evidence that the predicate exists.
--
-- A promoted junk predicate is expensive in a way a slow promotion is not: it
-- becomes part of the semantic layer every query tool reads, and every downstream
-- answer inherits it. So the count has to be over distinct sources, and that
-- requires storing which sources.
create table if not exists predicate_occurrence (
  predicate  text not null references predicate_def(predicate) on delete cascade,
  source_id  uuid not null references source(id) on delete cascade,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  count      int not null default 1,
  primary key (predicate, source_id)
);

comment on table predicate_occurrence is
  'One row per (predicate, source). Promotion counts ROWS here, not predicate_def.occurrences — a single source repeating itself is one voice, however loud.';

-- The promotion query: how many distinct sources have ever proposed this.
create index if not exists predicate_occurrence_predicate_idx on predicate_occurrence (predicate);

-- ── 2. subjectivity has to be declared, never inferred ──────────────────────
-- Conflict typing must know whether a predicate is subjective BEFORE it decides
-- what to do with two sources that disagree. Two sources reporting different
-- ratings is not an error to be resolved — fusing them into one number destroys
-- the only interesting thing about the disagreement.
--
-- Without this column the classifier falls back to matching tokens in the
-- predicate name ('rating', 'sentiment', 'best'). That fallback is doing real
-- work right now, and it is guessing: a predicate named `nps` or `vibe_score`
-- is subjective and matches nothing on the list.
--
-- Default false, deliberately: objectivity is a claim, and a claim should be
-- made explicitly rather than acquired by forgetting to set a flag. The cost of
-- the default being wrong is a subjective predicate treated as factual, which
-- is visible as a conflict someone has to look at — not silent.
alter table predicate_def add column if not exists subjective boolean not null default false;

comment on column predicate_def.subjective is
  'True when sources disagreeing is normal rather than an error (ratings, sentiment, rankings). Read by conflict classification: subjective conflicts are kept side by side, never fused.';

-- ── 3. keep the two in step ─────────────────────────────────────────────────
-- `occurrences` stays as a cheap denormalized total, but it must not be the
-- thing promotion reads. This trigger keeps it honest so a stale counter cannot
-- quietly disagree with the occurrence rows.
create or replace function predicate_sync_occurrences() returns trigger language plpgsql as $$
begin
  update predicate_def
     set occurrences = (select coalesce(sum(count), 0) from predicate_occurrence
                         where predicate = coalesce(new.predicate, old.predicate))
   where predicate = coalesce(new.predicate, old.predicate);
  return null;
end $$;

drop trigger if exists predicate_occurrence_sync on predicate_occurrence;
create trigger predicate_occurrence_sync
  after insert or update or delete on predicate_occurrence
  for each row execute function predicate_sync_occurrences();
