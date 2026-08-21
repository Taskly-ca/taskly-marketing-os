/**
 * The four remaining ports of `packages/world/src/query/tools.ts`, on Postgres:
 * `ConflictPort`, `SourceGraphPort`, `PredicateIndexPort` and the one that is
 * not like the others, `QueryExecutorPort`. Plus the `fact_conflict` writes,
 * which no port declares and without which nothing ever files a conflict.
 *
 * tools.ts states the rule these implement: "'No data' and 'lookup failed' are
 * DIFFERENT returns." Every read below therefore distinguishes an absent row
 * from an unusable argument, and none of them answers a broken question with an
 * empty result.
 *
 * ── THE SECURITY BOUNDARY, because it is the reason this file is worth reading
 *
 * tools.ts is blunt about `runAnalyticalQuery`: "keyword blocklisting is a
 * defence-in-depth layer, NOT a security boundary … The real boundary is a
 * database role with only SELECT grants." Migration 006 created that role —
 * `tmos_analyst`, NOLOGIN, `default_transaction_read_only`, a 30s
 * `statement_timeout`, SELECT on six tables — and 010 gave it the RLS policies
 * without which the grants returned zero rows instead of an error.
 *
 * So `createPostgresQueryExecutor` takes a `Connect` and REFUSES to run until
 * it has checked, against the live session, that the connection really is that
 * role and not a privileged one. It cannot fall back to the service pool: there
 * is no code path here that reaches `db()` or `getPool()`. A boundary you can
 * reach around is a comment.
 *
 * Why not `SET LOCAL ROLE tmos_analyst` on the existing pool, which needs no
 * second connection string? Two reasons, both fatal:
 *
 *   · IT DOES NOT SURVIVE THE BLOCKLIST BEING BEATEN, which is the entire
 *     scenario the role exists for. The session is still authenticated as the
 *     privileged role, so one statement is enough to climb back:
 *     `select set_config('role', 'postgres', false)` contains no forbidden
 *     keyword — `\bset\b` does not match `set_config` — passes every guard in
 *     `inspectAnalyticalQuery`, and undoes the role in the same query it was
 *     supposed to constrain.
 *   · THE ROLE'S GUCs DO NOT COME WITH IT. `alter role … set
 *     statement_timeout / default_transaction_read_only` (006) is applied at
 *     LOGIN, for the role that logged in. `SET ROLE` does not apply them, and
 *     they are not inherited through membership either. Two thirds of what 006
 *     built would silently not be in force.
 *
 * The connection therefore has to AUTHENTICATE as a member of `tmos_analyst`.
 * See `loadAnalystDbConfig` for the operator action that makes one exist.
 */
import {
  db,
  loadDbConfig,
  sql,
  type Connect,
  type DbClient,
  type DbConfig,
  type Executor,
  type QueryRow,
} from '@tmos/db';
import {
  ANALYTICAL_MAX_ROWS,
  ANALYTICAL_MAX_TIMEOUT_MS,
  type ConflictPort,
  type ConflictRecord,
  type FactRow,
  type PredicateIndexPort,
  type QueryExecutorPort,
  type SourceGraphPort,
} from '@tmos/world';

import { AdapterError, ConstraintError, NotFoundError, guard } from '../errors.js';
import { rowToFact } from './fact-row.js';
import {
  asBoolean,
  asIso,
  asIsoOrNull,
  asStringArray,
  asText,
  asTextOrNull,
  asUnion,
  isUuid,
} from './values.js';

/* ── 1. ConflictPort — fact_conflict (002) ──────────────────────────────── */

const CONFLICT_KINDS: readonly ConflictRecord['kind'][] = ['temporal', 'factual', 'opinion'];
const CONFLICT_STATUSES: readonly ConflictRecord['status'][] = ['open', 'resolved', 'unresolvable'];

/**
 * `ConflictRecord` carries seven of `fact_conflict`'s eleven columns.
 * `resolution`, `resolved_by`, `resolved_at` and `created_at` have no field on
 * it — deliberately, since the port's one method is `openFor`, and an OPEN
 * conflict has all four either null or uninteresting. They are written by
 * `resolveFactConflict` and read by `factConflictById`, which returns the wider
 * `FactConflictRow`. The port type is not widened here to match the table:
 * `packages/world` is another lane, and a port that grew four fields nobody
 * reads is not an improvement.
 */
