-- 015 — the answer engine had no memory, and the run id was thrown away.
--
-- `research()` mints a `runId`, spends real money against it, writes rows into
-- `ai_usage_log` under it, and returns a `ResearchAnswer` that nothing stores.
-- Close the tab and the answer is gone. Three separate costs, not one:
--
--  1. THE REFUSALS ARE THE PRODUCT AND THEY WERE DISCARDED. `dropped` and
--     `unanswered` are what makes this not a chatbot — a claim whose span could
--     not be found verbatim in a document we fetched is shown, not softened.
--     Per-request they are a nicety; accumulated they are a finding ("we have
--     asked about Jiffy's pricing four times and dropped the price claim every
--     time" is a statement about the web, not about us). Nothing could ever
--     count them because nothing kept them.
--
--  2. `ai_usage_log.run_id` (012) WAS A JOIN WITH NOTHING ON THE OTHER SIDE.
--     012 built per-run cost attribution and 014 gave it enough precision to be
--     non-zero, but the run id lived only inside one HTTP request. The ledger
--     could say what a run cost and never what the run was for. `message.run_id`
--     is the other end of that join, and it is the whole reason this table
--     stores a run id at all.
--
--  3. A CITATION THAT CANNOT BE RE-READ IS NOT CHECKABLE. `verifyPoints`
--     refuses a claim whose span is not a verbatim substring of a document
--     fetched THIS RUN. That guarantee is strong at the moment of writing and
--     expires with the process: a week later there is no way to ask whether
--     `[3]` still says what we quoted, or whether the page moved. `span` stored
--     beside `source_url` is what turns a one-time gate into an auditable one.
--
-- RLS: every table below carries it, plus a service_role policy, and
-- `tmos_secure_public_schema()` runs at the end — 011 exists because "enable RLS
-- on the new table" is a rule that depends on someone remembering, once per
-- table, forever. TMOS is server-side only; anon and authenticated get nothing.

-- ── thread ──────────────────────────────────────────────────────────────────
--
-- TITLES. The plan (TMOS-ANSWER-ENGINE §7) names generic auto-titles as one of
-- three things not to copy from Perplexity, whose users are advised to rename
-- every thread immediately. A schema cannot write a good title, but it can make
-- the one question a titler must answer answerable: WAS THIS NAMED BY A HUMAN?
-- Hence `title_source`. 'question' is the cheap derivation from the first
-- question (what ships now), 'generated' is a model-written title (a later
-- part), and 'user' is a rename — which nothing may ever overwrite. Without
-- this column an auto-titling pass added later has no way to tell a title it is
-- allowed to improve from one it would be destroying, and the safe-looking
-- answer ("only title untitled threads") makes the first title permanent.
create table if not exists thread (
  id           uuid primary key default gen_random_uuid(),
  -- not null and non-blank: a thread with no name is a row you cannot offer in
  -- a list, and "" and NULL are two ways to spell the same missing thing.
  title        text not null check (length(btrim(title)) > 0),
  title_source text not null default 'question'
                 check (title_source in ('question','user','generated')),
  -- Reserved for the fork (Part 5). §7's second item is thread bloat with no
  -- way to fork, and a fork is only meaningful if it remembers WHERE it was cut
  -- — otherwise it is just a new thread that happens to repeat some text. It is
  -- here now, unwritten, because adding a column to a locked migrations
  -- directory is a serial change and this is the serial change. `set null`, not
  -- `cascade`: deleting the parent thread orphans the fork's provenance, it
  -- does not delete a conversation the user still has open.
  forked_from_message_id uuid,
  created_at   timestamptz not null default now(),
  -- Moved by a trigger on `message`, never by the application. The thread list
  -- is ordered by this column, so an `updated_at` that only advances when a
  -- writer remembers to advance it is an ordering that is quietly wrong.
  updated_at   timestamptz not null default now(),
  -- Soft delete. Distinct from a real DELETE, which also exists: archiving is a
  -- list-view decision the user can undo, deleting is the answer to "remove
  -- what I asked" and must actually remove it. Open question 2 in the plan
  -- (retention window vs forever) is unanswered; a nullable timestamp lets a
  -- retention job find candidates without pre-committing to a policy.
  archived_at  timestamptz
);

-- ── message ─────────────────────────────────────────────────────────────────
--
-- One row per turn. A user turn is a question; an assistant turn is an answer
-- plus what it cost and how it was produced.
create table if not exists message (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references thread(id) on delete cascade,
  -- ORDER WITHIN A THREAD IS NOT `created_at`. `now()` is frozen for the whole
  -- of a transaction, and the natural write is the question and its answer
  -- appended together — so the two rows that most need to be ordered are
  -- exactly the two that share a timestamp. `seq` is explicit and unique per
  -- thread, which also gives "fork from here" a definition (`seq <= n`) that a
  -- timestamp cannot give it.
  seq        int  not null check (seq >= 1),
  role       text not null check (role in ('user','assistant')),
  -- The question, or the answer's prose. `ResearchAnswer.question` and
  -- `.summary` are the same field seen from the two ends of a turn, so they are
  -- one column rather than two mostly-null ones.
  body       text not null,
  -- Fast (per-sentence checks) vs Verified (whole-answer verbatim gate). Stored
  -- per message, not per thread: the mode is chosen per question, and the whole
  -- bet of the rebuild is that the two can be compared after the fact. An
  -- answer whose mode nobody recorded cannot be counted on either side of that.
  mode       text check (mode in ('fast','verified')),
  -- The join key into `ai_usage_log` (012). Text, not uuid, and no FK: a run
  -- writes MANY usage rows, so `run_id` is not unique over there and cannot be
  -- referenced; and the ledger must survive its message being deleted, because
  -- a spend that disappears when the user tidies up is not a ledger.
  run_id     text,
  -- numeric(14,6), matching `ai_usage_log.cost_cents` as 014 left it. NOT int:
  -- 014 is the whole story — a small-model call costs ~0.025¢, an integer
  -- column rounded every real call to 0, and a per-message cost of zero would
  -- reproduce that bug one layer up while looking like an answer.
  cost_cents numeric(14, 6) not null default 0 check (cost_cents >= 0),
  -- The rest of the `ResearchAnswer`: points, dropped, unanswered, sources,
  -- queries. Deliberately a document and not five tables — it is written once,
  -- read whole, and never queried by its interior. The one part that IS queried
  -- by its interior (the citations) is promoted out into `message_citation`.
  answer     jsonb,
  created_at timestamptz not null default now(),
  -- Ordering, and the structural guarantee that two turns cannot claim the same
  -- position.
  constraint message_thread_seq unique (thread_id, seq),
  -- A user turn has no mode, no cost and no answer payload; an assistant turn
  -- must have a mode. Written as one constraint so the failure message names
  -- the rule rather than a column: the case it prevents is an assistant answer
  -- stored with a NULL mode, which reads as a successful cheap answer and is
  -- actually an answer nobody can attribute to a pipeline.
  constraint message_role_shape check (
    (role = 'assistant' and mode is not null)
    or (role = 'user' and mode is null and answer is null and cost_cents = 0)
  )
);

-- The thread view: every message of one thread, in order. Covered by the unique
-- constraint's index above, so no second index is created for it.

-- Cost attribution, the direction 012 could not serve: given a run in
-- `ai_usage_log`, which message was it. Partial — user turns have no run.
create index if not exists message_run_idx on message (run_id)
  where run_id is not null;

-- ── message_citation — the resolved [N] markers ─────────────────────────────
--
-- WHY THIS IS NOT JUST THE `answer` JSONB. Two reasons, and neither is
-- normalisation for its own sake:
--
--   The marker number is a RENDER-TIME fact that must be stable. `[3]` in the
--   prose has to keep meaning the same source on every later read, including
--   after the answer is re-rendered by different code. A primary key of
--   (message_id, ordinal) makes "two different sources are both [3]" impossible
--   rather than unlikely.
--
--   A citation is the unit anyone audits, and auditing it across messages is
--   the point: "every span we have ever quoted from this domain", "which cited
--   URLs no longer resolve" (the UPenn figure the plan cites is 3-13% of
--   citation URLs fully hallucinated in shipped deep-research agents — the only
--   way to know OUR number is to be able to enumerate ours). Neither question
--   is askable of a jsonb document without a full scan and a parser.
--
-- The duplication with `answer` is deliberate and one-directional: the jsonb is
-- the answer as it was produced, frozen; these rows are the queryable
-- projection of it. If they ever disagree, the jsonb is what was shown.
create table if not exists message_citation (
  message_id uuid not null references message(id) on delete cascade,
  -- The `[N]` the reader sees. 1-based because the prose is.
  ordinal    int  not null check (ordinal >= 1),
  source_url text not null check (length(btrim(source_url)) > 0),
  -- Verbatim from the document, as `verifyPoints` found it. This is the column
  -- that makes the claim checkable later; a citation stored as a bare URL only
  -- records that we cited a page, not what we said it said.
  span       text not null check (length(btrim(span)) > 0),
  -- The document's own title, for the hover card. Nullable: plenty of pages
  -- have none, and inventing one is the exact class of error being guarded
  -- against everywhere else here.
  title      text,
  primary key (message_id, ordinal)
);

