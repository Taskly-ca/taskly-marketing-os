# File ownership map

One file, one owner, per wave. This is what makes 3–5 agents work in parallel
without collisions. The orchestrator assigns lanes; an agent that needs a file
outside its lane **stops and reports** rather than widening scope.

## Package → lane

| Package                    | Owns                                                                                         | Depends on              |
| -------------------------- | -------------------------------------------------------------------------------------------- | ----------------------- |
| `packages/contracts`       | All Zod schemas + inferred types                                                             | — (**serial only**)     |
| `packages/shared`          | `llm` (budget chokepoint), `env`, db client                                                  | contracts               |
| `packages/core`            | Domain-neutral types: Source · Signal · Subject · Finding · Investigation · Brief · Decision | contracts               |
| `packages/gate`            | canonicalize · simhash · dedup · detectors · FDR · triage                                    | contracts, shared       |
| `packages/world`           | entity resolution · bitemporal facts · conflicts · query tools                               | contracts, shared       |
| `packages/intel`           | beliefs · predictions · resolvers · calibration · decisions                                  | contracts, shared       |
| `packages/playbooks`       | selection · binding · run ledger · graduation                                                | contracts, world        |
| `packages/knowledge`       | brain snapshot ingest · retrieval · contradiction→PR                                         | contracts, shared       |
| `packages/reasoning`       | orchestrator · workers · synthesis · verifier                                                | contracts, world, intel |
| `packages/collectors`      | one adapter per source                                                                       | contracts, gate         |
| `packages/guardrails`      | honesty denylist · causal lint · judges                                                      | contracts               |
| `packages/eval`            | L0–L3 · golden sets · replay harness                                                         | contracts               |
| `packages/packs/marketing` | the first DomainPack                                                                         | core                    |
| `apps/worker`              | scheduled tasks, pipeline wiring                                                             | all                     |
| `apps/web`                 | Findings feed · entity pages · grid · scoped chat                                            | core, world             |

## Rules

1. **Locked files** (`AGENTS.md`, contracts, migrations, lockfile, CI, root
   tsconfig, turbo.json) change only in a **serial** task.
2. All agents in a wave branch from **one frozen base SHA**. No mid-wave rebase.
3. **Merge is a serialized queue**: merge one PR → full CI → rebase the rest →
   merge the next. Never merge two agent branches and then debug.
4. Dependency order when merging a wave: contracts → migrations → shared →
   domain packages → apps → docs.
5. Each worktree gets its own port (3000, 3001, 3002…) and its own Supabase
   branch or local stack.
