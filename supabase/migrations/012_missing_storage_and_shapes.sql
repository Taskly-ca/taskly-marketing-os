-- 012 — storage the code already depends on, and five places where the
-- migrations and the TypeScript describe different objects.
--
-- Everything here was found by walking the ports and asking "what writes this?"
-- Five of the six answers were "nothing, yet" — and in each case the port was
-- already backed by an in-memory Map or Set, which is why nothing failed. An
-- in-memory ledger does not fail; it forgets on restart, and forgetting is the
-- expensive half. A daily dollar ceiling that resets on deploy is not a
-- ceiling, and an idempotency Set that empties on restart is a paid-for deep
-- research run happening twice.
--
-- `packages/contracts/**` is locked. Where a shape disagreed, the migration
-- moved and the contract did not.

-- ── 1. signal — the raw observation, never persisted ────────────────────────
-- `signalSchema` has existed in packages/contracts/src/core.ts since day one and
-- nothing wrote it. `SkimItem.contentHash` (packages/reason/src/tier/t1-skim.ts)
-- documents itself as `signal.content_hash` and says "unchanged content must
-- never be re-skimmed" — a rule that needs somewhere to remember the hash.
--
-- Modelled column-for-column on the Zod schema, with one deliberate divergence:
-- `simhash` is a bigint here and `z.string()` there. That is not a mismatch —
-- packages/gate/src/simhash.ts returns "the signature as a decimal string so it
-- round-trips through a Postgres bigint without JS number precision loss", and
-- signs it into int64 range explicitly. node-postgres renders int8 back out as a
-- string, so the round trip is exact in both directions, and storing it as a
-- number is what makes `~(a # b)` popcount hamming distance possible in SQL
-- later. Storing it as text would throw that away to match a type annotation.
create table if not exists signal (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references source(id),
  observed_at   timestamptz not null,
  url           text,
  canonical_url text,
  content_hash  text not null,
  simhash       bigint not null,
  -- Emptied, not deleted, at 180 days — see the retention row below.
  payload       jsonb not null default '{}'::jsonb,
  subject_refs  text[] not null default '{}',
  created_at    timestamptz not null default now()
);

-- "Have we already seen this exact content?" — the T0/T1 skip, and the single
-- most-used access path on this table.
create index if not exists signal_content_hash_idx on signal (content_hash);
-- Exact-signature collisions before the (more expensive) hamming comparison.
create index if not exists signal_simhash_idx on signal (simhash);
-- Delta collection: what has this source produced since its cursor.
create index if not exists signal_source_time_idx on signal (source_id, observed_at desc);

-- 004 seeds a retention policy for `signal_payloads`, a table no migration ever
-- created — a dangling reference to a name that never existed. Reconciled
-- toward the code rather than the seed: the contract type is `Signal`, t1-skim
-- names the column `signal.content_hash`, and one table holding the observation
-- is simpler than a table plus a payload side-table for a payload we already
-- store inline. The retention RULE is unchanged and is what 004 actually meant —
-- the raw body expires, the hash and everything derived from it do not.
delete from retention_policy where table_name = 'signal_payloads';
insert into retention_policy (table_name, raw_days, note) values
  ('signal', 180, 'scraped bodies: `payload` is emptied in place at 180 days; id, hashes, subject_refs and every derived fact persist')
on conflict (table_name) do update set raw_days = excluded.raw_days, note = excluded.note;

