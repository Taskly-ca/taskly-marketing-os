-- 017 — a deep-research run was billed to `fast`, and the ledger stopped meaning anything.
--
-- 016 widened `message.mode` to ('fast','verified','grounded') and argued the
-- general case: a mode the column has no word for gets stored under another
-- mode's name, and every question the column exists to answer degrades. Deep
-- research (Part 7) is the FOURTH thing, and the same collapse happened again.
--
-- WHY THIS ONE IS WORSE THAN THE LAST. Grounded mode stored as `fast` cost the
-- ledger accuracy on a mode that runs at 0.037c — small numbers landing in the
-- wrong row. A deep run's own budget ceiling is 10c, and its admission estimate
-- is 12c: roughly SEVENTY TIMES a fast answer. Filed under `fast`, one deep
-- question makes the fast row read more expensive than every real fast answer
-- combined, and the per-mode comparison in the plan's §10 becomes actively
-- misleading rather than merely incomplete. A table that is wrong is worse than
-- a table with a gap, because nobody distrusts it.
--
-- `fast` was nonetheless the correct thing to store until now, and the route
-- said so: 016's column comment defines `fast` as per-sentence checks over
-- pages fetched this run, which is TRUE of a deep run and merely silent about
-- the plan, the steps and the minutes. `verified` would have claimed a gate
-- that never ran; `grounded` would have claimed no search provider was reached,
-- which is the opposite of what deep mode does, and would have corrupted the
-- one question grounded mode exists to make answerable.
--
-- THE ORDER, AND IT IS THE WHOLE LESSON OF 016. `packages/adapters` reads this
-- column through a CLOSED union that THROWS on an unlisted value, and
-- `getThread` is both what renders a thread and what `historyFor` reads a
-- follow-up's context from. So a row carrying a word the decoder does not know
-- inserts cleanly and then fails on EVERY read, making its own thread
-- permanently unreadable — strictly worse than the mislabelling it fixes.
--
--   1. widen the reader (`AnswerMode` + `MODES`), ship it
--   2. this migration
--   3. one word in `messageMode`
--
-- Step 1 landed in the same change as this file, ahead of it. The test asserting
-- `rowToMessage({mode:'deep'})` throws is what fails first if that order is ever
-- reversed, which is the signal that step 3 is safe.

begin;

-- Dropped by NAME, unlike 016. That migration had to find the constraint by
-- shape because 015 left it auto-named; 016 named it, so from here the name is
-- the contract and a rename would be the thing to notice.
alter table public.message
  drop constraint if exists message_mode_check;

alter table public.message
  add constraint message_mode_check check (mode in ('fast', 'verified', 'grounded', 'deep'));

comment on column public.message.mode is
  'How the answer was produced. `fast` = per-sentence checks over pages fetched '
  'this run. `verified` = the whole-answer verbatim gate, nothing shown '
  'unchecked. `grounded` = spans came from our own world model, Brain and '
  'ledger; no search provider was reached. `deep` = a multi-step planned run, '
  'per-sentence checks, and a cost ceiling roughly seventy times a fast '
  'answer''s. Null on a user turn. Widened by 016 (grounded) and 017 (deep).';

-- Idempotent, and re-run for the same reason 016 gives: 011 owns the RLS and
-- grant posture for every table in `public`, and a migration that touched a
-- table without re-asserting it is how that posture drifts one commit at a time.
select * from tmos_secure_public_schema();

commit;
