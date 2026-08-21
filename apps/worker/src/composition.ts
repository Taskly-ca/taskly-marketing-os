/**
 * THE COMPOSITION ROOT.
 *
 * Every domain package in this repo takes its ports as arguments and imports no
 * other domain package. That is what keeps `packages/world` loadable without a
 * connection string and `packages/surface` free of the bitemporal vocabulary —
 * and it is also why, until this file existed, the object graph had never once
 * been assembled. Each port had an in-memory implementation and a Postgres one,
 * and nothing in the repository said which was the real system.
 *
 * This file says it. It is deliberately declarative: one table of port → adapter
 * that a reader can check against `packages/adapters` line by line, plus the
 * budget ledger, and no logic. Anything that needs a decision made belongs in
 * the task that uses it, not here.
 *
 * ── WHY NO EXECUTOR IS PASSED TO ANY FACTORY ────────────────────────────────
 *
 * Every `createPostgres*` takes an optional `Executor` and every one of them is
 * called with NOTHING. That is the correct call, and the outbox adapter spells
 * out why: an executor captured at construction binds the pool once, forever,
 * so a store built at module scope would silently escape a caller's `withTx`.
 * Passed nothing, each store resolves `db()` per call — which returns the
 * ambient transaction when there is one and the pool when there is not. The
 * transactional outbox's one guarantee depends on this.
 *
 * ── THE ONE PORT THAT IS DELIBERATELY NOT WIRED ─────────────────────────────
 *
 * `createPostgresQueryExecutor` (the guarded `run_analytical_query` escape
 * hatch) needs a `Connect` authenticated as a member of `tmos_analyst` — a
 * SECOND connection, on `DATABASE_ANALYST_URL`, because 006's role settings
 * apply at login and are not inherited through `SET ROLE`. `@tmos/db` exposes
 * exactly one pool (`getPool`) bound to `DATABASE_URL` and no factory for a
 * second one, so wiring it here would mean importing `pg` into an app — which
 * is the boundary this repo spent a package establishing. It is listed as
 * unwired rather than silently absent, because a composition root that omits a
 * port without saying so is how a system acquires a shadow default.
 */
import {
  createPostgresBrainIndex,
  createPostgresBrainStore,
  createPostgresConflictPort,
  createPostgresDecisionStore,
  createPostgresEntityDirectory,
  createPostgresFactStore,
  createPostgresFindingStore,
  createPostgresLabelStore,
  createPostgresOutbox,
  createPostgresPlaybookRunStore,
  createPostgresPredicateIndex,
  createPostgresPredicateStore,
  createPostgresPredictionStore,
  createPostgresSourceGraph,
} from '@tmos/adapters';
import { closePool, db, sql } from '@tmos/db';
import {
  createBudgetState,
  engageKillswitch,
  loadEnv,
  utcDay,
  type BudgetLimits,
  type BudgetState,
  type Env,
} from '@tmos/shared';

import { createTransport, type Transport } from './transport.js';

/**
 * PORT → ADAPTER. The whole table.
 *
 * `ReturnType<typeof …>` rather than the named port interface on purpose: the
 * interfaces live in six different domain packages, and importing all six here
 * to spell out types that the factory already guarantees would add six
 * dependency edges to an app for zero information. If a factory ever stops
 * returning its port, `packages/adapters` fails to compile first.
 */
interface Ports {
  /** The transactional outbox — `events` + `outbox_message`, both or neither. */
  readonly outbox: ReturnType<typeof createPostgresOutbox>;
  /** Bitemporal facts. Append-only; a correction closes `asserted`, a change closes `valid`. */
  readonly facts: ReturnType<typeof createPostgresFactStore>;
  readonly predicates: ReturnType<typeof createPostgresPredicateStore>;
  /** Entity resolution: the directory it blocks against, and the label store it is re-fitted from. */
  readonly entities: ReturnType<typeof createPostgresEntityDirectory>;
  readonly erLabels: ReturnType<typeof createPostgresLabelStore>;
  /** The typed query tools. `run_analytical_query` is NOT here — see the header. */
  readonly conflicts: ReturnType<typeof createPostgresConflictPort>;
  readonly sourceGraph: ReturnType<typeof createPostgresSourceGraph>;
  readonly predicateIndex: ReturnType<typeof createPostgresPredicateIndex>;
  /** The brain: documents, and the hnsw index over their chunks. */
  readonly brain: ReturnType<typeof createPostgresBrainStore>;
  readonly brainIndex: ReturnType<typeof createPostgresBrainIndex>;
  /** The calibration ledger, and the two things that must not exist without it. */
  readonly predictions: ReturnType<typeof createPostgresPredictionStore>;
  readonly decisions: ReturnType<typeof createPostgresDecisionStore>;
  readonly playbookRuns: ReturnType<typeof createPostgresPlaybookRunStore>;
  readonly findings: ReturnType<typeof createPostgresFindingStore>;
}

interface Tmos {
  readonly env: Env;
  /**
   * The same environment `loadEnv` parsed, still as a raw record.
   *
   * `Collector.isConfigured` takes `Record<string, string | undefined>` and the
   * credentialed collectors are bound to it, so the pass must see the SAME
   * normalised view the ceilings were read from — not `process.env`, where an
   * empty `PRODUCT_HUNT_TOKEN=` is a present key.
   */
  readonly processEnv: Record<string, string | undefined>;
  /** The ceilings, from env. `shared/llm` is the only module that may spend. */
  readonly limits: BudgetLimits;
  /** The day's ledger, reconstructed from `ai_usage_log` before first use. */
  readonly budget: BudgetState;
  readonly ports: Ports;
  /** The policy-enforcing fetch path. One per system, so its robots.txt cache
   *  and per-host rate limiter are shared by everything that fetches. */
  readonly transport: Transport;
  close(): Promise<void>;
}