-- ── 2. the transactional outbox ─────────────────────────────────────────────
-- `Outbox.append` (packages/gate/src/events.ts) promises "append the event AND
-- enqueue its work, or neither". Only the in-memory adapter could keep it.
--
-- pgmq 1.5.1 IS available and IS genuinely transactional — verified on this
-- database: `pgmq.send()` inside a transaction was visible to that transaction
-- and vanished entirely on ROLLBACK, extension and all. It would meet the
-- atomicity requirement. It is deliberately NOT used, for three reasons that
-- have nothing to do with atomicity:
--
--   `pending(queue)` is a non-destructive peek. pgmq has no peek — `read` sets a
--   visibility timeout and `pop` deletes — so the adapter would have to select
--   from `pgmq.q_<queue>` by interpolating a queue name into an identifier,
--   coupling the port to extension internals. The house rule for adapters is
--   that the in-memory one is "a faithful stand-in rather than a simulation
--   with its own behaviour"; that stops being true here.
--
--   Queues are created by DDL (`pgmq.create`), and `append` takes an arbitrary
--   queue name. Either the highest-frequency write path runs DDL, or a queue
--   registry has to exist that does not.
--
--   pgmq lives in its own schema, outside everything 011 just did to `public`.
--   Adopting it means opening a second, unhardened security surface in the same
--   commit that closed the first.
--
-- Against ~10^-2 events/sec — 001's own number, and the reason Postgres is the
-- bus at all — pgmq buys visibility timeouts, archiving and metrics we do not
-- use. A table buys exact atomicity via the FK below, FIFO by identity, a real
-- peek, `for update skip locked` dispatch, and 011's posture for free. If the
-- volume argument ever changes, this is one migration to reverse.
create table if not exists outbox_message (
  -- Monotonic, so FIFO within a queue needs no tiebreak and a dispatcher can
  -- checkpoint on a single scalar.
  msg_id       bigint generated always as identity primary key,
  queue        text not null,
  -- THE atomicity guarantee: a message cannot exist without its event, so a
  -- transaction that enqueues work and then fails to record why is impossible.
  -- `events` has no DELETE (001), so this reference can never dangle either.
  event_id     uuid not null references events(id),
  body         jsonb not null default '{}'::jsonb,
  enqueued_at  timestamptz not null default now(),
  -- Redelivery, kept as data. A crashed consumer's message becomes visible
  -- again; it is never silently lost and never silently retried forever.
  visible_at   timestamptz not null default now(),
  attempts     int not null default 0,
  locked_by    text,
  delivered_at timestamptz,
  dead_at      timestamptz,
  last_error   text
);

-- `pending(queue)` and the dispatcher's `for update skip locked` are the same
-- scan. Partial, because a delivered message is never looked at again.
create index if not exists outbox_pending_idx
  on outbox_message (queue, visible_at, msg_id)
  where delivered_at is null and dead_at is null;
create index if not exists outbox_event_idx on outbox_message (event_id);

comment on table outbox_message is
  'Transactional outbox. INSERT this in the SAME transaction as the events row — the FK is what makes "both or neither" true. Dispatch with `for update skip locked`.';

-- ── 3. ai_usage_log — the ceiling that reset on every deploy ────────────────
-- packages/shared/src/llm/budget.ts calls itself THE budget chokepoint, cites
-- runaway incidents up to $47,000, and holds the day's spend in
-- `BudgetState.dailyCostCents` — a number in a Map. Its own header says it
-- "mirrors the `ai_usage_log` pattern already shipped in the marketplace",
-- referring to a table that was never created here. So `maxDailyCostCents`
-- bounded spend per PROCESS LIFETIME, not per day, and every restart handed
-- back the full ceiling.
--
-- This table exists so a cold process can reconstruct both ledgers before its
-- first authorization: the day's cost, and each live run's token total.
create table if not exists ai_usage_log (
  id            uuid primary key default gen_random_uuid(),
  at            timestamptz not null default now(),
  -- The bucket `utcDay()` computes, computed the same way and stored, so the
  -- reconstruct query is an index lookup and never a timezone argument.
  -- `timezone(text, timestamptz)` is immutable, which is what allows this to be
  -- a generated column at all.
  utc_day       date generated always as ((timezone('utc', at))::date) stored,
  run_id        text not null,
  provider      text,
  model         text,
  tokens_in     int  not null default 0,
  tokens_out    int  not null default 0,
  cost_cents    int  not null default 0,
  tool_depth    int  not null default 0,
  -- Every SpendOutcome, not just the allowed ones. A refusal is a first-class
  -- result in budget.ts and it is also the most interesting row in the table:
  -- a run of `blocked_daily_cost` is the ceiling working, and a run of
  -- `blocked_killswitch` is someone needing to know why the system went quiet.
  outcome       text not null check (outcome in (
                  'allowed','blocked_run_tokens','blocked_daily_cost',
                  'blocked_tool_depth','blocked_killswitch')),
  reason        text
);

