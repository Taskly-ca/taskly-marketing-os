# Operating TMOS

How to use this thing day to day. The build tracker
(`taskly-brain/90-state/TMOS-BUILD.md` in the `taskly.ca` repo) says how it was
built and why; this says what to type.

---

## Start here — the console

```bash
pnpm console
```

Then open **http://127.0.0.1:4478**. That is the app: press a stage, watch it
run line by line, and read what it found. Everything below is the same thing
from a terminal.

**Nothing is scheduled.** A pass runs when you press one. `scripts/schedule.md`
still documents launchd for whoever wants it back; nothing loads it for you.

The console binds to **127.0.0.1 only** — it holds a database connection and can
spawn the worker, so it is not something to put on a network. There is no auth,
and that is only acceptable because nothing off this machine can reach it.

### What the buttons do

| button | what runs |
|---|---|
| Run full pass | all seven stages, ~90–150s |
| Watch competitors | just the competitor pages — the stage that finds changes |
| Collect | just the free sources into `signal` |
| Reason | triage + synthesis over what was collected |
| Rebuild briefing | regenerate the page from the database, spends nothing |
| free only | skips the two stages that spend on a model |

A second run is **refused** while one is in flight, on purpose: two interleaved
passes can make the second read the first's write and classify a genuine
competitor change as already-seen — losing it silently, while looking healthy.

### The tabs

- **What changed** — findings, withdrawn ones included and struck through.
- **Competitors** — every measure on record, with the page it came from.
- **Forecasts** — the open ledger, plus the form to write your own.
- **Sources** — what is feeding it and what is failing.

---

## Running a pass by hand

```bash
pnpm --filter @tmos/worker run:pass            # all seven stages, ~90–150s
pnpm --filter @tmos/worker run:pass --free     # skip the two stages that spend
pnpm --filter @tmos/worker run:pass --only watch
```

Stages, in order: `collect · brain · watch · reason · resolve · digest ·
briefing`. **The pass exits zero even when a stage fails** — a red exit on a
flaky feed is one an operator learns to ignore. To alert, `grep FAILED` the log.

Safe to run as often as you like: collection is backed off per source, the skim
is cached by content hash, the digest is capped and never re-sends.

**Cost: about 1¢ for a whole day of repeated runs.** The ceiling is $20/day.
Cost is not a reason to hesitate.

---

## Writing your own forecast — the one thing only you can do

This is the highest-value thing in the system and it is the part that has been
half-built since August. The ledger holds the agent's probability on each seed
question; **yours is the other side of the comparison**, and without it the
calibration report has one column.

```bash
pnpm --filter @tmos/worker forecast
# ○ jiffy_toronto_snow    you: —
#     Jiffy advertises at least one snow-removal service ... on 2026-11-15

pnpm --filter @tmos/worker forecast jiffy_toronto_snow 0.6 "why you think that"
```

Rules the tool enforces, and the reasons:

- **The agent's number is hidden until you have written yours.** It is one file
  away, and reading 0.85 before you answer makes your number a copy of it. Two
  correlated numbers cannot be scored against each other.
- **A probability, not a percentage.** `85` is refused by name rather than
  clamped to 0.99 — a near-certainty you never expressed, scored against you, is
  the kind of corruption a ledger does not recover from.
- **0.01–0.99 only.** A forecast that cannot be wrong is not a forecast.
- **The reason is required and frozen.** It is hashed at write time, so it
  cannot be rewritten once you know the answer. That is the whole point.
- **One row per question per author.** You cannot forecast the same question
  twice; a duplicate double-counts in every score it touches.

You cannot invent a question. The set is fixed in advance on purpose —
hand-picking questions when convenient inflates apparent skill.

**Cadence that makes this worth it: ~5 a week.** Nothing resolves until
2026-09-30, and the score means nothing until roughly 20 have settled. This only
pays if you start now.

---

## Reading the briefing

`open apps/worker/briefing.html`. It carries:

- **Facts** — what each competitor's own pages said, and when it changed. This
  is the asset that compounds; a day not run is a day of history that cannot be
  backfilled.
- **Findings** — a change worth telling you about, with the claim, the
  consequence, and the span it rests on. **Withdrawn findings stay on the page,
  struck through, with the reason.** A system that quietly stops showing what it
  got wrong has no track record anyone can read.
- **Forecasts** — the open ledger and, once things resolve, the Murphy
  decomposition rather than a bare Brier.

---

## Changing what it watches

Competitors and questions live in `packages/packs/src/marketing-ca.ts`. A target
is a company, a domain, a URL, what you are reading it for, and its measures. A
second pack, `platform`, watches the four services Taskly is built on.

**Before adding a target, check its `robots.txt`.** The transport gate is
fail-closed and will simply refuse the fetch — correctly, and quietly.

Measures come in four kinds and only some may publish a change:

| kind | what it is | publishes a Finding? |
|---|---|---|
| `bounded` | a small enumerated set (`yes \| no \| unstated`) | yes |
| `quoted` | text that must appear in the cited span | yes |
| `open` | a count or list the model composes | no — recorded only |
| `measured` | derived from a document, no model involved | only with a claim that names values |

An `open` measure cannot tell drift from change, which is why
`service_categories_count` reads 4, then 5, then 4 on a page nobody edited.

---

## When something looks wrong

- **"QUIET — nothing_material"** is the system working. It sends only what earns
  an interruption, capped at three a week, and never twice for the same Finding.
- **A refused Finding is a lost observation, not a deferred one.** The fact
  advances in the same pass the verifier refuses, so the next run compares the
  new value to itself and correctly says nothing. If the verifier refuses
  something you wanted, that change will not come back.
- **A source that fails every day** is usually `robots.txt` and usually
  permanent. Backoff caps at 6h, so it retries daily forever — take it out of
  the watchlist rather than leaving it to fail politely.
- **News is a dead source for this business.** Four separate runs, ~50% of
  signals over a year old, near-zero materiality, zero drafts. The competitor
  watch is the instrument that works.

---

## The gate, before you commit anything

```bash
pnpm verify     # typecheck · lint · test · build · knip · check:migrations
```

Must exit 0. `pnpm test:live` is the opt-in suite that spends money.