/**
 * AN EMPTY VARIABLE IS AN ABSENT ONE.
 *
 * `.env` lists every variable the system can take and leaves most of them
 * unfilled — that is what makes it a usable template. Node's `--env-file`
 * materialises `RESEND_API_KEY=` as the empty STRING, so `z.string().min(1)
 * .optional()` sees a key that is present and invalid rather than absent, and
 * boot fails on four credentials nobody has and nothing uses. Observed on the
 * first real run, 2026-08-22.
 *
 * `vitest.live.config.ts` already makes exactly this rule for exactly this
 * reason ("a suite that asks `'KEY' in process.env` would read a blank
 * credential as a provided one"). It lives there because that file does its own
 * parsing; every other entry point needs it too, which is why it is here rather
 * than only there. The right home is `loadEnv` itself — see the report.
 */
function normalizeEnv(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value.trim().length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * `loadEnv`, with the one sentence that turns its zod dump into an action.
 *
 * `loadEnv` requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` because it
 * was written before `@tmos/db` existed and Supabase's REST API was assumed to
 * be how this system would reach its data. It is not: everything goes through
 * `DATABASE_URL` and a `pg` pool, no worker code path constructs a Supabase
 * client, and the repo's own `.env` leaves the service-role key blank because
 * nothing has ever needed it. So the worker cannot boot on the credentials the
 * project actually has, and the raw error does not say why. This does.
 *
 * It only ADDS context — the schema is not relaxed here, because narrowing a
 * shared contract from an app is how two definitions of "valid environment"
 * start to exist. The fix belongs in `packages/shared`; see the report.
 */
function parseEnv(source: Record<string, string | undefined>): Env {
  try {
    return loadEnv(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${detail}\n\nThe worker reaches Postgres through DATABASE_URL and never builds a ` +
        'Supabase client, but @tmos/shared\'s loadEnv still requires SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY. Fill them in .env, or export them for this invocation, ' +
        'until that schema is split.',
    );
  }
}

/**
 * Reconstruct today's spend before the first authorization.
 *
 * `BudgetState.dailyCostCents` is a number in a Map, so before migration 012
 * created `ai_usage_log` the "daily" ceiling was really a per-process-lifetime
 * ceiling and every restart handed back the full budget. 012 exists to fix
 * that; this is the read that makes the fix real. Only `outcome = 'allowed'`
 * counts, because `commitSpend` only runs on allowed — and that predicate
 * matches `ai_usage_day_idx` exactly.
 *
 * A failure here is NOT swallowed. A budget that silently starts at zero
 * because a query failed is the exact bug this is closing.
 */
async function hydrateBudget(state: BudgetState): Promise<number> {
  const row = await db().one<{ cents: number }>(sql`
    select coalesce(sum(cost_cents), 0)::int as cents
      from ai_usage_log
     where utc_day = current_date
       and outcome = 'allowed'`);
  state.dailyCostCents = row.cents;
  return row.cents;
}

interface BuildOptions {
  readonly source?: NodeJS.ProcessEnv;
  /** Injected in tests; production builds the real policy-enforcing transport. */
  readonly transport?: Transport;
}

/**
 * Build the real system. Called once, at the top of a process, and never from
 * inside a task — a task that could build its own graph is a task that can
 * disagree with this one about what the real system is.
 */
export async function buildSystem(options: BuildOptions = {}): Promise<Tmos> {
  const processEnv = normalizeEnv(options.source ?? process.env);
  const env = parseEnv(processEnv);

  const limits: BudgetLimits = {
    maxRunTokens: env.TMOS_MAX_RUN_TOKENS,
    maxDailyCostCents: env.TMOS_MAX_DAILY_COST_CENTS,
    maxToolDepth: env.TMOS_MAX_TOOL_DEPTH,
  };

  const budget = createBudgetState(utcDay());
  // The killswitch is a boot-time fact here, and `authorizeSpend` checks it
  // before every other ceiling. `TMOS_KILLSWITCH=true` makes the process
  // incapable of spending rather than merely unwilling to.
  if (env.TMOS_KILLSWITCH) engageKillswitch(budget);
  await hydrateBudget(budget);

  const ports: Ports = {
    outbox: createPostgresOutbox(),
    facts: createPostgresFactStore(),
    predicates: createPostgresPredicateStore(),
    entities: createPostgresEntityDirectory(),
    erLabels: createPostgresLabelStore(),
    conflicts: createPostgresConflictPort(),
    sourceGraph: createPostgresSourceGraph(),
    predicateIndex: createPostgresPredicateIndex(),
    brain: createPostgresBrainStore(),
    brainIndex: createPostgresBrainIndex(),
    predictions: createPostgresPredictionStore(),
    decisions: createPostgresDecisionStore(),
    playbookRuns: createPostgresPlaybookRunStore(),
    findings: createPostgresFindingStore(),
  };

  return {
    env,
    processEnv,
    limits,
    budget,
    ports,
    transport: options.transport ?? createTransport(),
    close: closePool,
  };
}
