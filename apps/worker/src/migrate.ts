/**
 * `pnpm --filter @tmos/worker migrate` — the runner, finally given a door.
 *
 * `packages/db/src/migrate.ts` has existed since the Postgres access layer
 * landed: ordered, transactional, checksum-enforced, and refusing before it
 * applies anything when the files and the history disagree. Nothing ever called
 * it. Migrations 001–014 were applied by hand through the dashboard, so
 * `schema_migrations` does not exist on the live database and the only way to
 * answer "what is applied?" is to probe for the objects each migration creates.
 * That is the state this file ends.
 *
 * ── WHY `--adopt` EXISTS, AND WHY IT IS NOT THE DEFAULT
 *
 * A checksum ledger cannot be back-filled by running the migrations: they are
 * already applied, and `create table` is not idempotent. The only way to
 * reconcile a hand-migrated database is for an operator to ASSERT that a range
 * was applied, and for the tool to record the checksums so that everything
 * AFTER that point is enforced normally.
 *
 * That assertion is the one thing here that can quietly corrupt a database, so
 * it is a separate flag, it names the range explicitly, it refuses when the
 * ledger already has rows, and it refuses when the schema shows no sign of
 * having been migrated at all — adopting 014 migrations onto an empty database
 * would leave a system that believes it is up to date and has no tables.
 *
 * What it deliberately does NOT do is verify that each adopted migration really
 * ran. Nothing can, after the fact: that is precisely the information a ledger
 * exists to keep and which was never kept. The flag records an operator's claim
 * and says so.
 *
 * ── THE APP ROLE CANNOT MIGRATE, AND MUST NOT BE ABLE TO
 *
 * The first run of this CLI against the live database failed with `permission
 * denied for schema public`, which is migration 011 working exactly as
 * written: the worker authenticates as `tmos_app_login`, which holds USAGE on
 * `public` and not CREATE. A process that reads competitor pages all day has no
 * business being able to create a table.
 *
 * So migrations need their own connection, exactly as the analytical escape
 * hatch does — `DATABASE_MIGRATOR_URL`, authenticating as the database owner.
 * There is deliberately no fallback to `DATABASE_URL`: the alternative to a
 * second connection string is granting CREATE back to the app role, which
 * undoes 011 permanently in order to save one line of configuration.
 */
import { pathToFileURL } from 'node:url';

import {
  checksumOf,
  closePool,
  db,
  getPool,
  migrate,
  planMigrations,
  readMigrations,
  sql,
  sslFor,
  type DbConfig,
  type MigrationFile,
} from '@tmos/db';

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

