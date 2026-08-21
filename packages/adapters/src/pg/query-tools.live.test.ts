/**
 * The four remaining ports against the real database. Opt-in, never run by CI.
 *
 * The block that matters most is the last one. `DATABASE_URL` is the SERVICE
 * connection, and the whole design of `createPostgresQueryExecutor` rests on a
 * claim about it that has never been checked against a real server: that it
 * authenticates as a role the analytical executor must refuse. If that
 * assertion ever fails, either the connection string was pointed somewhere
 * unexpected or the boundary is not where this package says it is — and both
 * are worth a red test rather than a comment.
 *
 * The source-graph block is the other one only a database can answer: the
 * recursive CTE's cycle guard cannot be exercised without a cycle, and
 * `source.derives_from` has no constraint preventing one.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  closePool,
  connectFromPool,
  sql,
  type Executor,
  type PooledClient,
} from '@tmos/db';

import { AdapterError, ConstraintError, NotFoundError } from '../errors.js';
import { HAS_DATABASE, inRollback } from '../testing/live.js';
import { insertEntity } from './entity-directory.js';
import { insertFact } from './fact-store.js';
import {
  ANALYST_ROLE,
  assertAnalystSession,
  createPostgresQueryExecutor,
  factsWithPredicate,
  insertFactConflict,
  openConflictsFor,
  probeSession,
  resolveFactConflict,
  sourceRootOf,
} from './query-tools.js';

const CONF = 'tmos_conf';
const T0 = '2026-07-01T00:00:00.000Z';
const T1 = '2026-07-15T00:00:00.000Z';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

interface Fixtures {
  readonly entityId: string;
  readonly otherEntityId: string;
  readonly predicate: string;
  readonly sourceId: string;
}

async function seed(tx: Executor, tag: string): Promise<Fixtures> {
  const source = await tx.one<{ id: string }>(sql`
    insert into source (kind, name, tier, region)
    values ('test', ${`${CONF}_${tag}`}, 'first_party', 'ca')
    returning id::text as id`);
  const entity = await insertEntity(
    { entityType: 'company', name: `${CONF} ${tag} A`, region: 'ca' },
    tx,
  );
  const other = await insertEntity(
    { entityType: 'company', name: `${CONF} ${tag} B`, region: 'ca' },
    tx,
  );

  const predicate = `${CONF}_${tag}_price`;
  await tx.execute(sql`
    insert into predicate_def (predicate, entity_type, datatype, description)
    values (${predicate}, 'company', 'num', 'live fixture')
    on conflict (predicate) do nothing`);

  return {
    entityId: entity.entityId,
    otherEntityId: other.entityId,
    predicate,
    sourceId: source.id,
  };
}

const fact = (fx: Fixtures, num: number, over: Record<string, unknown> = {}) => ({
  entityId: fx.entityId,
  predicate: fx.predicate,
  value: { datatype: 'num' as const, num },
  valid: { from: T0, to: null },
  asserted: { from: T0, to: null },
  sourceId: fx.sourceId,
  observedAt: T0,
  confidence: 0.9,
  method: 'scrape' as const,
  evidence: {},
  supersedes: null,
  status: 'active' as const,
  ...over,
});

/* ── ConflictPort ───────────────────────────────────────────────────────── */

