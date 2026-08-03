-- 003 — the intelligence spine: beliefs, predictions, decisions, playbooks,
-- findings. This is the part that compounds; everything upstream is commodity.

-- ── beliefs ─────────────────────────────────────────────────────────────────
create table if not exists belief (
  id            uuid primary key default gen_random_uuid(),
  statement     text not null,
  p             numeric not null check (p > 0 and p < 1),
  prior_p       numeric not null check (prior_p > 0 and prior_p < 1),
  status        text not null default 'active' check (status in ('active','weakened','falsified','retired')),
  region        text check (region in ('ca','in','global')),
  valid_from    timestamptz not null default now(),
  valid_to      timestamptz,
  -- ATMS-style justification edges. When a belief falsifies, one recursive CTE
  -- enumerates the blast radius of everything that inherited it.
  derived_from  uuid[] not null default '{}',
  -- "A belief with no stated falsifier is not a belief, it is a mood."
  falsifier     text not null,
  last_confirmed_at timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists belief_active_idx on belief (status) where status = 'active';

create table if not exists belief_update (
  id         uuid primary key default gen_random_uuid(),
  belief_id  uuid not null references belief(id) on delete cascade,
  from_p     numeric not null,
  to_p       numeric not null,
  evidence   jsonb not null,
  rationale  text not null,
  at         timestamptz not null default now(),
  -- Sycophancy guard: the model may PROPOSE a delta, the DB enforces the cap.
  -- LLMs drift toward whatever was last asserted, so the arithmetic lives here.
  constraint belief_delta_capped check (abs(to_p - from_p) <= 0.2)
);

-- ── predictions — the calibration engine ────────────────────────────────────
create table if not exists prediction (
  id           uuid primary key default gen_random_uuid(),
  decision_id  text,
  belief_ids   uuid[] not null default '{}',
  claim        text not null,                 -- binary or thresholded ONLY
  p            numeric not null check (p >= 0.01 and p <= 0.99),
  -- Humans and agents scored separately on the SAME question set. That
  -- comparison is the most valuable output the system produces.
  author       text not null check (author ~ '^(human|agent):'),
  created_at   timestamptz not null default now(),
  resolve_at   timestamptz not null,
  resolver     jsonb not null,                -- {kind, spec, source_url, fallback:'annul'}
  -- Frozen at write time: the resolver's data must never reach the forecaster.
  -- Temporal leakage silently inflates apparent skill.
  evidence_snapshot_hash text not null,
  -- Resolution
  outcome      text check (outcome in ('0','1','annulled')),
  observed     jsonb,
  resolved_at  timestamptz,
  -- Scores. Brier is insensitive to rare events; log punishes confident
  -- wrongness; baseline makes raw Brier interpretable.
  brier        numeric,
  log_score    numeric,
  baseline     numeric,
  peer         numeric
);
create index if not exists prediction_due_idx on prediction (resolve_at) where outcome is null;
create index if not exists prediction_author_idx on prediction (author, resolved_at desc);

-- ── decisions ───────────────────────────────────────────────────────────────
create table if not exists decision_record (
  id            text primary key,                -- DEC-YYYY-NNN, never reused
  status        text not null check (status in ('proposed','accepted','reversed','superseded')),
  door          text not null check (door in ('one_way','two_way')),
  context       text not null,
  decision      text not null,
  alternatives  jsonb not null,                  -- >=2 enforced below
  beliefs_relied_on uuid[] not null default '{}',
  prediction_ids uuid[] not null,                -- >=1 enforced below
  kill_criteria jsonb not null,
  expected_cost_cents bigint not null default 0,
  decided_at    timestamptz not null default now(),
  decided_by    text not null,
  outcome       jsonb,                            -- {result, luck_attribution, notes}
  -- The whole mechanism, in two constraints.
  constraint decision_needs_alternatives check (jsonb_array_length(alternatives) >= 2),
  constraint decision_needs_prediction   check (array_length(prediction_ids, 1) >= 1)
);

-- ── playbooks ───────────────────────────────────────────────────────────────
create table if not exists playbook (
  id          text not null,
  version     int not null,
  title       text not null,
  intent      text not null,
  status      text not null default 'candidate' check (status in ('candidate','proven','retired')),
  applies_when  jsonb not null,
  excludes_when jsonb not null default '[]'::jsonb,
  params      jsonb not null default '{}'::jsonb,
  steps       jsonb not null,
  hypothesis  jsonb not null,
  kill_criteria jsonb not null,
  assumptions text[] not null default '{}',
  decay_after_days int not null default 180,
  created_at  timestamptz not null default now(),
  primary key (id, version)                       -- append-only: a shipped version never mutates
);

create table if not exists playbook_run (
  run_id            uuid primary key default gen_random_uuid(),
  playbook_id       text not null,
  playbook_version  int not null,
  situation_snapshot jsonb not null,              -- enables held-out replay
  params_bound      jsonb not null,
  -- Recorded BEFORE the outcome. This kills self-serving history, and is worth
  -- more than the rest of the memory system combined.
  prediction        jsonb not null,
  outcome           jsonb,
  lessons           jsonb not null default '[]'::jsonb,
  started_at        timestamptz not null default now(),
  foreign key (playbook_id, playbook_version) references playbook(id, version)
);

-- ── findings + feedback ─────────────────────────────────────────────────────
create table if not exists finding (
  id            uuid primary key default gen_random_uuid(),
  claim         text not null,
  so_what       text not null,
  subject_refs  text[] not null,
  evidence      jsonb not null,                   -- >=1 enforced below
  basis         text not null check (basis in ('verified_metric','governed_query','inferred_from_sources','exploratory_unverified')),
  causal_rung   int not null check (causal_rung between 0 and 4),
  stakes        text not null check (stakes in ('low','medium','high')),
  region        text not null check (region in ('ca','in','global')),
  domain_score  numeric not null check (domain_score between 0 and 1),
  generated_by  text not null,
  reviewed_by   text,
  superseded_by uuid references finding(id),
  -- Trust repair requires CAUSAL ATTRIBUTION, not a silent correction.
  supersede_reason text,
  correlation_id uuid,
  created_at    timestamptz not null default now(),
  constraint finding_needs_evidence check (jsonb_array_length(evidence) >= 1)
);
create index if not exists finding_live_idx on finding (created_at desc) where superseded_by is null;

-- The dismissal REASON is worth more than any quality score: it identifies
-- which failure mode we are actually suffering from.
create table if not exists finding_feedback (
  id            uuid primary key default gen_random_uuid(),
  finding_id    uuid not null references finding(id) on delete cascade,
  actor         text not null,
  action        text not null check (action in ('viewed','saved','dismissed','acted_on')),
  dismiss_reason text check (dismiss_reason in ('wrong','obvious','not_actionable','stale','bad_source')),
  at            timestamptz not null default now()
);