interface MigrateArgs {
  readonly status: boolean;
  readonly adoptThrough: number | null;
  readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): MigrateArgs {
  let status = false;
  let adoptThrough: number | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--' || arg === undefined) continue;
    if (arg === '--status') status = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--adopt-through' || arg?.startsWith('--adopt-through=')) {
      const raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--adopt-through needs a migration number, got ${JSON.stringify(raw)}`);
      }
      adoptThrough = n;
    } else throw new Error(`unknown argument: ${arg}`);
  }

  if (status && adoptThrough !== null) {
    throw new Error('--status and --adopt-through do different things; run one at a time');
  }
  return { status, adoptThrough, help };
}

export const MIGRATOR_URL_ENV = 'DATABASE_MIGRATOR_URL';

/**
 * The privileged connection, and the refusal that keeps it separate.
 *
 * Mirrors `loadAnalystDbConfig`: a distinct variable, no fallback, and an
 * explicit error when it is the same string as `DATABASE_URL` — which would
 * mean either that migrations run as the app role (they cannot, since 011) or
 * that the app runs as the owner (it must not).
 */
export function loadMigratorConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env[MIGRATOR_URL_ENV]?.trim();
  if (!url) {
    throw new Error(
      `${MIGRATOR_URL_ENV} is required and is not set. It is a SEPARATE connection string from ` +
        'DATABASE_URL, authenticating as the database owner (`postgres` on Supabase). The app ' +
        'role holds USAGE and not CREATE on schema public — migration 011 — so it cannot apply ' +
        'a migration, and granting it CREATE to avoid this variable would undo 011 permanently.',
    );
  }
  if (env.DATABASE_URL !== undefined && url === env.DATABASE_URL.trim()) {
    throw new Error(
      `${MIGRATOR_URL_ENV} is the same string as DATABASE_URL. Either migrations would run as ` +
        'the app role, which 011 forbids, or the worker runs as the database owner, which is ' +
        'the privilege separation 011 exists to create.',
    );
  }
  // Statement timeout comes from the pool config and a migration is the one
  // thing that may legitimately run long; `createPoolDriver` lifts it per
  // transaction, and a generous pool-level ceiling keeps a DDL from being
  // cancelled before it gets there.
  return {
    url,
    poolMax: 2,
    statementTimeoutMs: 600_000,
    connectionTimeoutMs: 10_000,
    ssl: sslFor(url),
  };
}

const USAGE = `tmos migrate — apply what is missing, in order, with checksums

  (no flags)              apply every pending migration
  --status                list applied and pending, change nothing
  --adopt-through <n>     record 001..n as applied WITHOUT running them.
                          For a database migrated by hand before the ledger
                          existed. Refuses if the ledger already has rows or if
                          the schema looks unmigrated. Records an operator's
                          claim — it cannot verify one.
  --help`;

/** The files an adoption would record, or an error explaining why it may not. */
export function planAdoption(
  files: readonly MigrationFile[],
  through: number,
): MigrationFile[] {
  const chosen = files.filter((f) => f.number <= through).sort((a, b) => a.number - b.number);
  if (chosen.length === 0) {
    throw new Error(`no migrations at or below ${through} — nothing to adopt`);
  }
  const highest = chosen.at(-1)?.number ?? 0;
  if (highest !== through) {
    throw new Error(
      `--adopt-through ${through} but the highest migration at or below it is ${highest}; ` +
        'name a number that exists so the range is unambiguous',
    );
  }
  const missing = chosen.filter((f, i) => f.number !== i + 1);
  if (missing.length > 0) {
    throw new Error(
      `migrations below ${through} are not contiguous (first gap at ${missing[0]?.filename}); ` +
        'adopting a range with a hole in it records a history that never happened',
    );
  }
  return chosen;
}

async function ledgerRows(): Promise<number> {
  const rows = await db().query<{ n: number }>(
    sql`select count(*)::int as n from information_schema.tables
         where table_schema = 'public' and table_name = 'schema_migrations'`,
  );
  if ((rows[0]?.n ?? 0) === 0) return 0;
  const count = await db().query<{ n: number }>(sql`select count(*)::int as n from schema_migrations`);
  return count[0]?.n ?? 0;
}

/** Migration 001 creates `entity`. Its absence means nothing has been applied. */
async function schemaLooksMigrated(): Promise<boolean> {
  const rows = await db().query<{ n: number }>(
    sql`select count(*)::int as n from information_schema.tables
         where table_schema = 'public' and table_name = 'entity'`,
  );
  return (rows[0]?.n ?? 0) > 0;
}

async function adopt(through: number): Promise<number> {
  const chosen = planAdoption(readMigrations(), through);

  if ((await ledgerRows()) > 0) {
    throw new Error(
      'schema_migrations already has rows — adoption is for a database that predates the ' +
        'ledger. Run without flags to apply what is pending.',
    );
  }
  if (!(await schemaLooksMigrated())) {
    throw new Error(
      'the `entity` table does not exist, so migration 001 has not run and this database has ' +
        'not been migrated by hand. Run without flags to apply everything properly.',
    );
  }

  await db().execute(sql`
    create table if not exists schema_migrations (
      "number"   integer     primary key,
      filename   text        not null,
      checksum   text        not null,
      applied_at timestamptz not null default now()
    )`);

  for (const f of chosen) {
    await db().execute(sql`
      insert into schema_migrations ("number", filename, checksum)
      values (${f.number}, ${f.filename}, ${checksumOf(f.sql)})`);
    write(`  adopted  ${f.filename}`);
  }
  return chosen.length;
}

async function status(): Promise<void> {
  const files = readMigrations();
  if ((await ledgerRows()) === 0) {
    write('schema_migrations: absent or empty.');
    write(`${files.length} migration file(s) on disk, none recorded as applied.`);
    write('');
    write('If this database was migrated by hand, adopt the range you applied:');
    write(`  pnpm --filter @tmos/worker migrate -- --adopt-through ${files.at(-1)?.number ?? 1}`);
    return;
  }

  const applied = await db().query<{ number: number; filename: string; applied_at: string }>(
    sql`select "number", filename, applied_at::text as applied_at from schema_migrations order by "number"`,
  );
  for (const r of applied) write(`  applied  ${r.filename}  ${r.applied_at}`);

  const pending = planMigrations(
    files,
    await db().query<{ number: number; filename: string; checksum: string }>(
      sql`select "number", filename, checksum from schema_migrations order by "number"`,
    ),
  );
  for (const f of pending) write(`  PENDING  ${f.filename}`);
  write('');
  write(`${applied.length} applied, ${pending.length} pending.`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    write(USAGE);
    return 0;
  }

  /**
   * Built BEFORE anything queries. `getPool` reads its config only when there is
   * no pool yet, so this one call decides the identity of every statement in the
   * process — including `--status`, which is a read and could have used the app
   * role, but reporting on a ledger through a different connection than the one
   * that writes it is how two answers to one question start existing.
   */
  getPool(loadMigratorConfig());

  try {
    if (args.status) {
      await status();
      return 0;
    }
    if (args.adoptThrough !== null) {
      write(`adopting 001..${String(args.adoptThrough).padStart(3, '0')} as already applied.`);
      write('This records an operator claim; it cannot verify that they ran.');
      const n = await adopt(args.adoptThrough);
      write(`\n${n} migration(s) adopted. Everything after this is enforced normally.`);
      return 0;
    }
    const result = await migrate();
    for (const f of result.applied) write(`  applied  ${f}`);
    write(`\n${result.applied.length} applied, ${result.alreadyApplied} already recorded.`);
    return 0;
  } finally {
    await closePool();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`migrate failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