describe.skipIf(!HAS_DATABASE)('fact_conflict', () => {
  it('files a conflict, lists it while open, and hides it once resolved', async () => {
    await inRollback(async (tx) => {
      const fx = await seed(tx, 'conflict');
      const a = await insertFact(fact(fx, 9900), tx);
      const b = await insertFact(fact(fx, 11900), tx);

      const filed = await insertFactConflict(
        {
          entityId: fx.entityId,
          predicate: fx.predicate,
          validInstant: T0,
          factIds: [a.factId, b.factId],
          kind: 'factual',
        },
        tx,
      );

      expect(filed.status).toBe('open');
      expect(filed.factIds.sort()).toEqual([a.factId, b.factId].sort());
      expect(filed.resolution).toBeNull();
      // `created_at` is the one instant the database supplies here.
      expect(filed.createdAt).toMatch(/^\d{4}-/);

      const open = await openConflictsFor(fx.entityId, tx);
      expect(open.map((c) => c.id)).toEqual([filed.id]);

      const resolved = await resolveFactConflict(
        filed.id,
        {
          status: 'resolved',
          resolution: 'the api reading won on reliability',
          resolvedBy: 'analyst@taskly.ca',
          resolvedAt: T1,
        },
        tx,
      );

      expect(resolved.status).toBe('resolved');
      expect(resolved.resolvedAt).toBe(T1);
      expect(await openConflictsFor(fx.entityId, tx)).toEqual([]);
    });
  });

  it('refuses a second resolution WITHOUT poisoning the transaction', async () => {
    await inRollback(async (tx) => {
      const fx = await seed(tx, 'reresolve');
      const a = await insertFact(fact(fx, 100), tx);
      const b = await insertFact(fact(fx, 200), tx);
      const filed = await insertFactConflict(
        {
          entityId: fx.entityId,
          predicate: fx.predicate,
          validInstant: T0,
          factIds: [a.factId, b.factId],
          kind: 'factual',
        },
        tx,
      );
      const resolution = {
        status: 'resolved' as const,
        resolution: 'first',
        resolvedBy: 'analyst@taskly.ca',
        resolvedAt: T1,
      };
      await resolveFactConflict(filed.id, resolution, tx);

      await expect(
        resolveFactConflict(filed.id, { ...resolution, resolution: 'second' }, tx),
      ).rejects.toBeInstanceOf(ConstraintError);

      // The precondition is guarded in the WHERE clause, so nothing raised in
      // the database and the transaction is still usable — this statement runs.
      const still = await openConflictsFor(fx.entityId, tx);
      expect(still).toEqual([]);
    });
  });

  it('reports a missing conflict as NotFound', async () => {
    await inRollback(async (tx) => {
      await expect(
        resolveFactConflict(
          '00000000-0000-4000-8000-000000000000',
          {
            status: 'resolved',
            resolution: 'x',
            resolvedBy: 'analyst@taskly.ca',
            resolvedAt: T1,
          },
          tx,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

/* ── SourceGraphPort ────────────────────────────────────────────────────── */

async function insertSource(tx: Executor, name: string, derivesFrom?: string): Promise<string> {
  const row = await tx.one<{ id: string }>(sql`
    insert into source (kind, name, tier, region, derives_from)
    values ('test', ${`${CONF}_${name}`}, 'aggregator', 'ca', ${derivesFrom ?? null}::uuid)
    returning id::text as id`);
  return row.id;
}

describe.skipIf(!HAS_DATABASE)('rootOf', () => {
  it('walks a copy chain to its root — three blogs quoting one release are one voice', async () => {
    await inRollback(async (tx) => {
      const press = await insertSource(tx, 'press');
      const blogA = await insertSource(tx, 'blog_a', press);
      const blogB = await insertSource(tx, 'blog_b', blogA);

      expect(await sourceRootOf(blogB, tx)).toBe(press);
      expect(await sourceRootOf(blogA, tx)).toBe(press);
      expect(await sourceRootOf(press, tx)).toBe(press);
    });
  });

  it('a source with no derives_from is its own root, and so is an unknown id', async () => {
    await inRollback(async (tx) => {
      const alone = await insertSource(tx, 'alone');
      expect(await sourceRootOf(alone, tx)).toBe(alone);
      expect(await sourceRootOf('00000000-0000-4000-8000-000000000000', tx)).toBe(
        '00000000-0000-4000-8000-000000000000',
      );
    });
  });

  it('SURVIVES A CYCLE, and collapses it to one voice from either end', async () => {
    await inRollback(async (tx) => {
      // Nothing in the schema prevents this. An unguarded recursive CTE would
      // run until the statement timeout.
      const a = await insertSource(tx, 'cycle_a');
      const b = await insertSource(tx, 'cycle_b', a);
      await tx.execute(sql`update source set derives_from = ${b}::uuid where id = ${a}::uuid`);

      const fromA = await sourceRootOf(a, tx);
      const fromB = await sourceRootOf(b, tx);

      expect(fromA).toBe(fromB);
      expect(fromA).toBe([a, b].sort()[0]);
    });
  });

  it('collapses a chain that ENTERS a cycle to the same root as the cycle itself', async () => {
    await inRollback(async (tx) => {
      const a = await insertSource(tx, 'tail_a');
      const b = await insertSource(tx, 'tail_b', a);
      await tx.execute(sql`update source set derives_from = ${b}::uuid where id = ${a}::uuid`);
      const tail = await insertSource(tx, 'tail_c', b);

      expect(await sourceRootOf(tail, tx)).toBe([a, b].sort()[0]);
    });
  });
});

/* ── PredicateIndexPort ─────────────────────────────────────────────────── */

describe.skipIf(!HAS_DATABASE)('withPredicate', () => {
  it('crosses entities, and returns only what is currently believed', async () => {
    await inRollback(async (tx) => {
      const fx = await seed(tx, 'index');

      const mine = await insertFact(fact(fx, 9900), tx);
      const theirs = await insertFact(fact(fx, 14_900, { entityId: fx.otherEntityId }), tx);
      const retracted = await insertFact(fact(fx, 1, { status: 'retracted' }), tx);
      const corrected = await insertFact(
        fact(fx, 2, { asserted: { from: T0, to: T1 } }),
        tx,
      );

      const rows = await factsWithPredicate(fx.predicate, tx);
      const ids = rows.map((r) => r.factId);

      expect(ids).toContain(mine.factId);
      expect(ids).toContain(theirs.factId);
      expect(ids).not.toContain(retracted.factId);
      expect(ids).not.toContain(corrected.factId);
      expect(new Set(rows.map((r) => r.entityId)).size).toBe(2);
    });
  });

  it('decodes through the same rowToFact the FactStore uses', async () => {
    await inRollback(async (tx) => {
      const fx = await seed(tx, 'decode');
      const stored = await insertFact(fact(fx, 9900), tx);

      const [row] = await factsWithPredicate(fx.predicate, tx);
      expect(row).toEqual(stored);
    });
  });
});

/* ── QueryExecutorPort: the boundary, against the connection we really have ─ */

describe.skipIf(!HAS_DATABASE)('the analytical boundary', () => {
  it('migration 006 has been applied — tmos_analyst exists on this database', async () => {
    const client: PooledClient = await connectFromPool();
    try {
      const probe = await probeSession(client);
      expect(
        probe.analystExists,
        `role ${ANALYST_ROLE} is missing — migration 006 has not been applied`,
      ).toBe(true);
    } finally {
      client.release();
    }
  });

  it('REFUSES the service connection — DATABASE_URL is not the boundary', async () => {
    const client: PooledClient = await connectFromPool();
    let probe;
    try {
      probe = await probeSession(client);
    } finally {
      client.release();
    }

    // Whatever `DATABASE_URL` authenticates as, it must not pass this check.
    // On Supabase it is `postgres`: not a superuser, but BYPASSRLS and
    // CREATEROLE, and it INHERITS tmos_analyst via createrole_self_grant — so
    // a membership test alone would have waved it through. The message names
    // the role, which is the answer to the README's open question about which
    // role the connection string really is.
    expect(() => assertAnalystSession(probe, 'DATABASE_URL')).toThrow(
      /privileged connection|is not a member/,
    );
  });

  it('does not fall back to the service pool when asked to run a query through it', async () => {
    const executor = createPostgresQueryExecutor({
      connect: connectFromPool,
      label: 'DATABASE_URL (deliberately the wrong connection)',
    });

    await expect(
      executor.run({ sql: 'select 1 as n limit 1', maxRows: 1, statementTimeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

/**
 * The half that cannot run without a second credential. `tmos_analyst` is
 * NOLOGIN by design (006), so a login role has to be provisioned out of band
 * and its connection string put in `DATABASE_ANALYST_URL` — see
 * `loadAnalystDbConfig` for the exact grants. Until then this is the only part
 * of the package that is not merely unverified but unrunnable, and it is the
 * part that proves the boundary WORKS rather than that it refuses.
 */
describe.skip('the analytical executor against tmos_analyst — needs DATABASE_ANALYST_URL', () => {
  it.todo('reads the six granted tables and returns rows, not an empty set (010)');
  it.todo('cannot write: an insert smuggled past the blocklist raises, it does not succeed');
  it.todo('cannot read belief, prediction, decision_record or consent');
  it.todo('honours set local statement_timeout below the role ceiling');
});
