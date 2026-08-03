-- 004 — consent + access control.
--
-- The consent table exists on day one because it CANNOT be retrofitted:
--   CASL  — express opt-in BEFORE first contact, extraterritorial, to CAD $10M
--   DPDP  — unbundled affirmative consent, enforcement 2027-05-13, to Rs 250 cr
-- A single `marketing_opt_in` boolean satisfies neither regime.

create table if not exists consent (
  id           uuid primary key default gen_random_uuid(),
  person_key   text not null,               -- hashed identifier; never raw PII
  purpose      text not null,               -- 'marketing_email' | 'sms_campaign' | ...
  jurisdiction text not null,               -- 'CA-ON' | 'IN' | ...
  channel      text not null,               -- 'email' | 'sms' | 'whatsapp' | 'push'
  granted      boolean not null,
  evidence     jsonb not null,              -- how/where/when consent was captured
  granted_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create unique index if not exists consent_live_idx
  on consent (person_key, purpose, channel) where revoked_at is null;

-- Retention: 180 days of raw, aggregates indefinitely. A 5-year retention was
-- an explicit aggravating factor in the CNIL/KASPR scraping fine.
create table if not exists retention_policy (
  table_name  text primary key,
  raw_days    int not null,
  note        text not null
);
insert into retention_policy (table_name, raw_days, note) values
  ('events', 180, 'raw observations; derived facts and findings persist'),
  ('signal_payloads', 180, 'scraped bodies; hash + derived signals persist')
on conflict (table_name) do nothing;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- This is an internal system with no end-user tenancy yet, but ACLs propagate
-- from Source at ingest and are enforced at query-compile time. Retrofitting
-- permissions later is a rewrite, so the columns and policies land now.
alter table events            enable row level security;
alter table source            enable row level security;
alter table entity            enable row level security;
alter table fact              enable row level security;
alter table belief            enable row level security;
alter table prediction        enable row level security;
alter table decision_record   enable row level security;
alter table finding           enable row level security;
alter table consent           enable row level security;

-- Service role only, for now. Human-facing policies arrive with the web app in
-- Part 6; until then nothing reaches a browser.
do $$
declare t text;
begin
  foreach t in array array['events','source','entity','fact','belief','prediction',
                           'decision_record','finding','consent']
  loop
    execute format(
      'create policy %I_service_all on %I for all to service_role using (true) with check (true)',
      t, t);
  end loop;
exception when duplicate_object then null;
end $$;
