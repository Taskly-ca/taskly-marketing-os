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

  // These prove the transaction boundary with DML on a real table, NOT with DDL.
  // Migration 011 revoked CREATE on schema `public` from everything except the
  // owner, and the application connects as an unprivileged member of
  // service_role — so `create table` here fails with "permission denied for
  // schema public" and proves nothing about COMMIT. Using a real table is also
  // the more honest test: it runs the path the adapters actually run, RLS
  // included, rather than a DDL path no production code takes.
  it('ROLLBACKs a transaction that throws — the row is gone', async () => {
    const name = `${PROBE}-rollback-${Date.now()}`;

    await expect(
      withTx(async (tx) => {
        await tx.execute(
          sql`insert into source (kind, name, tier) values ('probe', ${name}, 'primary')`,
        );
        // Visible to its own transaction, before we abort it.
        const seen = await tx.one<{ n: number }>(
          sql`select count(*)::int as n from source where name = ${name}`,
        );
        expect(seen.n).toBe(1);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    const row = await db().one<{ n: number }>(
      sql`select count(*)::int as n from source where name = ${name}`,
    );
    expect(row.n).toBe(0);
  });

  it('COMMITs when the body returns — and cleans up after itself', async () => {
    const name = `${PROBE}-commit-${Date.now()}`;

    await withTx(async (tx) => {
      await tx.execute(
        sql`insert into source (kind, name, tier) values ('probe', ${name}, 'primary')`,
      );
    });

    const row = await db().one<{ n: number }>(
      sql`select count(*)::int as n from source where name = ${name}`,
    );
    expect(row.n).toBe(1);

    await db().execute(sql`delete from source where name = ${name}`);
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
