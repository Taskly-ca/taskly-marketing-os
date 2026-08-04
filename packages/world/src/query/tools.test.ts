import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryFactStore, resetFactIds } from '../fact/memory-store.js';
import { assertFact, correctFact, recordChange, retractFact } from '../fact/write.js';
import {
  ANALYTICAL_MAX_ROWS,
  ANALYTICAL_MAX_TIMEOUT_MS,
  compareEntities,
  conflictsOpen,
  entitiesMatching,
  findEntities,
  getEntity,
  getFact,
  getFactHistory,
  inspectAnalyticalQuery,
  runAnalyticalQuery,
  sourceCoverage,
  whatChanged,
  whatWeBelievedAt,
} from './tools.js';
import type {
  ConflictPort,
  EntityDirectoryPort,
  EntityRecord,
  QueryExecutorPort,
  SourceGraphPort,
  WorldQueryDeps,
} from './tools.js';
import type { FactInput } from '../fact/types.js';

const JIFFY = 'ent_jiffy';
const RIVAL = 'ent_dashing';
const PRICE = 'hourly_rate_cents';

const ENTITIES: EntityRecord[] = [
  {
    entityId: JIFFY,
    entityType: 'company',
    name: 'Jiffy Home Services Inc.',
    nameNorm: 'jiffy home services',
    region: 'ca',
    keys: [{ kind: 'domain', valueNorm: 'jiffy.ca' }],
  },
  {
    entityId: RIVAL,
    entityType: 'company',
    name: 'Dashing Maids Ltd',
    nameNorm: 'dashing maids',
    region: 'ca',
    keys: [{ kind: 'domain', valueNorm: 'dashingmaids.ca' }],
  },
  {
    entityId: 'ent_gap',
    entityType: 'company',
    name: 'Gap',
    nameNorm: 'gap',
    region: 'global',
    keys: [],
  },
];

const directory: EntityDirectoryPort = {
  byId: async (id) => ENTITIES.find((e) => e.entityId === id) ?? null,
  byHardKey: async (k) =>
    ENTITIES.find((e) => e.keys.some((x) => x.kind === k.kind && x.valueNorm === k.valueNorm)) ??
    null,
  byNameNorm: async (n) => ENTITIES.filter((e) => e.nameNorm === n),
};

let store: ReturnType<typeof createMemoryFactStore>;
let deps: WorldQueryDeps;

const input = (over: Partial<FactInput> = {}): FactInput => ({
  entityId: JIFFY,
  predicate: PRICE,
  value: { datatype: 'num', num: 9900 },
  sourceId: 'src_site',
  observedAt: '2026-07-01T00:00:00.000Z',
  method: 'scrape',
  ...over,
});

beforeEach(() => {
  resetFactIds();
  store = createMemoryFactStore();
  deps = { store, entities: directory };
});

/* ── entity lookups ─────────────────────────────────────────────────────── */

