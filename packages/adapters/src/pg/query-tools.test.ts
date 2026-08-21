/**
 * The four remaining ports, without Postgres.
 *
 * The analytical executor is the reason this file exists. Its boundary is a
 * database role, and a role check that is never exercised is a comment — so the
 * cases below drive `assertAnalystSession` through every way a connection can
 * be the wrong one, and drive `createPostgresQueryExecutor` against a fake
 * connection to prove the statement ORDER: read-only transaction, then the
 * session check, then the timeout, then the caller's SQL, and a rollback in a
 * `finally` whatever happened. None of that needs a database and all of it is
 * currently unverifiable any other way.
 */
import { describe, expect, it } from 'vitest';
import type { PooledClient, QueryResultLike, QueryRow } from '@tmos/db';
import { runAnalyticalQuery } from '@tmos/world';

import { AdapterError, ConstraintError, NotFoundError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  ANALYST_ROLE,
  ANALYST_URL_ENV,
  PREDICATE_SCAN_CEILING,
  assertAnalystSession,
  createPostgresConflictPort,
  createPostgresQueryExecutor,
  factConflictById,
  factsWithPredicate,
  insertFactConflict,
  loadAnalystDbConfig,
  openConflictsFor,
  resolveFactConflict,
  rowToConflict,
  sourceRootOf,
  type SessionProbe,
} from './query-tools.js';

const ENTITY = '11111111-1111-4111-8111-111111111111';
const CONFLICT = '99999999-9999-4999-8999-999999999999';
const FACT_A = '33333333-3333-4333-8333-333333333333';
const FACT_B = '44444444-4444-4444-8444-444444444444';
const SOURCE = '55555555-5555-4555-8555-555555555555';
const T0 = '2026-07-01T00:00:00.000Z';

const conflictRow = (over: Partial<QueryRow> = {}): QueryRow => ({
  id: CONFLICT,
  entity_id: ENTITY,
  predicate: 'price_cents',
  valid_instant: new Date(T0),
  fact_ids: [FACT_A, FACT_B],
  kind: 'factual',
  status: 'open',
  resolution: null,
  resolved_by: null,
  resolved_at: null,
  created_at: new Date(T0),
  ...over,
});

/* ── ConflictPort ───────────────────────────────────────────────────────── */

describe('openFor', () => {
  it("repeats status = 'open' literally, because a partial index cannot be parameterised", async () => {
    const ex = recordingExecutor([[conflictRow()]]);
    await openConflictsFor(ENTITY, ex);

    const q = ex.last();
    expect(q.text).toContain("status = 'open'");
    expect(q.values).toEqual([ENTITY]);
  });

  it('returns an empty list for a malformed id without issuing a statement', async () => {
    const ex = recordingExecutor();
    expect(await openConflictsFor('ent_1', ex)).toEqual([]);
    expect(ex.queries).toHaveLength(0);
  });

  it('decodes fact_ids as a text array and drops the four columns the port has no field for', () => {
    expect(rowToConflict(conflictRow())).toEqual({
      id: CONFLICT,
      entityId: ENTITY,
      predicate: 'price_cents',
      validInstant: T0,
      factIds: [FACT_A, FACT_B],
      kind: 'factual',
      status: 'open',
    });
  });

  it('refuses a kind outside the union rather than casting it', () => {
    expect(() => rowToConflict(conflictRow({ kind: 'stale' }))).toThrow(/is not one of/);
  });
});

describe('insertConflict', () => {
  it('refuses fewer than two facts — one id is a fact, not a disagreement', async () => {
    const ex = recordingExecutor();
    await expect(
      insertFactConflict(
        {
          entityId: ENTITY,
          predicate: 'price_cents',
          validInstant: T0,
          factIds: [FACT_A],
          kind: 'factual',
        },
        ex,
      ),
    ).rejects.toBeInstanceOf(ConstraintError);
    expect(ex.queries).toHaveLength(0);
  });

  it('sends fact_ids as one uuid[] parameter and defaults the status to open', async () => {
    const ex = recordingExecutor([[conflictRow()]]);
    await insertFactConflict(
      {
        entityId: ENTITY,
        predicate: 'price_cents',
        validInstant: T0,
        factIds: [FACT_A, FACT_B],
        kind: 'temporal',
      },
      ex,
    );

    const q = ex.last();
    expect(q.text).toMatch(/\$\d+::uuid\[\]/);
    expect(q.values).toContainEqual([FACT_A, FACT_B]);
    expect(q.values).toContain('open');
    expect(q.values).toContain('temporal');
    // created_at is the database's; every other instant comes from the caller.
    expect(q.text).not.toContain('now()');
  });
});

