# TMOS on Railway

Deployed 2026-09-13 into the **same Railway project as the marketplace**
(`keen-growth`, the one with billing), as two services beside `taskly.ca`.
Nothing here touches the `taskly.ca` service; every CLI command below names its
service explicitly because `railway link` in this folder auto-selected
`taskly.ca` the first time.

| service | what it is | source | runs |
|---|---|---|---|
| `tmos-console` | the console, at <https://tmos-console-production.up.railway.app> | `railway up` from this laptop | always on; `/healthz` is the health check |
| `tmos-worker` | one full pass, `pnpm --filter @tmos/worker run:pass` | `railway up` from this laptop | **cron `30 11 * * *` UTC** = 07:30 Toronto in daylight time |

Both build with Railpack: `pnpm build && node scripts/fetch-brain.mjs`.

## The console has a password now

`TMOS_CONSOLE_PASSWORD` is set on `tmos-console` only. The server binds
`0.0.0.0` **only** when that variable is set and then demands it as HTTP basic
auth on every route except `/healthz`; unset, it is the loopback-only laptop
console it always was. There is no way to expose it without a password. The
browser asks once; any username. Read the value with
`railway variable list --service tmos-console --kv | grep TMOS_CONSOLE_PASSWORD`.

## The cron reverses "nothing is scheduled"

`OPERATING.md` records the founder's call that a pass runs when a human presses
one. The worker service schedules one daily anyway, because a console on a
server that still needs someone to press Run is a laptop with extra steps.
To go back: Railway → `tmos-worker` → Settings → Cron Schedule → clear, or
```bash
railway api 'mutation { serviceInstanceUpdate(serviceId: "68440eb0-070b-45e6-9a8a-2f96fe6fe1f5", environmentId: "66eae563-2ee3-4e5c-bb5e-a13695ded9db", input: { cronSchedule: null }) }'
```
The console's **Run full pass** button works on Railway regardless.

## The brain files travel inside the upload

The worker refuses to run without `TASKLY_FACT_SHEET` and `TASKLY_BRAIN_SNAPSHOT`,
and both live in the marketplace repo — which is **private**, so a build cannot
fetch them anonymously. `scripts/railway-up.sh` builds them from the local
checkout (`TASKLY_REPO_DIR`, default `~/Documents/Taskly`) into `brain/`
(gitignored) and stages them into the upload; on Railway the env vars point at
`/app/brain/…`. That means **the Brain on Railway is as fresh as the last
`railway-up.sh`** — redeploy after Brain changes you want the verifier to see.

If the services are ever switched to build from GitHub instead, set
`GITHUB_TOKEN` (fine-grained, contents:read on `Taskly-ca/taskly.ca`) on both
services and `fetch-brain.mjs` downloads the repo at build time instead.

## Deploying

```bash
scripts/railway-up.sh            # both services
scripts/railway-up.sh console    # one of them
```
It uploads exactly the tracked files plus `brain/` from a temp dir — never
`.env`, never `node_modules`. Deploys are detached; follow with
`railway logs -b --service tmos-console` (build) or `railway logs --service tmos-console`.

## Variables

Set from `.env` on 2026-09-13 with these differences from the laptop:
`NODE_ENV=production`, `TASKLY_FACT_SHEET=/app/brain/FACT-SHEET.md`,
`TASKLY_BRAIN_SNAPSHOT=/app/brain/taskly-brain-snapshot.json`,
`TMOS_DEEP_LINK_BASE=https://tmos-console-production.up.railway.app`, and on the
console only `TMOS_CONSOLE_PASSWORD`. Database URLs keep the session-pooler host
on port 5432. Change one with
`railway variable set KEY=value --service tmos-worker` (redeploys unless `--skip-deploys`).

## What is ephemeral

`briefing.html` is written to the container's disk and is gone on the next
deploy. The console rebuilds it from the database (**Rebuild briefing** spends
nothing), so nothing is lost — but the cron service's copy is never the one you
read; the console's is.

## Settings as applied (no config-as-code — Railway deprecated `railway.json`)

```
console: builder RAILPACK · buildCommand "pnpm build && node scripts/fetch-brain.mjs"
         startCommand "pnpm --filter @tmos/console start" · healthcheckPath /healthz (120s)
         restartPolicy ON_FAILURE ×10
worker:  builder RAILPACK · same buildCommand · startCommand "pnpm --filter @tmos/worker run:pass"
         cronSchedule "30 11 * * *" · restartPolicy NEVER
```
Service ids: console `93b92252-2c4b-4405-98d2-51c821233577`, worker
`68440eb0-070b-45e6-9a8a-2f96fe6fe1f5`, environment `66eae563-2ee3-4e5c-bb5e-a13695ded9db`.