-- "What have we cited from this domain / this page, and when." The reason this
-- table is relational at all; without the index the question costs a seq scan
-- and therefore never gets asked.
create index if not exists message_citation_url_idx on message_citation (source_url);

-- ── the thread list, and the timestamp it orders by ─────────────────────────
--
-- The sidebar query is `where archived_at is null order by updated_at desc`.
-- Partial on the same predicate so the planner can use it as written — the
-- lesson `prediction_due_idx` already cost us once (see prediction-store.ts):
-- wrap either side and an index that exists for exactly one query stops being
-- used by it.
create index if not exists thread_active_idx on thread (updated_at desc)
  where archived_at is null;

-- `updated_at` is maintained here rather than in the store, for the same reason
-- 011 stopped enumerating tables: a rule enforced by every writer remembering
-- is a rule that holds until the second writer.
--
-- `greatest` is not decoration. It uses `new.created_at` (the caller's instant —
-- adapters in this repo never read the clock) rather than `now()`, so a
-- backfill, an import, or a message appended with an older timestamp cannot
-- REWIND a thread and reorder the whole list behind it. Monotonic, always.
create or replace function thread_touch() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  update thread
     set updated_at = greatest(updated_at, new.created_at)
   where id = new.thread_id;
  return null;
end $$;

drop trigger if exists message_touches_thread on message;
create trigger message_touches_thread after insert on message
  for each row execute function thread_touch();

