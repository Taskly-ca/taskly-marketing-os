import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  checksumOf,
  migrationsDir,
  readMigrations,
  planMigrations,
  migrate,
  MigrationIntegrityError,
  type AppliedMigration,
  type MigrationDriver,
  type MigrationFile,
} from './migrate.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tmos-migrations-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string): void => writeFileSync(join(dir, name), body, 'utf8');

const file = (n: number, name: string, body: string): MigrationFile => ({
  number: n,
  filename: name,
  sql: body,
  checksum: checksumOf(body),
});

const asApplied = (f: MigrationFile): AppliedMigration => ({
  number: f.number,
  filename: f.filename,
  checksum: f.checksum,
});

/** Records what a real driver would have executed. No database involved. */
function fakeDriver(applied: AppliedMigration[] = []) {
  const ran: string[] = [];
  let ensured = 0;
  const driver: MigrationDriver = {
    async ensure() {
      ensured += 1;
    },
    async applied() {
      return [...applied];
    },
    async apply(f) {
      ran.push(f.filename);
      applied.push(asApplied(f));
    },
  };
  return {
    driver,
    ran,
    get ensured() {
      return ensured;
    },
  };
}

describe('reading migrations', () => {
  it('reads the repo migrations from the workspace root by default', () => {
    const files = readMigrations();
    expect(migrationsDir().endsWith('supabase/migrations')).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files[0]?.filename).toBe('001_core.sql');
    expect(files.map((f) => f.number)).toEqual(
      [...files.map((f) => f.number)].sort((a, b) => a - b),
    );
  });

  it('checksums the exact bytes of the file', () => {
    write('001_core.sql', 'create table a();');
    const [f] = readMigrations(dir);
    expect(f?.checksum).toBe(checksumOf('create table a();'));
    expect(f?.checksum).toHaveLength(64);
  });

  it('rejects a filename that breaks the NNN_snake_case.sql convention', () => {
    write('1_core.sql', 'select 1;');
    expect(() => readMigrations(dir)).toThrow(MigrationIntegrityError);
  });

  it('rejects two files claiming the same number', () => {
    write('001_core.sql', 'select 1;');
    write('001_other.sql', 'select 2;');
    expect(() => readMigrations(dir)).toThrow(/duplicate/i);
  });
});

describe('ordering', () => {
  it('is numeric, not lexicographic', () => {
    const files = [
      file(10, '010_ten.sql', 'j'),
      file(2, '002_two.sql', 'b'),
      file(1, '001_one.sql', 'a'),
      file(9, '009_nine.sql', 'i'),
    ];
    expect(planMigrations(files, []).map((f) => f.filename)).toEqual([
      '001_one.sql',
      '002_two.sql',
      '009_nine.sql',
      '010_ten.sql',
    ]);
  });

  it('applies in strict numeric order through migrate()', async () => {
    write('002_second.sql', 'create table b();');
    write('001_first.sql', 'create table a();');
    write('003_third.sql', 'create table c();');
    const d = fakeDriver();
    const res = await migrate({ dir, driver: d.driver });

    expect(d.ran).toEqual(['001_first.sql', '002_second.sql', '003_third.sql']);
    expect(res.applied).toEqual(['001_first.sql', '002_second.sql', '003_third.sql']);
    expect(d.ensured).toBe(1);
  });

  it('is IDEMPOTENT — a second run applies nothing', async () => {
    write('001_first.sql', 'create table a();');
    write('002_second.sql', 'create table b();');
    const d = fakeDriver();

    await migrate({ dir, driver: d.driver });
    const second = await migrate({ dir, driver: d.driver });

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(2);
    expect(d.ran).toHaveLength(2);
  });

  it('applies only what is pending', async () => {
    write('001_first.sql', 'create table a();');
    write('002_second.sql', 'create table b();');
    const known = readMigrations(dir);
    const d = fakeDriver(known.slice(0, 1).map(asApplied));

    const res = await migrate({ dir, driver: d.driver });
    expect(res.applied).toEqual(['002_second.sql']);
  });

  it('REFUSES a migration inserted behind the cursor', () => {
    const files = [file(1, '001_one.sql', 'a'), file(2, '002_two.sql', 'b')];
    const applied = [asApplied(file(2, '002_two.sql', 'b'))];
    expect(() => planMigrations(files, applied)).toThrow(MigrationIntegrityError);
    expect(() => planMigrations(files, applied)).toThrow(/001_one\.sql/);
  });
});

describe('checksum enforcement', () => {
  it('REFUSES to run when an applied migration was edited — hard error', () => {
    const original = file(1, '001_one.sql', 'create table a();');
    const edited = file(1, '001_one.sql', 'create table a(); -- one more thing');
    expect(() => planMigrations([edited], [asApplied(original)])).toThrow(MigrationIntegrityError);
    expect(() => planMigrations([edited], [asApplied(original)])).toThrow(/checksum/i);
  });

  it('applies NOTHING when a checksum mismatch is detected', async () => {
    write('001_first.sql', 'create table a();');
    write('002_second.sql', 'create table b();');
    const d = fakeDriver([asApplied(file(1, '001_first.sql', 'something else entirely'))]);

    await expect(migrate({ dir, driver: d.driver })).rejects.toThrow(MigrationIntegrityError);
    // The pending 002 must NOT have slipped through before the error.
    expect(d.ran).toEqual([]);
  });

  it('REFUSES when an applied migration disappeared from disk', () => {
    expect(() => planMigrations([], [asApplied(file(1, '001_one.sql', 'a'))])).toThrow(
      /no longer exists|missing/i,
    );
  });

  it('REFUSES when an applied migration was renamed', () => {
    const applied = asApplied(file(1, '001_one.sql', 'a'));
    expect(() => planMigrations([file(1, '001_renamed.sql', 'a')], [applied])).toThrow(
      /renam|001_one\.sql/i,
    );
  });

  it('names the file and both checksums so the fix is obvious', () => {
    const original = file(7, '007_x.sql', 'a');
    const edited = file(7, '007_x.sql', 'b');
    try {
      planMigrations([edited], [asApplied(original)]);
      expect.unreachable('should have refused');
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('007_x.sql');
      expect(m).toContain(original.checksum);
      expect(m).toContain(edited.checksum);
    }
  });
});
