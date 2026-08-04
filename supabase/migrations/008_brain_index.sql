-- 008 — the Brain index: taskly.ca's documentation, mirrored for retrieval.
--
-- This table is a CACHE, not a source of truth. `taskly-brain/` in the
-- marketplace repo is authoritative for everything Taskly has decided, charges
-- or ships; these rows exist only so TMOS can retrieve and cite it. Anything
-- here can be rebuilt from a snapshot, and nothing here may be edited in place:
-- correcting a Taskly fact means editing the Brain and re-syncing, never
-- updating this table. That one-way rule is what stops a second, divergent copy
-- of company truth from forming inside TMOS.

create extension if not exists vector;

create table if not exists brain_doc (
  path         text primary key,             -- vault-relative; the stable identity
  title        text not null,
  type         text not null check (type in (
                 'map','overview','spec','runbook','decision','policy',
                 'research','tracker','reference','standard','incident','plan')),
  -- The trust ladder. Mirrors taskly.ca's brain gate exactly; the grounding
  -- rules that read it live in packages/contracts/src/brain.ts so the ladder is
  -- defined once rather than re-derived per call site.
  status       text not null check (status in ('canonical','supporting','draft','superseded')),
  reviewed     date,
  caveats      text[] not null default '{}',  -- injected into any answer citing this doc
  verify       text[] not null default '{}',  -- code paths its numbers must be checked against
  superseded_by text[] not null default '{}',
  doc_sha      text not null,                -- the diff key: unchanged ⇒ skip entirely
  commit_sha   text not null,                -- which taskly.ca commit this came from
  synced_at    timestamptz not null default now(),
  constraint brain_doc_canonical_reviewed
    check (status <> 'canonical' or reviewed is not null)
);

-- Retrieval never touches superseded rows, so the index that serves retrieval
-- should not contain them either.
create index if not exists brain_doc_retrievable_idx on brain_doc (status, type)
  where status <> 'superseded';

create table if not exists brain_chunk (
  chunk_id   text primary key,               -- `${doc_sha}:${ordinal}`
  path       text not null references brain_doc(path) on delete cascade,
  ordinal    int not null,
  heading    text not null,                  -- so a citation can name a section
  text       text not null,
  chunk_sha  text not null,
  -- halfvec: half the storage and index size of `vector` at effectively the
  -- same recall for retrieval. Requires pgvector 0.7+ — CHECK THE EXTENSION
  -- VERSION BEFORE APPLYING; on an older pgvector this line is the one that
  -- fails, and the fix is `vector(1024)` plus a re-embed.
  embedding  halfvec(1024),
  -- Versioned so a model change is a visible, queryable migration rather than a
  -- silent one. Chunks embedded by different models are NOT comparable, and
  -- mixing them in one index degrades retrieval in a way that looks like the
  -- corpus got worse rather than like a bug.
  embed_model   text,
  embed_version text,
  embedded_at   timestamptz,
  unique (path, ordinal)
);

-- The re-embed diff: which chunks changed content but have no current vector.
create index if not exists brain_chunk_needs_embed_idx on brain_chunk (path)
  where embedding is null;

create index if not exists brain_chunk_sha_idx on brain_chunk (chunk_sha);

-- HNSW over cosine distance. Built only once there are rows worth indexing;
-- on an empty table it is free, and on a small one a sequential scan wins
-- anyway. Listed here so the index is part of the schema rather than a thing
-- someone remembers to add in production.
create index if not exists brain_chunk_embedding_idx
  on brain_chunk using hnsw (embedding halfvec_cosine_ops);

comment on table brain_doc is
  'Mirror of taskly-brain/ for retrieval. A CACHE — never edited in place. To correct a Taskly fact, edit the Brain and re-sync; writing here would create a second, divergent copy of company truth.';