-- Deferred to here because it points the other way: `thread` is created before
-- `message` exists, so the fork's foreign key cannot be declared inline.
alter table thread add constraint thread_forked_from_fkey
  foreign key (forked_from_message_id) references message(id) on delete set null;

comment on table thread is
  'One conversation. Ordered by updated_at, which a trigger on `message` maintains — never the application.';
comment on column thread.title_source is
  'question | user | generated. Exists so a later auto-titler can tell a title it may improve from a rename it must not touch; generic auto-titles are named in the plan as a Perplexity mistake not to repeat.';
comment on column thread.forked_from_message_id is
  'Reserved for the fork (Part 5): the message a thread was cut from. Nothing writes it yet — it is here because supabase/migrations is a serial change and adding a column later is another one.';
comment on column thread.archived_at is
  'Soft delete, undoable, distinct from DELETE. Also the handle a retention policy would use; the retention window itself is still an open founder question.';

comment on table message is
  'One turn. Ordered by `seq`, not created_at: a question and its answer are appended in one transaction and now() is frozen for the whole of it.';
comment on column message.run_id is
  'Joins ai_usage_log.run_id (012) — the other end of a per-run cost attribution that previously pointed at nothing, because the run id never outlived the request. No FK: a run writes many usage rows, and the ledger must outlive the message.';
comment on column message.cost_cents is
  'numeric(14,6), matching ai_usage_log after 014. An int column rounds a real call (~0.025 cents) to zero and makes per-message cost look free.';
comment on column message.answer is
  'The rest of the ResearchAnswer — points, dropped, unanswered, sources, queries — written once and read whole. dropped/unanswered are stored on purpose: a gate whose refusals are discarded can never be counted.';

comment on table message_citation is
  'The resolved [N] markers. The primary key makes a duplicate marker number impossible; `span` is what keeps a claim checkable after the documents have moved.';
comment on column message_citation.span is
  'Verbatim from the fetched document, as verifyPoints found it. Without it a citation records only that we cited a page, not what we claimed it said.';

-- 011: strip anon/authenticated, force RLS + a service_role policy on every
-- table in public, including the three above. Idempotent, and cheaper than
-- remembering the rule.
select * from tmos_secure_public_schema();
