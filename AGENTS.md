# AGENTS.md

Rules for any AI agent working in this repo. **Deliberately short** — measured:
a human-written, minimal, repo-specific agents file improves task success ~4%,
while an LLM-generated tour of the directory tree _hurts_ by ~3% at +20% cost.
No directory tours here. Detail lives in the package it belongs to.

## What this is

TMOS — a marketing **intelligence** system, not a content generator. Design:
`taskly-brain/60-business/growth/TMOS-ARCHITECTURE.md` in the `taskly.ca` repo.
Build plan: `taskly-brain/90-state/TMOS-BUILD.md`. Read the Part you are working
on before writing code.

## Commands

```bash
pnpm verify      # typecheck · lint · test · build · knip · check:migrations — must pass
pnpm test        # vitest, deterministic and keyless
pnpm check:migrations   # prints the next free migration number
```

## The seven rules

1. **Never call a provider SDK directly.** Every LLM call goes through
   `@tmos/shared/llm`. It owns the token ceiling, the daily dollar ceiling, the
   tool-depth cap and the killswitch. A lint rule blocks the import; do not
   work around it.
2. **Zod at every boundary; types are `z.infer`'d, never hand-written twice.**
   Contracts live in `packages/contracts` and are a **serial** change — never
   edit them in a parallel wave.
3. **Facts are append-only.** Correcting our mistake closes `asserted`; the
   world changing closes `valid`. Conflating those two is the single most
   damaging error in this system.
4. **Never write a fact directly from scraped text.** Typed extraction only,
   stamped with `source_episode_id` + `source_url`. Unsourced claims are
   refused at consolidation (memory poisoning, OWASP ASI06).
5. **Honesty boundary is legal, not stylistic.** No _vetted · handpicked ·
   escrow · pros · background-checked · insured · guaranteed_ in any generated
   text — **including in system prompts**, since a banned word in a prompt
   generates itself into output. The gate is deterministic and fail-closed.
6. **Never write "caused"** for anything below `causal_rung` 2. Say _observed_,
   _associated with_, _consistent with_. A lint enforces it.
7. **Money and flags come from the generated FACT-SHEET, never from prose.**

## Task discipline

- One task = one vertical slice: **≤5 files, ≤300 LOC, one PR**. Success rate
  collapses past that.
- **Acceptance tests first**, then implementation. Red → green is the DoD.
- Stay inside the task's file allow-list. If the task needs a file outside it,
  stop and report — do not widen scope.
- **Stop rule: after 2 failed repair attempts, stop and report.** No thrashing.

## Locked files — serial tasks only, never in a parallel wave

`pnpm-lock.yaml` · `supabase/migrations/**` · `packages/contracts/**` ·
`turbo.json` · `tsconfig.base.json` · `.github/workflows/**` · this file.

## Definition of done

Contract unchanged · acceptance tests green · `pnpm verify` green · files ⊆
allow-list · diff < ~300 LOC · PR says what was verified and how.