describe('getEntity', () => {
  it('returns the entity, labelled as a governed read', async () => {
    const res = await getEntity(deps, { entityId: JIFFY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.name).toBe('Jiffy Home Services Inc.');
    expect(res.basis).toBe('governed_query');
  });

  it('fails loudly on an unknown id rather than returning nothing', async () => {
    const res = await getEntity(deps, { entityId: 'ent_nope' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses when no directory is wired instead of inventing one', async () => {
    const res = await getEntity({ store }, { entityId: JIFFY });
    expect(res).toMatchObject({ ok: false, code: 'unsupported' });
  });
});

describe('findEntities', () => {
  it('refuses an empty request instead of listing the world', async () => {
    const res = await findEntities(deps, {});
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('resolves a hard key', async () => {
    const res = await findEntities(deps, { hardKey: { kind: 'domain', valueNorm: 'jiffy.ca' } });
    expect(res.ok && res.data[0]?.entityId).toBe(JIFFY);
  });

  it('distinguishes "no such key" from a broken lookup', async () => {
    // An empty list with a note is the quiet-but-fine answer; ok:false would
    // say the tool could not do its job, which is a different fact.
    const res = await findEntities(deps, { hardKey: { kind: 'domain', valueNorm: 'nobody.ca' } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([]);
    expect(res.note).toMatch(/absent, not/);
  });

  it('normalizes a name before matching', async () => {
    const res = await findEntities(deps, { name: 'Jiffy Home Services, Inc.' });
    expect(res.ok && res.data[0]?.entityId).toBe(JIFFY);
  });

  it('says when a name may only ever be matched exactly', async () => {
    const res = await findEntities(deps, { name: 'Gap' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]?.entityId).toBe('ent_gap');
    expect(res.note).toMatch(/exact-only \(protected_brand\)/);
  });
});

/* ── facts ──────────────────────────────────────────────────────────────── */

describe('getFact', () => {
  it('separates "we have never recorded this" from "no such entity"', async () => {
    const absent = await getFact(deps, {
      entityId: JIFFY,
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
    });
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.data.value).toBeNull();
    expect(absent.note).toMatch(/ABSENCE of data, not a failed lookup/);

    const broken = await getFact(deps, {
      entityId: 'ent_nope',
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
    });
    expect(broken).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('says when facts exist but none covers the instant asked about', async () => {
    await assertFact(
      store,
      input({ validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
    const res = await getFact(deps, {
      entityId: JIFFY,
      predicate: PRICE,
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.value).toBeNull();
    expect(res.note).toMatch(/none is valid at/);
  });

  it('returns the value with the fact backing it', async () => {
    const { row } = await assertFact(
      store,
      input({ method: 'human', validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
    const res = await getFact(deps, {
      entityId: JIFFY,
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.value).toEqual({ datatype: 'num', num: 9900 });
    expect(res.factIds).toEqual([row.factId]);
    expect(res.basis).toBe('governed_query');
  });

  it('downgrades the basis when the answer rests on an LLM extraction', async () => {
    await assertFact(
      store,
      input({ method: 'llm_extract', validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
    const res = await getFact(deps, {
      entityId: JIFFY,
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
    });
    expect(res.ok && res.basis).toBe('inferred_from_sources');
  });

  it('rejects an unparseable instant', async () => {
    const res = await getFact(deps, { entityId: JIFFY, predicate: PRICE, at: 'last tuesday' });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('getFactHistory', () => {
  it('renders the correction trail, marking where a belief was closed', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    await correctFact(
      store,
      row.factId,
      { datatype: 'num', num: 9500 },
      {
        sourceId: 'src_human',
        observedAt: '2026-08-06T00:00:00.000Z',
        method: 'human',
        now: '2026-08-06T00:00:00.000Z',
      },
    );

    const res = await getFactHistory(deps, { entityId: JIFFY, predicate: PRICE });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(2);
    expect(res.data[0]?.correctedAt).toBe('2026-08-06T00:00:00.000Z');
    expect(res.data[1]?.supersedes).toBe(row.factId);
    expect(res.factIds).toHaveLength(2);
  });

  it('never truncates silently', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    await correctFact(
      store,
      row.factId,
      { datatype: 'num', num: 9500 },
      {
        sourceId: 's',
        observedAt: '2026-08-06T00:00:00.000Z',
        method: 'human',
        now: '2026-08-06T00:00:00.000Z',
      },
    );
    const res = await getFactHistory(deps, { entityId: JIFFY, predicate: PRICE, limit: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
    expect(res.truncated).toBe(true);
    expect(res.note).toMatch(/capped at 1/);
  });
});

describe('compareEntities', () => {
  beforeEach(async () => {
    await assertFact(
      store,
      input({ validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('refuses a comparison of fewer than two entities', async () => {
    const res = await compareEntities(deps, {
      entityIds: [JIFFY],
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
    });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('refuses to compare an entity with itself', async () => {
    const res = await compareEntities(deps, {
      entityIds: [JIFFY, JIFFY],
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
    });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('names the entities it has nothing for rather than dropping them', async () => {
    const res = await compareEntities(deps, {
      entityIds: [JIFFY, RIVAL],
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(2);
    expect(res.data[1]).toMatchObject({ entityId: RIVAL, value: null });
    expect(res.note).toMatch(/ent_dashing/);
  });
});

/* ── the two axes ───────────────────────────────────────────────────────── */

describe('whatChanged — the world moving vs us being wrong', () => {
  // The headline distinction. Both look like "the number is different now",
  // and treating a correction as a market event is how a brief invents a trend.
  beforeEach(async () => {
    const { row } = await assertFact(
      store,
      input({ validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
    // The world changed: they raised the price Aug 1, we saw it Aug 4.
    await recordChange(
      store,
      {
        ...input({
          value: { datatype: 'num', num: 11900 },
          observedAt: '2026-08-04T00:00:00.000Z',
        }),
        validFrom: '2026-08-01T00:00:00.000Z',
      },
      '2026-08-04T00:00:00.000Z',
    );
    // We were wrong: July was never 9900, it was 9500. Same valid range.
    await correctFact(
      store,
      row.factId,
      { datatype: 'num', num: 9500 },
      {
        sourceId: 'src_human',
        observedAt: '2026-08-06T00:00:00.000Z',
        method: 'human',
        now: '2026-08-06T00:00:00.000Z',
      },
    );
  });

  it('labels each entry with the axis that actually moved', async () => {
    const res = await whatChanged(deps, {
      entityId: JIFFY,
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-10T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.map((c) => c.kind)).toEqual(['world_change', 'self_correction']);

    const world = res.data[0]!;
    expect(world.value).toEqual({ datatype: 'num', num: 11900 });
    expect(world.previousValue).toEqual({ datatype: 'num', num: 9900 });
    expect(world.why).toMatch(/valid/);

    const correction = res.data[1]!;
    expect(correction.value).toEqual({ datatype: 'num', num: 9500 });
    // The giveaway: the replacement carries the SAME valid range as the row it
    // replaced. Only our belief interval moved.
    expect(correction.validFrom).toBe('2026-07-01T00:00:00.000Z');
    expect(correction.why).toMatch(/asserted/);
  });

  it('does not call our first sighting of a value a change', async () => {
    const res = await whatChanged(deps, {
      entityId: JIFFY,
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-08-10T00:00:00.000Z',
    });
    expect(res.ok && res.data.map((c) => c.kind)).toEqual([
      'first_observation',
      'world_change',
      'self_correction',
    ]);
  });

  it('reports a retraction as us withdrawing a belief', async () => {
    resetFactIds();
    store = createMemoryFactStore();
    deps = { store, entities: directory };
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    await retractFact(store, row.factId, '2026-08-08T00:00:00.000Z');

    const res = await whatChanged(deps, {
      entityId: JIFFY,
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-10T00:00:00.000Z',
    });
    expect(res.ok && res.data.map((c) => c.kind)).toEqual(['retraction']);
  });

  it('rejects a window that ends before it starts', async () => {
    const res = await whatChanged(deps, {
      entityId: JIFFY,
      from: '2026-08-10T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('whatWeBelievedAt — Q3, for post-mortems', () => {
  it('shows the belief a past decision was actually working from', async () => {
    const { row } = await assertFact(
      store,
      input({ validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
    await correctFact(
      store,
      row.factId,
      { datatype: 'num', num: 9500 },
      {
        sourceId: 's',
        observedAt: '2026-08-06T00:00:00.000Z',
        method: 'human',
        now: '2026-08-06T00:00:00.000Z',
      },
    );

    const res = await whatWeBelievedAt(deps, {
      entityId: JIFFY,
      assertedAt: '2026-08-05T00:00:00.000Z',
      validAt: '2026-07-15T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const belief = res.data[0]!;
    expect(belief.value).toEqual({ datatype: 'num', num: 9900 });
    // Judging that decision against 9500 would be hindsight bias with a
    // database behind it — so the tool says the number has since moved.
    expect(belief.correctedSince).toBe(true);
  });

  it('returns an empty belief set rather than failing when we knew nothing', async () => {
    const res = await whatWeBelievedAt(deps, {
      entityId: JIFFY,
      assertedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([]);
    expect(res.note).toMatch(/no facts/);
  });
});

/* ── cross-entity + provenance ──────────────────────────────────────────── */

describe('entitiesMatching', () => {
  const withIndex = (): WorldQueryDeps => ({
    ...deps,
    index: { withPredicate: async (p) => store.all().filter((r) => r.predicate === p) },
  });

  beforeEach(async () => {
    await assertFact(
      store,
      input({ validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
    await assertFact(
      store,
      input({
        entityId: RIVAL,
        value: { datatype: 'num', num: 14900 },
        validFrom: '2026-07-01T00:00:00.000Z',
      }),
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('refuses without an index rather than scanning everything', async () => {
    const res = await entitiesMatching(deps, {
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
      min: 0,
    });
    expect(res).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('refuses an unfiltered sweep', async () => {
    const res = await entitiesMatching(withIndex(), {
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
    });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('filters numerically and returns the backing facts', async () => {
    const res = await entitiesMatching(withIndex(), {
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
      min: 12000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((m) => m.entityId)).toEqual([RIVAL]);
    expect(res.factIds).toHaveLength(1);
  });

  it('flags a capped result', async () => {
    const res = await entitiesMatching(withIndex(), {
      predicate: PRICE,
      at: '2026-08-10T00:00:00.000Z',
      min: 0,
      limit: 1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(true);
    expect(res.note).toMatch(/capped at 1/);
  });
});

describe('sourceCoverage', () => {
  const sources: SourceGraphPort = {
    rootOf: async (id) => (id.startsWith('src_blog') ? 'src_press' : id),
  };

  beforeEach(async () => {
    for (const sourceId of ['src_press', 'src_blog_a', 'src_blog_b']) {
      await assertFact(
        store,
        input({ predicate: `claim_${sourceId}`, sourceId, value: { datatype: 'text', text: 'x' } }),
        '2026-07-01T00:00:00.000Z',
      );
    }
  });

  it('collapses copy chains when it can, and counts three blogs as one voice', async () => {
    const res = await sourceCoverage({ ...deps, sources }, { entityId: JIFFY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.distinctSources).toBe(3);
    expect(res.data.independentSources).toBe(1);
  });

  it('reports independence as unknown rather than guessing when it cannot', async () => {
    const res = await sourceCoverage(deps, { entityId: JIFFY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.independentSources).toBeNull();
    expect(res.note).toMatch(/UPPER BOUND/);
  });

  it('returns an empty coverage report for an entity with no facts', async () => {
    const res = await sourceCoverage(deps, { entityId: RIVAL });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.facts).toBe(0);
    expect(res.note).toMatch(/no facts/);
  });
});

describe('conflictsOpen', () => {
  const conflicts: ConflictPort = {
    openFor: async (entityId) =>
      entityId === JIFFY
        ? [
            {
              id: 'cf_1',
              entityId: JIFFY,
              predicate: PRICE,
              validInstant: '2026-08-01T00:00:00.000Z',
              factIds: ['fact_000001', 'fact_000002'],
              kind: 'factual',
              status: 'open',
            },
          ]
        : [],
  };

  it('refuses when no conflict store is wired', async () => {
    const res = await conflictsOpen(deps, { entityId: JIFFY });
    expect(res).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('returns the open conflicts and the facts in dispute', async () => {
    const res = await conflictsOpen({ ...deps, conflicts }, { entityId: JIFFY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
    expect(res.factIds).toEqual(['fact_000001', 'fact_000002']);
  });

  it('reports none as an empty list, not a failure', async () => {
    const res = await conflictsOpen({ ...deps, conflicts }, { entityId: RIVAL });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([]);
    expect(res.note).toMatch(/no open conflicts/);
  });
});

/* ── the guarded escape hatch ───────────────────────────────────────────── */

describe('runAnalyticalQuery — guards', () => {
  let calls: Array<{ sql: string; maxRows: number; statementTimeoutMs: number }>;
  let executor: QueryExecutorPort;

  beforeEach(() => {
    calls = [];
    executor = {
      run: async (req) => {
        calls.push(req);
        return { rows: [{ n: 1 }], rowCount: 1 };
      },
    };
  });

  const reject = async (sql: string, match: RegExp) => {
    const res = await runAnalyticalQuery(executor, { sql });
    expect(res, `expected "${sql}" to be rejected`).toMatchObject({ ok: false, code: 'rejected' });
    if (res.ok) return;
    expect(res.reason).toMatch(match);
    // The guard must refuse BEFORE anything reaches the database.
    expect(calls).toHaveLength(0);
  };

  it('rejects anything that is not a single SELECT or WITH', async () => {
    await reject('DROP TABLE fact', /only a single SELECT or WITH/i);
  });

  it('rejects a second statement smuggled after a semicolon', async () => {
    await reject('SELECT 1 LIMIT 1; DROP TABLE fact', /multiple statements/i);
  });

  it('rejects a line comment used to smuggle intent past the checks', async () => {
    await reject('SELECT * FROM fact LIMIT 10 -- ; drop table fact', /comment/i);
  });

  it('rejects a block comment used the same way', async () => {
    await reject('SELECT /* drop table fact */ 1 LIMIT 1', /comment/i);
  });

  it('rejects every DDL and DML keyword', async () => {
    for (const kw of [
      'insert',
      'update',
      'delete',
      'drop',
      'alter',
      'truncate',
      'create',
      'grant',
      'revoke',
      'copy',
    ]) {
      calls = [];
      await reject(`WITH x AS (SELECT 1) SELECT ${kw} FROM x LIMIT 10`, /forbidden keyword/i);
    }
  });

  it('rejects a CTE that hides a write', async () => {
    await reject(
      'WITH x AS (DELETE FROM fact RETURNING *) SELECT * FROM x LIMIT 10',
      /forbidden keyword/i,
    );
  });

  it('requires a LIMIT', async () => {
    await reject('SELECT * FROM fact', /LIMIT is required/i);
  });

  it('requires the LIMIT to be a literal, not a parameter', async () => {
    await reject('SELECT * FROM fact LIMIT $1', /literal integer/i);
  });

  it('rejects a LIMIT above the cap', async () => {
    const res = await runAnalyticalQuery(executor, { sql: 'SELECT 1 LIMIT 900', maxRows: 100 });
    expect(res).toMatchObject({ ok: false, code: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a row cap above the hard ceiling', async () => {
    const res = await runAnalyticalQuery(executor, {
      sql: 'SELECT 1 LIMIT 10',
      maxRows: ANALYTICAL_MAX_ROWS + 1,
    });
    expect(res).toMatchObject({ ok: false, code: 'rejected' });
  });

  it('rejects an absent or absurd statement timeout', async () => {
    expect(inspectAnalyticalQuery({ sql: 'SELECT 1 LIMIT 1', statementTimeoutMs: 0 }).ok).toBe(
      false,
    );
    expect(
      inspectAnalyticalQuery({
        sql: 'SELECT 1 LIMIT 1',
        statementTimeoutMs: ANALYTICAL_MAX_TIMEOUT_MS + 1,
      }).ok,
    ).toBe(false);
  });

  it('rejects an empty query', async () => {
    await reject('   ', /empty/i);
  });
});

describe('runAnalyticalQuery — results', () => {
  const executor = (rowCount: number): QueryExecutorPort => ({
    run: async () => ({ rows: Array.from({ length: rowCount }, (_, i) => ({ i })), rowCount }),
  });

  it('runs a legitimate read and passes the timeout down', async () => {
    const seen: unknown[] = [];
    const spy: QueryExecutorPort = {
      run: async (req) => {
        seen.push(req);
        return { rows: [], rowCount: 0 };
      },
    };
    const res = await runAnalyticalQuery(spy, {
      sql: 'WITH x AS (SELECT 1 AS n) SELECT * FROM x LIMIT 10',
      statementTimeoutMs: 2000,
    });
    expect(res.ok).toBe(true);
    expect(seen[0]).toMatchObject({ statementTimeoutMs: 2000, maxRows: 1000 });
  });

  it('labels the answer exploratory_unverified — never a governed metric', async () => {
    const res = await runAnalyticalQuery(executor(1), { sql: 'select 1 limit 10' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.basis).toBe('exploratory_unverified');
    expect(res.basis).not.toBe('governed_query');
    expect(res.basis).not.toBe('verified_metric');
    expect(res.factIds).toEqual([]);
    expect(res.note).toMatch(/not a governed metric/i);
  });

  it('says so when the result hit the cap', async () => {
    const res = await runAnalyticalQuery(executor(50), { sql: 'select 1 limit 50', maxRows: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.truncated).toBe(true);
    expect(res.note).toMatch(/may be incomplete/);
  });

  it('surfaces an executor failure as a failure, not as an empty result', async () => {
    const broken: QueryExecutorPort = {
      run: async () => {
        throw new Error('permission denied for table fact');
      },
    };
    const res = await runAnalyticalQuery(broken, { sql: 'select 1 limit 10' });
    expect(res).toMatchObject({ ok: false, code: 'executor_failed' });
  });
});
