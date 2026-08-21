/**
 * The migration runner.
 *
 * Reads `supabase/migrations/NNN_*.sql` from the workspace root, applies what
 * is missing in strict numeric order, and records each one in
 * `schema_migrations` with the sha256 of its contents.
 *
 * The checksum is the point. Editing an already-applied migration is the
 * failure mode that a numbering gate cannot catch: the file and the database
 * disagree, every fresh environment gets the new text, every existing one keeps
 * the old, and nothing says so. So a mismatch is a hard refusal — never a
 * warning — and the refusal happens BEFORE anything is applied, so a broken
 * history cannot half-migrate a database on its way to reporting the problem.
 *
 * Correcting an applied migration means writing a NEW one. Always.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { getPool } from './pool.js';

const FILENAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  readonly number: number;
  readonly filename: string;
  readonly sql: string;
  /** sha256 of the file's exact bytes, hex. */
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly number: number;
  readonly filename: string;
  readonly checksum: string;
}

export interface MigrateResult {
  /** Filenames applied by this run, in the order they were applied. */
  readonly applied: readonly string[];
  /** How many were already recorded before this run. */
  readonly alreadyApplied: number;
}

/** A refusal, not a failure: the history on disk and the history in the
 *  database disagree, and guessing which one is right is not this tool's job. */
export class MigrationIntegrityError extends Error {
  override readonly name = 'MigrationIntegrityError';
}

export const checksumOf = (sql: string): string =>
  createHash('sha256').update(sql, 'utf8').digest('hex');

const pad = (n: number): string => String(n).padStart(3, '0');

/** Walks up from this file to the workspace root — works from `src` and `dist`. */
export function migrationsDir(from: string = import.meta.dirname): string {
  let at = resolve(from);
  for (;;) {
    if (existsSync(join(at, 'pnpm-workspace.yaml'))) return join(at, 'supabase/migrations');
    const up = dirname(at);
    if (up === at) {
      throw new MigrationIntegrityError(
        `could not locate the workspace root (no pnpm-workspace.yaml above ${from})`,
      );
    }
    at = up;
  }
}

export function readMigrations(dir: string = migrationsDir()): MigrationFile[] {
  const seen = new Map<number, string>();
  const files: MigrationFile[] = [];

  for (const filename of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const match = FILENAME.exec(filename);
    if (match?.[1] === undefined) {
      throw new MigrationIntegrityError(
        `${filename}: migration filenames must match NNN_snake_case.sql`,
      );
    }
    const number = Number(match[1]);
    const clash = seen.get(number);
    if (clash !== undefined) {
      throw new MigrationIntegrityError(
        `duplicate migration number ${pad(number)}: ${clash} and ${filename}`,
      );
    }
    seen.set(number, filename);

    const sql = readFileSync(join(dir, filename), 'utf8');
    files.push({ number, filename, sql, checksum: checksumOf(sql) });
  }

  return files.sort((a, b) => a.number - b.number);
}

/**
 * Pure. Returns what still needs applying, or throws if the recorded history
 * cannot be reconciled with the files on disk.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationFile[] {
  const byNumber = new Map(files.map((f) => [f.number, f]));
  const history = [...applied].sort((a, b) => a.number - b.number);

  for (const record of history) {
    const file = byNumber.get(record.number);
    if (file === undefined) {
      throw new MigrationIntegrityError(
        `migration ${pad(record.number)} (${record.filename}) is recorded as applied but no ` +
          'longer exists on disk. Restore the file — migration history is append-only.',
      );
    }
    if (file.filename !== record.filename) {
      throw new MigrationIntegrityError(
        `migration ${pad(record.number)} was applied as "${record.filename}" but is now named ` +
          `"${file.filename}". Renaming an applied migration rewrites history; restore the name.`,
      );
    }
    if (file.checksum !== record.checksum) {
      throw new MigrationIntegrityError(
        `checksum mismatch for ${file.filename}: applied as ${record.checksum}, file is now ` +
          `${file.checksum}. An already-applied migration was edited — every environment that ` +
          'ran the old text now disagrees with this file. Revert it and write a NEW migration.',
      );
    }
  }

  const appliedNumbers = new Set(history.map((r) => r.number));
  const highest = history.at(-1)?.number ?? 0;
  const pending = files
    .filter((f) => !appliedNumbers.has(f.number))
    .sort((a, b) => a.number - b.number);

  const behind = pending.filter((f) => f.number < highest);
  if (behind.length > 0) {
    throw new MigrationIntegrityError(
      `${behind.map((f) => f.filename).join(', ')} ${behind.length === 1 ? 'is' : 'are'} numbered ` +
        `below the highest applied migration (${pad(highest)}). Applying it now would run in a ` +
        'different order than it did elsewhere. Renumber it above ' +
        `${pad(highest)} (see \`pnpm check:migrations\`).`,
    );
  }

  return pending;
}

/** What `migrate` needs from a database. Faked in the deterministic suite. */
export interface MigrationDriver {
  ensure(): Promise<void>;
  applied(): Promise<AppliedMigration[]>;
  /** One migration, one transaction: the file, then its ledger row. */
  apply(file: MigrationFile): Promise<void>;
}

const CREATE_LEDGER = `create table if not exists schema_migrations (
  "number"   integer     primary key,
  filename   text        not null,
  checksum   text        not null,
  applied_at timestamptz not null default now()
)`;

type AppliedRow = { number: number; filename: string; checksum: string };

export function createPoolDriver(): MigrationDriver {
  return {
    async ensure() {
      await getPool().query(CREATE_LEDGER);
    },

    async applied() {
      const res = await getPool().query<AppliedRow>(
        'select "number", filename, checksum from schema_migrations order by "number"',
      );
      return res.rows.map((r) => ({
        number: Number(r.number),
        filename: r.filename,
        checksum: r.checksum,
      }));
    },

    async apply(file) {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        // The one place raw SQL text is legitimate: a migration is a
        // multi-statement script, which the parameterised protocol cannot send.
        // It is repo-authored, never user input. The app-level statement
        // timeout is lifted for the transaction so a long DDL is not cancelled
        // half way through.
        await client.query('set local statement_timeout = 0');
        await client.query(file.sql);
        await client.query(
          'insert into schema_migrations ("number", filename, checksum) values ($1, $2, $3)',
          [file.number, file.filename, file.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${file.filename} failed and was rolled back`, { cause: error });
      } finally {
        client.release();
      }
    },
  };
}

export interface MigrateOptions {
  readonly dir?: string;
  readonly driver?: MigrationDriver;
}

export async function migrate(options: MigrateOptions = {}): Promise<MigrateResult> {
  const files = readMigrations(options.dir);
  const driver = options.driver ?? createPoolDriver();

  await driver.ensure();
  const history = await driver.applied();

  // Throws before a single statement is applied.
  const pending = planMigrations(files, history);

  const applied: string[] = [];
  for (const file of pending) {
    await driver.apply(file);
    applied.push(file.filename);
  }

  return { applied, alreadyApplied: history.length };
}
