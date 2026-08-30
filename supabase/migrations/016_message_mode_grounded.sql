-- 016 — a grounded answer was recorded as if it had come off the open web.
--
-- 015 constrained `message.mode` to ('fast','verified') because those were the
-- two things the pipeline could be: per-sentence checks, or the whole-answer
-- verbatim gate. Grounded mode (Part 6) is a THIRD thing, and the column had no
-- word for it — so the route stored it as `fast`, which is true about the SHAPE
-- of the answer and silent about the only part that distinguishes it.
--
-- WHY THAT IS NOT COSMETIC. Grounded mode's whole claim is the provenance of
-- its evidence: every span is a row we wrote, verified the day it was written,
-- and no search provider was reached. Two questions are asked of these rows and
-- neither survived the collapse:
--
--   1. "Was this answered from our own ledger, or from the open web?" The one
--      question a reader of an old thread most needs settled, and the one the
--      row could not answer. `mode = 'fast'` beside a citation to
--      `60-business/PRICING_v3.md` is a row that contradicts itself.
--   2. "What does each mode cost?" 015 built per-message cost attribution
--      (`run_id` + `cost_cents` at numeric precision) precisely so the modes
--      could be compared after the fact. Grounded runs at roughly a fifth of a
--      web answer because phase A over internal evidence is free — a real
--      finding, filed under another mode's name and therefore uncountable.
--
-- ORDER MATTERS THE OTHER WAY ROUND HERE. The column is widened BEFORE anything
-- writes the new value: a row carrying a word the constraint refuses is an
-- insert that fails, and a row carrying a word the DECODER refuses is a thread
-- that cannot be read back at all. `packages/adapters` decodes this column
-- through a closed union (`asUnion(row.mode, MODES)`, which throws), so the
-- writer stays on `fast` until that union is widened too. This migration is the
-- half that is locked and serial; it is deliberately safe to apply alone,
-- because nothing yet emits 'grounded' and every existing row keeps its value.
--
-- RLS: no table is created and no policy is touched, so there is nothing new to
-- secure. `tmos_secure_public_schema()` is re-run at the end anyway — it is
-- idempotent, it costs nothing, and running it is how a migration PROVES that
-- what it did to `message` left RLS and the service_role policy where 011 put
-- them, rather than asserting it in a comment.

-- ── the constraint, replaced rather than edited ─────────────────────────────
--
-- Postgres has no "alter check constraint"; the only move is drop and add. The
-- old one was written inline on the column in 015, so its name is whatever the
-- server generated (`message_mode_check`) — and dropping by a REMEMBERED name
-- is how you end up with two checks on one column, the old one still refusing
-- the value the new one admits, and a failure that looks like the migration
-- never ran. So it is found by SHAPE: every single-column CHECK whose column is
-- exactly `mode`. `message_role_shape` mentions mode but covers four columns,
-- so it is not matched and is left alone — it is what still guarantees that an
-- assistant turn records SOME mode.
do $$
declare
  target text;
  dropped int := 0;
begin
  for target in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.message'::regclass
       and con.contype  = 'c'
       and con.conkey   = array[
             (select a.attnum
                from pg_attribute a
               where a.attrelid = 'public.message'::regclass
                 and a.attname  = 'mode')
           ]::int2[]
  loop
    execute format('alter table public.message drop constraint %I', target);
    dropped := dropped + 1;
  end loop;

  -- Fail closed. Finding nothing means the column is not shaped the way this
  -- migration was written against, and adding the new check on top of an
  -- unknown arrangement is how a constraint quietly stops meaning anything.
  if dropped = 0 then
    raise exception
      'no single-column CHECK on message.mode found — 015''s constraint is not where 016 expected it; inspect pg_constraint before widening the column';
  end if;
end $$;

-- Named this time, for the same reason: the next migration that has to widen it
-- should not have to go looking.
alter table public.message
  add constraint message_mode_check check (mode in ('fast', 'verified', 'grounded'));

comment on column message.mode is
  'fast | verified | grounded. Fast = per-sentence checks over pages fetched this run; Verified = the whole-answer verbatim gate; Grounded = answered from our own evidence (world model, findings, Brain, ledger) with no search provider reached. Stored per message because the mode is chosen per question, and comparing the three after the fact is the whole bet of the answer engine.';

-- 011, re-run: strip anon/authenticated, force RLS + a service_role policy on
-- every table in public. Expected to report 0 enabled and 0 added — that zero
-- is the evidence that widening a constraint changed nothing about who can read
-- the table.
select * from tmos_secure_public_schema();