-- `select sum(cost_cents) ... where utc_day = current_date and outcome='allowed'`
-- — only committed spend counts, because commitSpend only runs on 'allowed'.
create index if not exists ai_usage_day_idx on ai_usage_log (utc_day)
  where outcome = 'allowed';
-- Rebuilding `BudgetState.runTokens` for runs still in flight.
create index if not exists ai_usage_run_idx on ai_usage_log (run_id, at desc);

comment on table ai_usage_log is
  'Durable backing for the budget chokepoint. Reconstruct today''s spend on start: sum(cost_cents) where utc_day = current_date and outcome = ''allowed''. Without this the daily ceiling resets on every restart.';

-- ── 4. digest_delivery — the cap that could not survive a restart ───────────
-- packages/surface/src/digest/select.ts takes `history: readonly
-- DeliveryRecord[]`, described as "every push ever made, not just this week:
-- the cap is windowed, the never-send-it-twice rule is not". Nothing stored it,
-- so both rules were only as durable as the process holding the array — and the
-- failure mode is not an error, it is re-sending something the reader already
-- read, which is precisely the attention damage WEEKLY_PUSH_CAP exists to
-- prevent.
--
-- `finding_id` is the primary key, not a surrogate. The never-twice rule is a
-- uniqueness property, and a table that can hold it structurally should.
create table if not exists digest_delivery (
  finding_id    uuid primary key references finding(id),
  delivered_at  timestamptz not null default now(),
  -- Recorded so the exception budget can be audited: select.ts, "an exception
  -- nobody counts is not an exception".
  preempted_cap boolean not null default false
);

-- The rolling 7-day window (WINDOW_MS), which is the only range query here.
create index if not exists digest_delivery_window_idx on digest_delivery (delivered_at desc);

-- ── 5. the deep-research idempotency ledger ─────────────────────────────────
-- `RunLedger` (packages/surface/src/interact/deep-research.ts) is a Set. Its own
-- doc says a token is consumed even when the run is then blocked, "whereas
-- releasing it would make 'the same token cannot start two runs' conditional —
-- and conditional idempotency is not idempotency". A Set makes it conditional on
-- uptime: restart between the click and the retry and one yes buys two runs, at
-- real money.
--
-- Everything except the token is nullable ON PURPOSE. The port is `add(token)`
-- and nothing else, so a required column here would be a column no adapter can
-- fill. `insert ... on conflict (token) do nothing` is the whole write.
create table if not exists research_run_token (
  token            text primary key,
  consumed_at      timestamptz not null default now(),
  investigation_id uuid
);

-- ── 6. entity embeddings for the second ER blocker ─────────────────────────
-- packages/world/src/er/vector.ts needs a vector per entity to widen the
-- candidate set past trigram blocking (abbreviations, translations,
-- transliterations — pairs `pg_trgm` cannot see at any threshold). Same shape as
-- brain_chunk (008): halfvec(1024), hnsw, cosine — half the storage and index
-- size of `vector` at effectively the same recall.
--
-- The model columns are not bookkeeping. cosineSimilarity() THROWS on a
-- dimension mismatch because "two different models' outputs got mixed in one
-- pool, and a number computed across that is meaningless" — mixing them silently
-- degrades ER in a way that looks like the data got worse rather than like a bug.
alter table entity add column if not exists embedding     halfvec(1024);
alter table entity add column if not exists embed_model   text;
alter table entity add column if not exists embed_version text;
alter table entity add column if not exists embedded_at   timestamptz;

create index if not exists entity_embedding_idx
  on entity using hnsw (embedding halfvec_cosine_ops);
-- The backfill diff: which entities have no current vector.
create index if not exists entity_needs_embed_idx on entity (id) where embedding is null;

comment on column entity.embedding is
  'Second ER blocker only (VECTOR_THRESHOLD 0.82, cosine). It WIDENS the candidate set and never decides a merge: two different Toronto plumbers embed almost identically, which is what the representation measures, not a threshold to tune.';

-- ── 7. shapes that disagreed with the TypeScript ────────────────────────────

