/**
 * `ctx.query` against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://... pnpm test:live
 *
 * The deterministic suite proves the STATEMENTS are issued. Only a server can
 * prove they mean anything: that `begin read only` really refuses a write from
 * a role that holds every grant, that a refused write leaves the pooled
 * connection usable, that the statement timeout is real, and — if membership
 * has been granted — that `set role tmos_analyst` removes the privilege rather
 * than merely the opportunity.
 *
 * These cases deliberately do NOT run inside `inRollback`. `createResolverQuery`
 * checks out its OWN connection and opens its own read-only transaction, which
 * is the whole point (enlisting would leave the caller's transaction read-only
 * for the rest of its life, and the caller writes the resolution immediately
 * afterwards). Its transaction is always rolled back, so nothing here can leave
 * a row behind either — a write is what these cases are trying to fail at.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { db, sql } from '@tmos/db';
import { closePool } from '@tmos/db';

import { HAS_DATABASE } from '../testing/live.js';
import { RESOLVER_ROLE, createResolverQuery } from './resolver-context.js';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

/** `role: null` throughout: `tmos_analyst` is NOLOGIN and membership is granted
 *  out of band, so a default-role run fails on every machine that has not done
 *  it. That failure is the subject of the last case, not a precondition here. */
const query = () => createResolverQuery({ role: null });

describe.skipIf(!HAS_DATABASE)('ctx.query is read-only, and the server is what says so', () => {
  it('reads', async () => {
    expect(await query()('select 1 as ok')).toEqual([{ ok: 1 }]);
  });

  it('refuses a write, whatever the spec says and whatever grants the role holds', async () => {
    await expect(
      query()(
        "insert into prediction (claim, p, author, resolve_at, resolver, evidence_snapshot_hash) values ('x', 0.5, 'human:x', now(), '{}'::jsonb, 'h')",
      ),
    ).rejects.toThrow(/read-only transaction/i);
  });

  it('refuses DDL, which a keyword blocklist over a string is poor at catching', async () => {
    await expect(query()('create temp table tmos_resolver_probe (x int)')).rejects.toThrow(
      /read-only transaction/i,
    );
  });

  it('returns the connection clean after a refusal, rather than poisoned', async () => {
    await expect(query()('delete from fact')).rejects.toThrow();
    // A pooled connection left inside an aborted transaction fails every later
    // borrower with "current transaction is aborted". This is the assertion
    // that the rollback in the `finally` is doing its job.
    expect(await query()('select 2 as ok')).toEqual([{ ok: 2 }]);
    expect(await db().one(sql`select 3 as ok`)).toEqual({ ok: 3 });
  });

  it('cancels a runaway query at the statement timeout', async () => {
    await expect(
      createResolverQuery({ role: null, statementTimeoutMs: 100 })('select pg_sleep(3)'),
    ).rejects.toThrow(/statement timeout|canceling statement/i);
  });

  it('drops privilege when tmos_analyst membership exists, and says so loudly when it does not', async () => {
    const { member } = await db().one<{ member: boolean }>(
      sql`select pg_has_role(current_user, ${RESOLVER_ROLE}, 'member') as member`,
    );

    if (!member) {
      // Not a silent skip: this is the default configuration, and it means
      // every sql resolver annuls until someone runs
      //   create role tmos_analyst_login login password '…';
      //   grant tmos_analyst to tmos_analyst_login;
      // and points the resolver connection at it (migration 006).
      await expect(createResolverQuery({})('select 1')).rejects.toThrow(
        /permission denied|must be (a )?member/i,
      );
      return;
    }

    // 006 revokes `prediction` from the role on purpose: a resolver that could
    // read the ledger could read the answer to its own question.
    expect(await createResolverQuery({})('select 1 as ok')).toEqual([{ ok: 1 }]);
    await expect(createResolverQuery({})('select count(*) from prediction')).rejects.toThrow(
      /permission denied/i,
    );
  });
});
