/**
 * The migrate CLI's two pure parts.
 *
 * `--adopt-through` is the only thing in this repo that can tell a database it
 * is up to date when it is not, so its refusals are what is tested: a number
 * that names no migration, and a range with a hole in it. The database-side
 * refusals (a ledger that already has rows, a schema with no `entity` table)
 * need a database and live in the live suite.
 */
import { describe, expect, it } from 'vitest';
import type { MigrationFile } from '@tmos/db';

import { MIGRATOR_URL_ENV, loadMigratorConfig, parseArgs, planAdoption } from './migrate.js';

const file = (number: number): MigrationFile => ({
  number,
  filename: `${String(number).padStart(3, '0')}_thing.sql`,
  sql: `-- ${number}`,
  checksum: `sum${number}`,
});

const FILES = [1, 2, 3, 4].map(file);

describe('parseArgs', () => {
  it('defaults to applying what is pending', () => {
    expect(parseArgs([])).toEqual({ status: false, adoptThrough: null, help: false });
  });

  it('reads --adopt-through in both spellings', () => {
    expect(parseArgs(['--adopt-through', '14']).adoptThrough).toBe(14);
    expect(parseArgs(['--adopt-through=14']).adoptThrough).toBe(14);
  });

  it('ignores the -- that pnpm forwards', () => {
    expect(parseArgs(['--', '--status']).status).toBe(true);
  });

  it('refuses a non-number, rather than adopting through NaN', () => {
    expect(() => parseArgs(['--adopt-through', 'all'])).toThrow(/needs a migration number/);
    expect(() => parseArgs(['--adopt-through', '0'])).toThrow(/needs a migration number/);
  });

  it('refuses to both report and change in one run', () => {
    expect(() => parseArgs(['--status', '--adopt-through', '3'])).toThrow(/one at a time/);
  });

  it('refuses an argument it does not know', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown argument/);
  });
});

describe('planAdoption', () => {
  it('takes everything at or below the named migration', () => {
    expect(planAdoption(FILES, 3).map((f) => f.number)).toEqual([1, 2, 3]);
  });

  it('refuses a number that names no migration', () => {
    // 9 would silently mean "everything up to 4", which is not what the
    // operator typed and not a range they checked.
    expect(() => planAdoption(FILES, 9)).toThrow(/highest migration at or below it is 4/);
    expect(() => planAdoption(FILES, 0)).toThrow(/nothing to adopt/);
  });

  it('refuses a range with a hole in it', () => {
    const gapped = [file(1), file(2), file(4)];
    expect(() => planAdoption(gapped, 4)).toThrow(/not contiguous/);
  });
});

describe('loadMigratorConfig', () => {
  it('refuses to run with no migrator connection', () => {
    expect(() => loadMigratorConfig({})).toThrow(new RegExp(MIGRATOR_URL_ENV));
  });

  it('refuses a migrator connection that is the app connection', () => {
    // Either migrations would run as the app role, which 011 forbids, or the
    // worker runs as the owner, which is the separation 011 exists to create.
    const url = 'postgres://tmos_app_login:x@host:5432/postgres';
    expect(() => loadMigratorConfig({ DATABASE_URL: url, [MIGRATOR_URL_ENV]: url })).toThrow(
      /same string as DATABASE_URL/,
    );
  });

  it('gives a migration room to run long', () => {
    const cfg = loadMigratorConfig({
      DATABASE_URL: 'postgres://app@host:5432/postgres',
      [MIGRATOR_URL_ENV]: 'postgres://postgres@host:5432/postgres',
    });
    expect(cfg.statementTimeoutMs).toBeGreaterThanOrEqual(600_000);
    expect(cfg.poolMax).toBeLessThanOrEqual(2);
  });
});