const CONFLICT_COLUMNS = sql`
  id::text as id,
  entity_id::text as entity_id,
  predicate,
  valid_instant,
  fact_ids::text[] as fact_ids,
  kind,
  status`;

const RESOLUTION_COLUMNS = sql`
  resolution,
  resolved_by,
  resolved_at,
  created_at`;

export function rowToConflict(row: QueryRow): ConflictRecord {
  const id = asText(row.id, 'fact_conflict.id');
  const at = (column: string): string => `fact_conflict[${id}].${column}`;

  return {
    id,
    entityId: asText(row.entity_id, at('entity_id')),
    predicate: asText(row.predicate, at('predicate')),
    validInstant: asIso(row.valid_instant, at('valid_instant')),
    factIds: asStringArray(row.fact_ids, at('fact_ids')),
    kind: asUnion(row.kind, CONFLICT_KINDS, at('kind')),
    status: asUnion(row.status, CONFLICT_STATUSES, at('status')),
  };
}

/** `ConflictRecord` plus the four columns the port does not carry. */
export interface FactConflictRow extends ConflictRecord {
  readonly resolution: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

export function rowToFactConflictRow(row: QueryRow): FactConflictRow {
  const base = rowToConflict(row);
  const at = (column: string): string => `fact_conflict[${base.id}].${column}`;

  return {
    ...base,
    resolution: asTextOrNull(row.resolution, at('resolution')),
    resolvedBy: asTextOrNull(row.resolved_by, at('resolved_by')),
    resolvedAt: asIsoOrNull(row.resolved_at, at('resolved_at')),
    createdAt: asIso(row.created_at, at('created_at')),
  };
}

/**
 * Open conflicts for one entity, newest disagreement first.
 *
 * Served by 002's `fact_conflict_open_idx on (entity_id) where status = 'open'`,
 * which is why `status = 'open'` is spelled out rather than passed as a
 * parameter — a partial index is only usable when the query repeats its
 * predicate literally.
 */
export async function openConflictsFor(
  entityId: string,
  ex: Executor = db(),
): Promise<ConflictRecord[]> {
  if (!isUuid(entityId)) return [];

  return guard('openFor', async () => {
    const rows = await ex.query(sql`
      select ${CONFLICT_COLUMNS} from fact_conflict
       where entity_id = ${entityId}::uuid and status = 'open'
       order by valid_instant desc, id`);
    return rows.map(rowToConflict);
  });
}

export async function factConflictById(
  id: string,
  ex: Executor = db(),
): Promise<FactConflictRow | null> {
  if (!isUuid(id)) return null;

  return guard('conflictById', async () => {
    const row = await ex.maybeOne(sql`
      select ${CONFLICT_COLUMNS}, ${RESOLUTION_COLUMNS} from fact_conflict
       where id = ${id}::uuid`);
    return row === null ? null : rowToFactConflictRow(row);
  });
}

export interface FactConflictInput {
  readonly entityId: string;
  readonly predicate: string;
  /** The instant on the VALID axis where the rows disagree. */
  readonly validInstant: string;
  /** Every fact in the disagreement. Two is the usual case; more is legal. */
  readonly factIds: readonly string[];
  readonly kind: ConflictRecord['kind'];
  /** Defaults to `open`. A conflict filed already resolved is a legal import. */
  readonly status?: ConflictRecord['status'];
}

/**
 * Files a conflict.
 *
 * 002 is emphatic that these are rows and not log lines, and that the KIND is
 * decided before anything is resolved — `classifyConflict` in
 * `packages/world/src/fact/conflict.ts` is what decides it, and misfiling a
 * temporal change as factual is the most damaging error in that module. This
 * function stores the verdict; it does not form one.
 *
 * `created_at` is the one timestamp in this file the database supplies: the
 * input has no field for it, so there is nothing for a caller to pass. Every
 * other instant — `valid_instant`, and `resolved_at` below — comes from above.
 */
export async function insertFactConflict(
  input: FactConflictInput,
  ex: Executor = db(),
): Promise<FactConflictRow> {
  if (input.factIds.length < 2) {
    throw new ConstraintError(
      `insertConflict: ${input.factIds.length} fact id(s) — a conflict is a disagreement ` +
        'between at least two facts. One id is a fact, not a conflict.',
    );
  }

  return guard('insertConflict', async () =>
    rowToFactConflictRow(
      await ex.one(sql`
        insert into fact_conflict (entity_id, predicate, valid_instant, fact_ids, kind, status)
        values (
          ${input.entityId}::uuid, ${input.predicate}, ${input.validInstant}::timestamptz,
          ${[...input.factIds]}::uuid[], ${input.kind}, ${input.status ?? 'open'}
        )
        returning ${CONFLICT_COLUMNS}, ${RESOLUTION_COLUMNS}`),
    ),
  );
}

export interface ConflictResolution {
  /** `unresolvable` is a real outcome — see `Refusal` in conflict.ts. */
  readonly status: 'resolved' | 'unresolvable';
  /** What was decided, in words. `resolveFactual`'s rationale belongs here. */
  readonly resolution: string;
  /** A human, or the rule that decided. Never blank — this is the audit trail. */
  readonly resolvedBy: string;
  /** ISO, from the caller. This adapter never reads the clock. */
  readonly resolvedAt: string;
}

/**
 * Closes a conflict, ONCE.
 *
 * The precondition (`status = 'open'`) is guarded in the WHERE clause rather
 * than by reading first and then writing, so a second resolution updates zero
 * rows instead of overwriting the first one — and so a violation does not raise
 * inside the caller's transaction, which `@tmos/db` cannot recover (no
 * savepoints; every later statement would fail with "current transaction is
 * aborted"). Only then does a second read work out which precondition failed.
 * The same shape as `fact-store.ts`'s closers, for the same reason.
 */
export async function resolveFactConflict(
  id: string,
  resolution: ConflictResolution,
  ex: Executor = db(),
): Promise<FactConflictRow> {
  if (!isUuid(id)) throw new NotFoundError(`resolve: no such conflict ${id}`);
  if (resolution.resolvedBy.trim() === '') {
    throw new ConstraintError('resolve: resolvedBy is empty — a resolution needs an author');
  }

  const row = await guard('resolve', () =>
    ex.maybeOne(sql`
      update fact_conflict
         set status      = ${resolution.status},
             resolution  = ${resolution.resolution},
             resolved_by = ${resolution.resolvedBy},
             resolved_at = ${resolution.resolvedAt}::timestamptz
       where id = ${id}::uuid and status = 'open'
      returning ${CONFLICT_COLUMNS}, ${RESOLUTION_COLUMNS}`),
  );
  if (row !== null) return rowToFactConflictRow(row);

  const existing = await factConflictById(id, ex);
  if (existing === null) throw new NotFoundError(`resolve: no such conflict ${id}`);
  throw new ConstraintError(
    `resolve: ${id} is already ${existing.status}` +
      (existing.resolvedAt === null ? '' : ` at ${existing.resolvedAt}`) +
      (existing.resolvedBy === null ? '' : ` by ${existing.resolvedBy}`) +
      ' — a second resolution would overwrite the first, and the first is the audit trail. ' +
      'File a new conflict if the disagreement recurred.',
  );
}

export function createPostgresConflictPort(executor?: Executor): ConflictPort {
  const ex = (): Executor => executor ?? db();
  return { openFor: (entityId) => openConflictsFor(entityId, ex()) };
}

/* ── 2. SourceGraphPort — the copy-chain walk ───────────────────────────── */

/**
 * A bound on the walk, not a cycle guard — the `path` check below is what makes
 * an infinite walk impossible. This exists so a pathological chain cannot build
 * a hundred-thousand-element array on the way to an answer nobody wants.
 */
const MAX_DERIVES_DEPTH = 64;

/**
 * `rootOf` — collapses a copy chain, so three blogs quoting one press release
 * count as ONE voice in `sourceCoverage`.
 *
 * `source.derives_from` is self-referential with NO constraint preventing a
 * cycle: nothing stops `A derives_from B` and `B derives_from A`, and an
 * unguarded `with recursive` walking that pair spins until the statement
 * timeout — burning a connection to answer a coverage question. So the walk
 * carries its own `path` and stops the moment it would revisit a row.
 *
 * WHAT A CYCLE RETURNS, since `rootOf` must return a string and there is no
 * honest root inside one: the LOWEST id among the cycle's members. Two
 * properties matter and only that choice has both — it is deterministic, and it
 * is the same answer for every member of the cycle, so a cycle still collapses
 * to one voice rather than inflating the independent-source count it was asked
 * about. Returning "the last row before the repeat" fails the second: A would
 * root at B and B at A, and a two-source cycle would count as two independent
 * sources, which is precisely the overclaim this port exists to prevent.
 *
 * An unknown or malformed id is its own root. That is what a Map-backed fake
 * does, it is what a source with no `derives_from` means, and `sourceCoverage`
 * would otherwise have to distinguish two kinds of nothing.
 */
export async function sourceRootOf(sourceId: string, ex: Executor = db()): Promise<string> {
  if (!isUuid(sourceId)) return sourceId;

  return guard('rootOf', async () => {
    const row = await ex.maybeOne(sql`
      with recursive walk (id, parent, depth, path, cycle) as (
        select s.id, s.derives_from, 0, array[s.id], false
          from source s where s.id = ${sourceId}::uuid
        union all
        select p.id, p.derives_from, w.depth + 1, w.path || p.id, p.id = any(w.path)
          from walk w join source p on p.id = w.parent
         where not w.cycle and w.depth < ${MAX_DERIVES_DEPTH}
      )
      select case
               when w.cycle then (
                 -- order-by/limit rather than a min() aggregate: min over uuid
                 -- is not available on every server this could ever run on.
                 select c::text
                   from unnest(w.path[coalesce(array_position(w.path, w.id), 1):]) as c
                  order by c
                  limit 1
               )
               else w.id::text
             end as id
        from walk w
       order by w.depth desc
       limit 1`);

    if (row === null) return sourceId;
    return asText(row.id, 'source.root');
  });
}

export function createPostgresSourceGraph(executor?: Executor): SourceGraphPort {
  const ex = (): Executor => executor ?? db();
  return { rootOf: (sourceId) => sourceRootOf(sourceId, ex()) };
}

/* ── 3. PredicateIndexPort — the cross-entity scan ──────────────────────── */

/**
 * The `fact` projection. It is BYTE-FOR-BYTE the one in `fact-store.ts`, which
 * does not export it — and the decoder it feeds, `rowToFact`, is imported from
 * `fact-row.ts` rather than re-implemented, so the mapping cannot drift even
 * though the column list is written twice. Exporting `FACT_COLUMNS` from
 * `fact-store.ts` and importing it here is a one-line change in a file this
 * lane may not touch; it is filed in the report.
 */
const FACT_PROJECTION = sql`
  fact_id::text as fact_id,
  entity_id::text as entity_id,
  predicate,
  object_text,
  object_num,
  object_entity::text as object_entity,
  object_json,
  object_json is not null as has_json,
  lower(valid) as valid_from,
  upper(valid) as valid_to,
  lower(asserted) as asserted_from,
  upper(asserted) as asserted_to,
  source_id::text as source_id,
  observed_at,
  confidence,
  method,
  evidence,
  supersedes::text as supersedes,
  status`;

/**
 * How many rows this port will hand back before refusing.
 *
 * `withPredicate` returns `FactRow[]` and has nowhere to say "there were more",
 * and tools.ts's third rule is "never truncate silently". So the read asks for
 * one row past the ceiling and THROWS if it gets it, rather than returning a
 * capped array that `entitiesMatching` would report as a complete answer.
 */
export const PREDICATE_SCAN_CEILING = 10_000;

/**
 * Every currently-believed fact for a predicate, across all entities.
 *
 * PRE-FILTERED to `status = 'active' and upper_inf(asserted)`, which the test
 * fake in `query/tools.test.ts` does not do (it returns everything and lets
 * `entitiesMatching` filter). The observable result of that tool is identical —
 * it applies exactly these two predicates plus `rangeContains(valid, at)` to
 * whatever it is given — and pushing them into SQL is the difference between
 * reading the live rows and reading the entire history of the predicate.
 *
 * ON THE INDEXES, honestly. 005 built `fact_predicate_text_idx` and
 * `fact_predicate_num_idx` for this access pattern, but both are PARTIAL on
 * `object_text is not null` / `object_num is not null`, and a partial index is
 * only usable when the query repeats its predicate. This port's signature —
 * `withPredicate(predicate)` — cannot: it must return entity- and json-valued
 * facts too, so neither index can serve the statement and Postgres reaches the
 * rows with a filtered scan. The two indexes ARE used by a query that names a
 * datatype, which is what `entitiesMatching` is really asking (text equality,
 * or a numeric range), and the fix is one of two things, both outside this
 * lane: give the port a value filter (a `packages/world` change), or add
 * `create index fact_predicate_current_idx on fact (predicate) where status =
 * 'active' and upper_inf(asserted)` (a migration). Filed in the report rather
 * than worked around here, because a scan that is documented is survivable and
 * a scan that is claimed to be an index lookup is not.
 */
export async function factsWithPredicate(
  predicate: string,
  ex: Executor = db(),
): Promise<FactRow[]> {
  return guard('withPredicate', async () => {
    const rows = await ex.query(sql`
      select ${FACT_PROJECTION} from fact
       where predicate = ${predicate} and status = 'active' and upper_inf(asserted)
       order by lower(asserted), fact_id
       limit ${PREDICATE_SCAN_CEILING + 1}`);

    if (rows.length > PREDICATE_SCAN_CEILING) {
      throw new AdapterError(
        `withPredicate: ${predicate} has more than ${PREDICATE_SCAN_CEILING} currently-believed ` +
          'facts. This port has no way to report a truncated result, and returning a capped one ' +
          'would be presented as a complete answer. Ask a narrower question, or run it through ' +
          'runAnalyticalQuery where a cap is part of the contract.',
      );
    }
    return rows.map(rowToFact);
  });
}

export function createPostgresPredicateIndex(executor?: Executor): PredicateIndexPort {
  const ex = (): Executor => executor ?? db();
  return { withPredicate: (predicate) => factsWithPredicate(predicate, ex()) };
}

/* ── 4. QueryExecutorPort — the guarded escape hatch ────────────────────── */

/** 006's role. The boundary; everything in `inspectAnalyticalQuery` is depth. */
export const ANALYST_ROLE = 'tmos_analyst';

/** The connection string that must authenticate as a member of that role. */
export const ANALYST_URL_ENV = 'DATABASE_ANALYST_URL';

export interface AnalystExecutorOptions {
  /**
   * Opens a connection AUTHENTICATED AS a member of `tmos_analyst`. Not an
   * `Executor`: this port needs `begin read only`, `set local` and a raw
   * statement, none of which a `sql` template can carry.
   */
  readonly connect: Connect;
  /** A label for error messages. NEVER a connection string. */
  readonly label?: string;
}

export interface SessionProbe {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  readonly createRole: boolean;
  readonly analystExists: boolean;
  readonly member: boolean;
}

/**
 * Is this connection actually the boundary?
 *
 * Run on EVERY call, not cached at construction: a pool hands out an arbitrary
 * session, and the whole value of this check is that it cannot be true once and
 * assumed thereafter. One round trip against an escape hatch that is about to
 * run an ad-hoc analytical query is not a cost worth optimising.
 *
 * `rolbypassrls` and `rolcreaterole` are checked alongside `is_superuser`
 * because on Supabase the dangerous role is not a superuser: `postgres` has
 * `rolsuper = false`, `rolbypassrls = true` and `rolcreaterole = true`, and
 * `createrole_self_grant = 'inherit'` means it INHERITS `tmos_analyst` — so a
 * membership check alone would wave the privileged connection straight through.
 * The attribute checks are what actually reject it.
 */
export async function probeSession(client: DbClient): Promise<SessionProbe> {
  const result = await client.query(
    `select current_user::text as role,
            current_setting('is_superuser') = 'on' as superuser,
            coalesce((select r.rolbypassrls  from pg_roles r
                       where r.rolname = current_user), false) as bypass_rls,
            coalesce((select r.rolcreaterole from pg_roles r
                       where r.rolname = current_user), false) as create_role,
            to_regrole($1) is not null as analyst_exists,
            case when to_regrole($1) is null then false
                 else pg_has_role(current_user, to_regrole($1), 'MEMBER') end as member`,
    [ANALYST_ROLE],
  );

  const [row] = result.rows as QueryRow[];
  if (row === undefined) {
    throw new AdapterError('analyticalQuery: the session probe returned no row');
  }
  return {
    role: asText(row.role, 'session.current_user'),
    superuser: asBoolean(row.superuser, 'session.is_superuser'),
    bypassRls: asBoolean(row.bypass_rls, 'session.rolbypassrls'),
    createRole: asBoolean(row.create_role, 'session.rolcreaterole'),
    analystExists: asBoolean(row.analyst_exists, 'session.analyst_exists'),
    member: asBoolean(row.member, 'session.pg_has_role'),
  };
}

export function assertAnalystSession(probe: SessionProbe, label: string): void {
  const where = `analyticalQuery: ${label} authenticates as "${probe.role}"`;

  if (!probe.analystExists) {
    throw new AdapterError(
      `${where}, and role ${ANALYST_ROLE} does not exist on this database — migration 006 has ` +
        'not been applied. Apply it before wiring the analytical executor.',
    );
  }

  const elevated = [
    probe.superuser ? 'is a superuser' : null,
    probe.bypassRls ? 'has BYPASSRLS' : null,
    probe.createRole ? 'has CREATEROLE' : null,
  ].filter((reason): reason is string => reason !== null);

  if (elevated.length > 0) {
    throw new AdapterError(
      `${where}, which ${elevated.join(' and ')}. That is a privileged connection, not the ` +
        `read-only boundary: BYPASSRLS defeats 010's policies, CREATEROLE can grant itself ` +
        'anything, and either turns the escape hatch back into an unrestricted one. Point ' +
        `${ANALYST_URL_ENV} at a login role whose ONLY privilege is membership of ` +
        `${ANALYST_ROLE}. Refusing rather than running.`,
    );
  }

  if (!probe.member) {
    throw new AdapterError(
      `${where}, which is not a member of ${ANALYST_ROLE} — so 006's six SELECT grants and ` +
        `010's RLS policies do not apply to it, and every query would return zero rows rather ` +
        `than an error. Grant it: \`grant ${ANALYST_ROLE} to "${probe.role}";\`. Refusing.`,
    );
  }
}

function positiveInt(value: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new AdapterError(
      `analyticalQuery: ${field} must be an integer in 1..${max}, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * The analytical executor.
 *
 * The transaction is `begin read only` and always ends in `rollback`. Both are
 * belt: 006 puts `default_transaction_read_only` on the role, but role-level
 * GUCs apply to the role that LOGGED IN, and the login role here is a member of
 * `tmos_analyst` rather than `tmos_analyst` itself — so the setting is NOT in
 * force and this transaction has to declare it. The same is true of
 * `statement_timeout`, which is why it is set per statement from the caller's
 * value rather than trusted to the role.
 *
 * `client.query(text)` speaks `@tmos/db`'s LOW-LEVEL port directly, which
 * `pool.ts` reserves for transaction bookkeeping and the migration runner. This
 * is the third caller and the only other legitimate one: the whole purpose of
 * this port is to run a statement that arrived as a string, so there is no
 * `sql` template to build. Every value that is not that statement — the role
 * name in the probe — still goes through a parameter. The timeout is the one
 * number interpolated into SQL text, and it is validated as an integer in
 * 1..30000 immediately above the line that formats it.
 */
export function createPostgresQueryExecutor(opts: AnalystExecutorOptions): QueryExecutorPort {
  const label = opts.label ?? ANALYST_URL_ENV;

  return {
    async run(req) {
      const maxRows = positiveInt(req.maxRows, ANALYTICAL_MAX_ROWS, 'maxRows');
      const timeoutMs = positiveInt(
        req.statementTimeoutMs,
        ANALYTICAL_MAX_TIMEOUT_MS,
        'statementTimeoutMs',
      );

      const client = await opts.connect();
      let opened = false;
      let broken = false;
      try {
        return await guard('analyticalQuery', async () => {
          await client.query('begin read only');
          opened = true;
          assertAnalystSession(await probeSession(client), label);
          await client.query(`set local statement_timeout = ${String(timeoutMs)}`);

          const result = await client.query(req.sql);
          const rows = (result.rows as unknown[]).map((row, i) => asRecord(row, i));
          // A ceiling on top of the LIMIT `inspectAnalyticalQuery` already
          // required, for the case where this port is called directly. Slicing
          // to exactly `maxRows` is what makes tools.ts report `truncated`.
          const capped = rows.length > maxRows ? rows.slice(0, maxRows) : rows;
          return { rows: capped, rowCount: capped.length };
        });
      } finally {
        if (opened) {
          try {
            await client.query('rollback');
          } catch {
            // The session's state is now unknown; it must not be reused.
            broken = true;
          }
        }
        client.release(broken || undefined);
      }
    },
  };
}

function asRecord(row: unknown, index: number): Record<string, unknown> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new AdapterError(`analyticalQuery: row ${index} is not an object`);
  }
  return { ...(row as Record<string, unknown>) };
}

/**
 * Config for the analytical pool, and the operator action it needs.
 *
 * 006 created `tmos_analyst` NOLOGIN with no password on purpose — "Credentials
 * do not belong in a migration in a repository" — and says to provision a login
 * role out of band. That is still the instruction; this function is only the
 * env half of it. In full:
 *
 *     create role tmos_analyst_login login password '<generated>';
 *     grant tmos_analyst to tmos_analyst_login;
 *     -- 006's role-level settings are applied at LOGIN, to the role that logged
 *     -- in, and are NOT inherited through membership. Repeat them, or this
 *     -- adapter's per-transaction `begin read only` + `set local` is the only
 *     -- thing enforcing them:
 *     alter role tmos_analyst_login set default_transaction_read_only = on;
 *     alter role tmos_analyst_login set statement_timeout = '30s';
 *     alter role tmos_analyst_login set idle_in_transaction_session_timeout = '60s';
 *
 * then put that role's connection string in `DATABASE_ANALYST_URL`. It must not
 * be the same string as `DATABASE_URL`; that is checked here rather than
 * trusted, because the failure it prevents is silent.
 *
 * There is deliberately NO fallback to `DATABASE_URL`. `@tmos/db`'s config
 * refuses to default to localhost for the same reason: a connection that
 * quietly points somewhere else is worse than no connection at all, and here
 * "somewhere else" is the service role.
 */
export function loadAnalystDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env[ANALYST_URL_ENV];

  if (url === undefined || url.trim() === '') {
    throw new AdapterError(
      `${ANALYST_URL_ENV} is required for the analytical executor and is not set. It is a ` +
        'SEPARATE connection string from DATABASE_URL, authenticating as a login role that is a ' +
        `member of ${ANALYST_ROLE} (migration 006). There is no fallback to the service ` +
        'connection: routing an ad-hoc query through it would defeat the entire boundary.',
    );
  }
  if (env.DATABASE_URL !== undefined && url === env.DATABASE_URL) {
    throw new AdapterError(
      `${ANALYST_URL_ENV} is the same connection string as DATABASE_URL — that is the ` +
        'service-role connection, which bypasses RLS and can write. Provision a login role ' +
        `granted ${ANALYST_ROLE} and point this at it.`,
    );
  }

  return loadDbConfig({
    ...env,
    DATABASE_URL: url,
    // Two connections is plenty for an escape hatch, and a runaway analytical
    // query must not be able to starve the worker of pooler slots.
    DATABASE_POOL_MAX: env.DATABASE_ANALYST_POOL_MAX ?? '2',
    // Matches the ceiling `inspectAnalyticalQuery` enforces and the one 006 put
    // on the role. `set local` narrows it per statement; this is the roof.
    DATABASE_STATEMENT_TIMEOUT_MS: String(ANALYTICAL_MAX_TIMEOUT_MS),
  });
}