describe('resolve', () => {
  const resolution = {
    status: 'resolved',
    resolution: 'the higher-reliability source won',
    resolvedBy: 'analyst@taskly.ca',
    resolvedAt: T0,
  } as const;

  it("guards status = 'open' in the WHERE clause so a second resolution updates nothing", async () => {
    const ex = recordingExecutor([[conflictRow({ status: 'resolved' })]]);
    await resolveFactConflict(CONFLICT, resolution, ex);

    expect(ex.last().text).toContain("status = 'open'");
  });

  it('diagnoses a missing conflict as NotFound rather than raising in the transaction', async () => {
    const ex = recordingExecutor([[], []]);
    await expect(resolveFactConflict(CONFLICT, resolution, ex)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(ex.queries).toHaveLength(2);
  });

  it('refuses to overwrite a resolution that is already recorded', async () => {
    const ex = recordingExecutor([
      [],
      [conflictRow({ status: 'resolved', resolved_by: 'someone', resolved_at: new Date(T0) })],
    ]);
    await expect(resolveFactConflict(CONFLICT, resolution, ex)).rejects.toThrow(
      /already resolved.*by someone/s,
    );
  });

  it('refuses an unattributed resolution before issuing a statement', async () => {
    const ex = recordingExecutor();
    await expect(
      resolveFactConflict(CONFLICT, { ...resolution, resolvedBy: '  ' }, ex),
    ).rejects.toBeInstanceOf(ConstraintError);
    expect(ex.queries).toHaveLength(0);
  });

  it('treats a malformed id as not found, never as a crash', async () => {
    const ex = recordingExecutor();
    await expect(resolveFactConflict('c_1', resolution, ex)).rejects.toBeInstanceOf(NotFoundError);
    expect(await factConflictById('c_1', ex)).toBeNull();
    expect(ex.queries).toHaveLength(0);
  });
});

describe('createPostgresConflictPort', () => {
  it('binds openFor to the executor it was given', async () => {
    const ex = recordingExecutor([[conflictRow()]]);
    const rows = await createPostgresConflictPort(ex).openFor(ENTITY);
    expect(rows).toHaveLength(1);
  });
});

/* ── SourceGraphPort ────────────────────────────────────────────────────── */

describe('rootOf', () => {
  it('walks derives_from upward and carries a path, so a cycle cannot spin', async () => {
    const ex = recordingExecutor([[{ id: SOURCE }]]);
    await sourceRootOf(SOURCE, ex);

    const { text } = ex.last();
    expect(text).toContain('with recursive');
    expect(text).toContain('w.path || p.id');
    expect(text).toContain('p.id = any(w.path)');
    expect(text).toContain('not w.cycle');
    expect(text).toContain('order by w.depth desc');
  });

  it('collapses a cycle to the LOWEST id in it, so every member roots the same way', async () => {
    const ex = recordingExecutor([[{ id: SOURCE }]]);
    await sourceRootOf(SOURCE, ex);

    // min() over the cycle slice — not "the last row before the repeat", which
    // would give two members of one cycle two different roots.
    expect(ex.last().text).toContain('unnest(w.path[coalesce(array_position');
    expect(ex.last().text).toContain('array_position(w.path, w.id)');
  });

  it('treats an unknown source as its own root rather than failing a coverage question', async () => {
    expect(await sourceRootOf(SOURCE, recordingExecutor([[]]))).toBe(SOURCE);
  });

  it('treats a malformed id as its own root without issuing a statement', async () => {
    const ex = recordingExecutor();
    expect(await sourceRootOf('src_press', ex)).toBe('src_press');
    expect(ex.queries).toHaveLength(0);
  });
});

/* ── PredicateIndexPort ─────────────────────────────────────────────────── */

const factRow = (over: Partial<QueryRow> = {}): QueryRow => ({
  fact_id: FACT_A,
  entity_id: ENTITY,
  predicate: 'price_cents',
  object_text: null,
  object_num: '9900',
  object_entity: null,
  object_json: null,
  has_json: false,
  valid_from: new Date(T0),
  valid_to: null,
  asserted_from: new Date(T0),
  asserted_to: null,
  source_id: SOURCE,
  observed_at: new Date(T0),
  confidence: 0.9,
  method: 'scrape',
  evidence: {},
  supersedes: null,
  status: 'active',
  ...over,
});

describe('withPredicate', () => {
  it('reads only what is currently believed, and decodes through rowToFact', async () => {
    const ex = recordingExecutor([[factRow()]]);
    const rows = await factsWithPredicate('price_cents', ex);

    const { text } = ex.last();
    expect(text).toContain("status = 'active'");
    expect(text).toContain('upper_inf(asserted)');
    expect(rows[0]?.value).toEqual({ datatype: 'num', num: 9900 });
    expect(rows[0]?.factId).toBe(FACT_A);
  });

  it('asks for one row past the ceiling so a full result can be detected', async () => {
    const ex = recordingExecutor([[factRow()]]);
    await factsWithPredicate('price_cents', ex);

    expect(ex.last().values).toContain(PREDICATE_SCAN_CEILING + 1);
  });

  it('REFUSES past the ceiling instead of returning a capped array as a complete answer', async () => {
    const rows = Array.from({ length: PREDICATE_SCAN_CEILING + 1 }, (_v, i) =>
      factRow({ fact_id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000` }),
    );
    await expect(factsWithPredicate('category', recordingExecutor([rows]))).rejects.toThrow(
      /more than 10000 currently-believed facts/,
    );
  });
});

/* ── QueryExecutorPort: the boundary ────────────────────────────────────── */

const cleanProbe: SessionProbe = {
  role: 'tmos_analyst_login',
  superuser: false,
  bypassRls: false,
  createRole: false,
  analystExists: true,
  member: true,
};

describe('assertAnalystSession', () => {
  it('accepts a login role whose only privilege is membership of the analyst role', () => {
    expect(() => assertAnalystSession(cleanProbe, ANALYST_URL_ENV)).not.toThrow();
  });

  it('refuses when migration 006 has not been applied', () => {
    expect(() =>
      assertAnalystSession({ ...cleanProbe, analystExists: false, member: false }, 'x'),
    ).toThrow(/migration 006 has not been applied/);
  });

  it.each([
    ['superuser', { superuser: true }],
    ['bypassRls', { bypassRls: true }],
    ['createRole', { createRole: true }],
  ])('refuses a %s connection even though it inherits the analyst role', (_name, over) => {
    expect(() => assertAnalystSession({ ...cleanProbe, ...over }, 'x')).toThrow(
      /privileged connection, not the read-only boundary/,
    );
  });

  it('names every elevated attribute at once rather than the first one', () => {
    expect(() =>
      assertAnalystSession({ ...cleanProbe, bypassRls: true, createRole: true }, 'x'),
    ).toThrow(/has BYPASSRLS and has CREATEROLE/);
  });

  it('refuses a non-member, because grants and RLS would return zero rows, not an error', () => {
    expect(() => assertAnalystSession({ ...cleanProbe, member: false }, 'x')).toThrow(
      new RegExp(`grant ${ANALYST_ROLE} to`),
    );
  });
});

interface FakeConnection {
  readonly connect: () => Promise<PooledClient>;
  readonly texts: string[];
  released(): boolean | Error | undefined | 'never';
}

/**
 * A connection that answers the probe from a script and the caller's statement
 * with rows. `release` is recorded, because a leaked connection is the failure
 * mode a `finally` exists to prevent and nothing else would notice it.
 */
function fakeAnalystConnection(
  over: Partial<SessionProbe> = {},
  rows: unknown[] = [],
  fail?: { on: RegExp; error: Error },
): FakeConnection {
  const probe = { ...cleanProbe, ...over };
  const texts: string[] = [];
  let released: boolean | Error | undefined | 'never' = 'never';

  const client: PooledClient = {
    async query(text: string): Promise<QueryResultLike> {
      texts.push(text);
      if (fail && fail.on.test(text)) throw fail.error;
      if (text.startsWith('select current_user')) {
        return {
          rows: [
            {
              role: probe.role,
              superuser: probe.superuser,
              bypass_rls: probe.bypassRls,
              create_role: probe.createRole,
              analyst_exists: probe.analystExists,
              member: probe.member,
            },
          ],
          rowCount: 1,
        };
      }
      if (/^(begin|set local|rollback)/.test(text)) return { rows: [], rowCount: 0 };
      return { rows, rowCount: rows.length };
    },
    release(err) {
      released = err;
    },
  };

  return { connect: async () => client, texts, released: () => released };
}

describe('createPostgresQueryExecutor', () => {
  const req = { sql: 'select 1 as n limit 10', maxRows: 10, statementTimeoutMs: 5000 };

  it('opens a READ ONLY transaction, checks the session, sets the timeout, then runs', async () => {
    const conn = fakeAnalystConnection({}, [{ n: 1 }]);
    await createPostgresQueryExecutor({ connect: conn.connect }).run(req);

    expect(conn.texts[0]).toBe('begin read only');
    expect(conn.texts[1]).toContain('select current_user');
    expect(conn.texts[2]).toBe('set local statement_timeout = 5000');
    expect(conn.texts[3]).toBe(req.sql);
    expect(conn.texts[4]).toBe('rollback');
  });

  it('always rolls back and always releases, including when the query fails', async () => {
    const conn = fakeAnalystConnection({}, [], {
      on: /^select 1/,
      error: Object.assign(new Error('syntax error'), { code: '42601' }),
    });

    await expect(createPostgresQueryExecutor({ connect: conn.connect }).run(req)).rejects.toThrow(
      /syntax error/,
    );
    expect(conn.texts.at(-1)).toBe('rollback');
    expect(conn.released()).toBeUndefined();
  });

  it('refuses BEFORE running the query when the connection is the privileged one', async () => {
    const conn = fakeAnalystConnection({ bypassRls: true });

    await expect(createPostgresQueryExecutor({ connect: conn.connect }).run(req)).rejects.toThrow(
      /privileged connection/,
    );
    expect(conn.texts).not.toContain(req.sql);
    expect(conn.texts.at(-1)).toBe('rollback');
  });

  it('caps the rows it returns, so a direct caller cannot bypass the LIMIT guard', async () => {
    const rows = Array.from({ length: 25 }, (_v, n) => ({ n }));
    const conn = fakeAnalystConnection({}, rows);

    const res = await createPostgresQueryExecutor({ connect: conn.connect }).run({
      ...req,
      maxRows: 10,
    });
    expect(res.rowCount).toBe(10);
    expect(res.rows).toHaveLength(10);
  });

  it('refuses a maxRows or timeout outside the tool ceilings without connecting', async () => {
    const conn = fakeAnalystConnection();
    const executor = createPostgresQueryExecutor({ connect: conn.connect });

    await expect(executor.run({ ...req, maxRows: 0 })).rejects.toBeInstanceOf(AdapterError);
    await expect(executor.run({ ...req, statementTimeoutMs: 60_000 })).rejects.toBeInstanceOf(
      AdapterError,
    );
    expect(conn.texts).toHaveLength(0);
  });

  it('is what runAnalyticalQuery calls, and its refusal surfaces as executor_failed', async () => {
    const conn = fakeAnalystConnection({ superuser: true });
    const result = await runAnalyticalQuery(createPostgresQueryExecutor({ connect: conn.connect }), {
      sql: 'select count(*) from fact limit 10',
    });

    expect(result).toMatchObject({ ok: false, code: 'executor_failed' });
  });

  it('is why SET LOCAL ROLE was not used: set_config walks past the blocklist', async () => {
    // `\bset\b` does not match `set_config` — the next character is a word
    // character — so this query is ACCEPTED by every guard in
    // inspectAnalyticalQuery. On a session that merely `SET LOCAL ROLE`d its
    // way down from the service role, it climbs straight back up. It reaches
    // the executor here, which is the point: the guards are not the boundary.
    const conn = fakeAnalystConnection({}, [{ set_config: 'postgres' }]);
    const result = await runAnalyticalQuery(createPostgresQueryExecutor({ connect: conn.connect }), {
      sql: "select set_config('role', 'postgres', false) as r limit 1",
    });

    expect(result.ok).toBe(true);
    expect(conn.texts).toContain("select set_config('role', 'postgres', false) as r limit 1");
  });

  it('never reaches the connection at all for a query the guards reject', async () => {
    const conn = fakeAnalystConnection();
    const result = await runAnalyticalQuery(createPostgresQueryExecutor({ connect: conn.connect }), {
      sql: 'select set_config($$role$$, $$postgres$$, false) limit 1; drop table fact',
    });

    expect(result).toMatchObject({ ok: false, code: 'rejected' });
    expect(conn.texts).toHaveLength(0);
  });

  it('labels an ad-hoc answer exploratory_unverified, never a governed metric', async () => {
    const conn = fakeAnalystConnection({}, [{ n: 1 }]);
    const result = await runAnalyticalQuery(createPostgresQueryExecutor({ connect: conn.connect }), {
      sql: 'select 1 as n limit 10',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.basis).toBe('exploratory_unverified');
  });
});

describe('loadAnalystDbConfig', () => {
  const url = 'postgres://analyst:pw@db.example.test:5432/postgres';

  it('reads its own variable and never falls back to DATABASE_URL', () => {
    expect(() => loadAnalystDbConfig({ DATABASE_URL: url })).toThrow(
      new RegExp(`${ANALYST_URL_ENV} is required`),
    );
    expect(() => loadAnalystDbConfig({ [ANALYST_URL_ENV]: '   ' })).toThrow(/is required/);
  });

  it('refuses the service connection wearing the analyst variable name', () => {
    expect(() =>
      loadAnalystDbConfig({ DATABASE_URL: url, [ANALYST_URL_ENV]: url }),
    ).toThrow(/same connection string as DATABASE_URL/);
  });

  it('caps the pool small and the statement timeout at the tool ceiling', () => {
    const config = loadAnalystDbConfig({
      DATABASE_URL: 'postgres://service@db.example.test:5432/postgres',
      [ANALYST_URL_ENV]: url,
    });

    expect(config.url).toBe(url);
    expect(config.poolMax).toBe(2);
    expect(config.statementTimeoutMs).toBe(30_000);
  });
});
