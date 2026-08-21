/**
 * The LIVE database suite — opt-in, never run by CI.
 *
 * `pnpm test` excludes `*.live.test.ts`, and every describe below skips itself
 * when DATABASE_URL is unset, so a machine without a database still gets a
 * green, silent run rather than a wall of connection errors.
 *
 *   DATABASE_URL=postgres://... pnpm test:live
 *
 * The migration block needs a SECOND opt-in (TMOS_DB_LIVE_MIGRATE=1) because it
 * writes DDL. Nothing else here leaves anything behind.
 */
import { describe, it, expect, afterAll } from 'vitest';

import { sql } from './sql.js';
import { db, withTx } from './tx.js';
import { closePool, getPool } from './pool.js';
import { migrate } from './migrate.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const PROBE = 'tmos_db_live_probe';

afterAll(async () => {
  if (HAS_DB) await closePool();
});

describe.skipIf(!HAS_DB)('live postgres', () => {
  it('connects and answers', async () => {
    const row = await db().one<{ ok: number }>(sql`select 1 as ok`);
    expect(row.ok).toBe(1);
  });

  it('parameterises for real — an injection payload comes back as data', async () => {
    const evil = "'; drop table facts; --";
    const row = await db().one<{ v: string }>(sql`select ${evil}::text as v`);
    expect(row.v).toBe(evil);
  });

  it('ROLLBACKs a transaction that throws — the DDL is gone', async () => {
    await expect(
      withTx(async (tx) => {
        await tx.execute(sql`create table tmos_db_live_probe (id int)`);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    const row = await db().one<{ t: string | null }>(
      sql`select to_regclass(${`public.${PROBE}`})::text as t`,
    );
    expect(row.t).toBeNull();
  });

  it('COMMITs when the body returns — and cleans up after itself', async () => {
    await withTx(async (tx) => {
      await tx.execute(sql`create table tmos_db_live_probe (id int)`);
    });
    const row = await db().one<{ t: string | null }>(
      sql`select to_regclass(${`public.${PROBE}`})::text as t`,
    );
    expect(row.t).toBe(PROBE);
    await db().execute(sql`drop table tmos_db_live_probe`);
  });

  it('enforces the statement timeout it configured', async () => {
    const pool = getPool();
    const res = await pool.query<{ v: string }>('show statement_timeout');
    expect(res.rows[0]?.v).not.toBe('0');
  });
});

describe.skipIf(!HAS_DB || process.env.TMOS_DB_LIVE_MIGRATE !== '1')('live migrations', () => {
  it('applies the repo migrations, then is a no-op', async () => {
    const first = await migrate();
    expect(Array.isArray(first.applied)).toBe(true);

    const second = await migrate();
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBeGreaterThan(0);
  }, 120_000);
});