-- prediction.outcome: text '0'|'1'|'annulled'  vs  PredictionRecord.outcome
-- `0 | 1 | 'annulled' | null`. LEFT AS TEXT, deliberately. A mixed
-- number-or-string union has exactly one faithful single-column representation
-- and this is it; splitting it into `smallint` plus an annulled flag would be a
-- better schema and would force a change in packages/intel, which this task does
-- not own. The mapping is total and lossless in both directions, so it is
-- recorded here rather than left for the adapter author to guess at.
comment on column prediction.outcome is
  'Maps to PredictionRecord.outcome (packages/intel/src/prediction/store.ts): 0 -> ''0'', 1 -> ''1'', ''annulled'' -> ''annulled'', unresolved -> NULL. Read back as: v is null ? null : v === ''annulled'' ? ''annulled'' : Number(v).';

-- PredictionRecord.annul_reason had nowhere to go, so `resolve(id, {...,
-- annulReason})` silently dropped it. An annulment without a reason is
-- indistinguishable from a question quietly withdrawn because it was going to
-- score badly — which is the one failure a calibration ledger must not permit.
alter table prediction add column if not exists annul_reason text;
alter table prediction drop constraint if exists prediction_annul_reason_only_annulled;
alter table prediction add constraint prediction_annul_reason_only_annulled
  check (annul_reason is null or outcome = 'annulled');

-- prediction.brier / log_score / baseline / peer: no port method writes these.
-- packages/intel/src/calibration/scoring.ts computes them purely, from rows it
-- has already read. The columns stay — a stored score is what makes "was the
-- agent better than the human on this question set" a query rather than a
-- recomputation — but nothing fills them yet, and that is a missing write path,
-- not a schema defect.
comment on column prediction.brier is
  'Written by nothing today: scoring.ts computes Brier/log/baseline/peer purely and PredictionStore has no method to persist them. Materialize on resolution when that path is built.';

-- prediction.decision_id has no FK to decision_record, and must not get one:
-- `decision_needs_prediction` (010) requires the predictions to exist BEFORE the
-- decision row, while decision_id points back the other way. The cycle is real
-- and the missing constraint is the correct resolution of it.
comment on column prediction.decision_id is
  'Intentionally not a foreign key: decision_record requires >=1 prediction to exist first, so the decision row cannot precede the predictions that name it.';

-- playbook_run.prediction was `jsonb not null`; LedgerRun.prediction is
-- `RunPrediction | null` ("null only for rows that came from elsewhere;
-- startRun never writes one"), and `toPlaybookRun` returns null for exactly
-- those. The DB moved — but NOT to a plain nullable column, because the rule
-- that actually matters is narrower and stronger than NOT NULL: an imported row
-- may lack a prediction, a row with an OUTCOME may not. That is the whole
-- integrity mechanism of the ledger ("the prediction is written BEFORE the
-- outcome, or there is no run"), and NOT NULL only enforced it by accident.
alter table playbook_run alter column prediction drop not null;
alter table playbook_run drop constraint if exists playbook_run_outcome_needs_prediction;
alter table playbook_run add constraint playbook_run_outcome_needs_prediction
  check (outcome is null or prediction is not null);

-- LedgerRun.falsifier — the hypothesis frozen at start, "copied, not referenced,
-- so a later edit to the playbook cannot retroactively move the bar this run was
-- judged against". Without a column the copy was made and then thrown away, and
-- the run would be judged against whatever the playbook says at read time. That
-- is the commonest way a ledger quietly stops being a ledger.
alter table playbook_run add column if not exists falsifier jsonb;

-- LedgerRun.supersedes / .correction_reason — corrections are new rows, not
-- edits, which is the same discipline `fact` gets from 009. The constraint
-- mirrors the ledger's own `correction_needs_reason` rejection code, so the
-- database refuses what the application already refuses.
alter table playbook_run add column if not exists supersedes uuid references playbook_run(run_id);
alter table playbook_run add column if not exists correction_reason text;
alter table playbook_run drop constraint if exists playbook_run_correction_needs_reason;
alter table playbook_run add constraint playbook_run_correction_needs_reason
  check (supersedes is null or correction_reason is not null);
create index if not exists playbook_run_supersedes_idx on playbook_run (supersedes)
  where supersedes is not null;

-- ── 8. and the new tables inherit 011's posture ─────────────────────────────
-- Five new tables just landed with Supabase's default grants. This is the call
-- 011 exists to make unnecessary to remember.
select * from tmos_secure_public_schema();
