# TMOS on Railway

Deployed 2026-09-13 into the **same Railway project as the marketplace**
(`keen-growth`, the one with billing), as two services beside `taskly.ca`.
Nothing here touches the `taskly.ca` service; every CLI command below names its
service explicitly because `railway link` in this folder auto-selected
`taskly.ca` the first time.

| service | what it is | source | runs |
|---|---|---|---|
| `tmos-console` | the console, at <https://tmos-console-production.up.railway.app> | GitHub `Taskly-ca/taskly-marketing-os` @ `main`, deploy on push | always on; `/healthz` is the health check |
| `tmos-worker` | one full pass, `pnpm --filter @tmos/worker run:pass` | same GitHub source | **cron `30 11 * * *` UTC** = 07:30 Toronto in daylight time |

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

## The brain files need a GitHub token at build time

The worker refuses to run without `TASKLY_FACT_SHEET` and `TASKLY_BRAIN_SNAPSHOT`,
and both live in the marketplace repo — which is **private**, so a build cannot
fetch them anonymously. With the services building from GitHub,
`scripts/fetch-brain.mjs` downloads `Taskly-ca/taskly.ca@main` as a tarball
during the build using **`GITHUB_TOKEN`**, copies the FACT-SHEET and runs that
repo's own `brain-snapshot.mjs`. The env vars point at `/app/brain/…`.

**Without `GITHUB_TOKEN` every GitHub-triggered build fails at that step, on
purpose** — the last successful deployment keeps serving. Mint a fine-grained
personal access token: GitHub → Settings → Developer settings → Fine-grained
tokens → resource owner `Taskly-ca` → only `taskly.ca` → repository permission
**Contents: Read-only** → no expiry longer than you are comfortable rotating.
Then, on both services:

```bash
railway variable set GITHUB_TOKEN=github_pat_… --service tmos-console
railway variable set GITHUB_TOKEN=github_pat_… --service tmos-worker
```
Setting the variable redeploys, and that redeploy is the first green build.
The Brain on Railway is then as fresh as the marketplace `main` at the moment
of the last push to TMOS `main`.

## Deploying

**Push to `main`.** Both services rebuild and redeploy on every push.

The laptop path still exists as the fallback — it ships `brain/` built from the
local checkout (`TASKLY_REPO_DIR`, default `~/Documents/Taskly`) inside the
upload, so it needs no token:

```bash
scripts/railway-up.sh            # both services
scripts/railway-up.sh console    # one of them
```
It uploads exactly the tracked files plus `brain/` from a temp dir — never
`.env`, never `node_modules`. Note a `railway up` deployment is replaced by the
next GitHub push. Follow a build with `railway logs -b --service tmos-console`.

## Variables

Set from `.env` on 2026-09-13 with these differences from the laptop:
`NODE_ENV=production`, `TASKLY_FACT_SHEET=/app/brain/FACT-SHEET.md`,
`TASKLY_BRAIN_SNAPSHOT=/app/brain/taskly-brain-snapshot.json`,
`TMOS_DEEP_LINK_BASE=https://tmos-console-production.up.railway.app`, and on the
console only `TMOS_CONSOLE_PASSWORD`. Database URLs keep the session-pooler host
on port 5432. Change one with
`railway variable set KEY=value --service tmos-worker` (redeploys unless `--skip-deploys`).

## The database pauses itself when nothing runs

The TMOS Supabase project (`hakstgvubyirdxchhatx`) is on the free tier and
**auto-pauses after a week or so without traffic**. Paused, the session pooler
answers `Tenant or user not found` — the same text as a wrong username, which is
how the first Railway deploy (2026-09-13) looked like a credentials problem for
twenty minutes. It had been paused since the last laptop run in August.
Restore from the Supabase dashboard (or the Supabase MCP `restore_project`);
it takes a few minutes. The daily cron is now also what keeps it awake.

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
