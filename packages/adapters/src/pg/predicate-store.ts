/**
 * `PredicateStore` (packages/world/src/fact/predicates.ts) on `predicate_def`
 * (001, + `subjective` in 007) and `predicate_occurrence` (007).
 *
 * ONE PORT, TWO TABLES, AND TWO FIELDS THAT ARE NOT COLUMNS. This is the
 * interesting part of this adapter and the reason to read it before writing the
 * next one:
 *
 *   `PredicateDef.distinctSources` is not a column. It is
 *   `select source_id from predicate_occurrence where predicate = $1`, because
 *   007 replaced "seen N times" with "seen by N distinct sources" — one chatty
 *   source repeating a malformed attribute forty times must not look like forty
 *   sources converging on a real one.
 *
 *   `PredicateDef.occurrences` IS a column, and this adapter never writes it.
 *   007's `predicate_occurrence_sync` trigger recomputes it from
 *   `sum(predicate_occurrence.count)` after every ledger write. An adapter that
 *   also set it directly would be writing a number the database is about to
 *   overwrite — and would disagree with it for exactly as long as it took
 *   someone to notice.
 *
 * `upsert(def)` therefore cannot store what it is handed. It stores the
 * DEFINITION and reconciles the LEDGER — see `reconcileOccurrences`, which is
 * where the one lossy step in this package lives, documented in place.
 */
import { db, sql, type Executor, type QueryRow, type SqlQuery } from '@tmos/db';
import {
  normalizePredicateName,
  type PredicateCardinality,
  type PredicateDatatype,
  type PredicateDef,
  type PredicateStatus,
  type PredicateStore,
} from '@tmos/world';

import { AdapterError, guard } from '../errors.js';
import { asBoolean, asNumber, asStringArray, asText, asTextOrNull, asUnion } from './values.js';

const DATATYPES: readonly PredicateDatatype[] = ['text', 'num', 'entity', 'json'];
const CARDINALITIES: readonly PredicateCardinality[] = ['one', 'many'];
const STATUSES: readonly PredicateStatus[] = ['proposed', 'active', 'deprecated'];

/**
 * `distinct_sources` is aggregated in a correlated subquery rather than a join,
 * so a predicate with no occurrences still comes back (a `join` would drop it,
 * and a freshly proposed predicate is exactly the row promotion cares about).
 * The uuids are cast to `::text` inside the aggregate: `text[]` is a type
 * node-postgres parses everywhere, `uuid[]` is not guaranteed to be.
 */
const PREDICATE_COLUMNS = sql`
  pd.predicate,
  pd.entity_type,
  pd.datatype,
  pd.unit,
  pd.cardinality,
  pd.status,
  pd.description,
  pd.aliases,
  pd.superseded_by,
  pd.occurrences,
  pd.subjective,
  coalesce(
    (select array_agg(po.source_id::text order by po.first_seen, po.source_id)
       from predicate_occurrence po
      where po.predicate = pd.predicate),
    '{}'::text[]
  ) as distinct_sources`;

/**
 * The memory store returns rows in insertion order (a `Map`). `created_at`
 * is the only column that records it, with the name as a tiebreak for rows
 * created in the same transaction — where `now()` is frozen, so ties are
 * normal rather than rare.
 */
const PREDICATE_ORDER = sql`order by pd.created_at, pd.predicate`;

/**
 * `normalizePredicateName` from `@tmos/world`, in SQL.
 *
 * A second implementation of a function that already exists is a drift hazard
 * and normally the wrong trade. It is made here because the alternative is
 * `byAlias` reading every predicate into the process to filter in JavaScript,
 * and because the drift is TESTABLE: `predicate-store.live.test.ts` runs both
 * implementations over the same adversarial inputs and fails if they ever
 * disagree. Do not change one of these without running that test.
 *
 * The argument arrives as a nested `SqlQuery` — either a column reference or a
 * parameter — since a placeholder cannot carry an identifier and there is
 * deliberately no `sql.raw`.
 */
export function normalizePredicateNameSql(expr: SqlQuery): SqlQuery {
  return sql`btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(${expr})), '[[:space:].-]+', '_', 'g'),
        '[^a-z0-9_]', '', 'g'),
      '_+', '_', 'g'),
    '_')`;
}

export function rowToPredicateDef(row: QueryRow): PredicateDef {
  const predicate = asText(row.predicate, 'predicate_def.predicate');
  const at = (column: string): string => `predicate_def[${predicate}].${column}`;

  return {
    predicate,
    entityType: asText(row.entity_type, at('entity_type')),
    datatype: asUnion(row.datatype, DATATYPES, at('datatype')),
    unit: asTextOrNull(row.unit, at('unit')),
    cardinality: asUnion(row.cardinality, CARDINALITIES, at('cardinality')),
    status: asUnion(row.status, STATUSES, at('status')),
    description: asText(row.description, at('description')),
    aliases: asStringArray(row.aliases, at('aliases')),
    supersededBy: asTextOrNull(row.superseded_by, at('superseded_by')),
    occurrences: asNumber(row.occurrences, at('occurrences')),
    subjective: asBoolean(row.subjective, at('subjective')),
    distinctSources: asStringArray(row.distinct_sources, at('distinct_sources')),
  };
}

export async function predicateByName(
  predicate: string,
  ex: Executor = db(),
): Promise<PredicateDef | null> {
  const name = normalizePredicateName(predicate);

  return guard('get', async () => {
    const row = await ex.maybeOne(
      sql`select ${PREDICATE_COLUMNS} from predicate_def pd where pd.predicate = ${name}`,
    );
    return row === null ? null : rowToPredicateDef(row);
  });
}

/**
 * Aliases are stored as written, so the comparison normalizes BOTH sides —
 * the same thing the memory store does at read time, for the same reason:
 * `upsert` does not normalize the alias array, only `proposePredicate` does,
 * so an alias added by hand can be any spelling of the name.
 *
 * A full scan with `unnest`, deliberately: `aliases` has no index, the table is
 * a curated semantic layer of hundreds of rows, and the alternative is pulling
 * all of them into JavaScript to do the same work. `limit 1` on the memory
 * store's ordering keeps "which definition wins when two claim the same alias"
 * the same answer in both.
 */
export async function predicateByAlias(
  alias: string,
  ex: Executor = db(),
): Promise<PredicateDef | null> {
  const wanted = normalizePredicateName(alias);

  return guard('byAlias', async () => {
    const row = await ex.maybeOne(sql`
      select ${PREDICATE_COLUMNS} from predicate_def pd
       where exists (
         select 1 from unnest(pd.aliases) as a
          where ${normalizePredicateNameSql(sql`a`)} = ${wanted}
       )
       ${PREDICATE_ORDER}
       limit 1`);
    return row === null ? null : rowToPredicateDef(row);
  });
}

export async function allPredicates(ex: Executor = db()): Promise<PredicateDef[]> {
  return guard('all', async () => {
    const rows = await ex.query(
      sql`select ${PREDICATE_COLUMNS} from predicate_def pd ${PREDICATE_ORDER}`,
    );
    return rows.map(rowToPredicateDef);
  });
}

/**
 * Definition + ledger.
 *
 * NOT atomic on its own: it is three statements (read, upsert, reconcile) and
 * `@tmos/db` has no savepoints by design. Wrap the call in `withTx` when the
 * caller needs all-or-nothing, which is also what makes the read-then-write in
 * `reconcileOccurrences` safe against a concurrent proposer.
 */
export async function upsertPredicate(
  def: PredicateDef,
  ex: Executor = db(),
): Promise<PredicateDef> {
  const predicate = normalizePredicateName(def.predicate);
  const before = await predicateByName(predicate, ex);

  await guard('upsert', () =>
    ex.execute(sql`
      insert into predicate_def (
        predicate, entity_type, datatype, unit, cardinality,
        status, description, aliases, superseded_by, subjective
      ) values (
        ${predicate}, ${def.entityType}, ${def.datatype}, ${def.unit}, ${def.cardinality},
        ${def.status}, ${def.description}, ${def.aliases}::text[], ${def.supersededBy},
        ${def.subjective}
      )
      on conflict (predicate) do update set
        entity_type   = excluded.entity_type,
        datatype      = excluded.datatype,
        unit          = excluded.unit,
        cardinality   = excluded.cardinality,
        status        = excluded.status,
        description   = excluded.description,
        aliases       = excluded.aliases,
        superseded_by = excluded.superseded_by,
        subjective    = excluded.subjective`),
  );

  await reconcileOccurrences(predicate, def, before, ex);

  const after = await predicateByName(predicate, ex);
  if (after === null) {
    // Only reachable if something deleted the row between the write and the
    // read. Reported rather than papered over with the input echoed back.
    throw new AdapterError(`upsert: ${predicate} disappeared between write and read`);
  }
  return after;
}

/** One sighting of `predicate` by `sourceId`. The honest way to move the ledger. */
export const recordPredicateOccurrence = (
  predicate: string,
  sourceId: string,
  ex: Executor = db(),
): Promise<void> => bumpOccurrence(normalizePredicateName(predicate), sourceId, 1, ex);

/**
 * THE ONE LOSSY STEP IN THIS PACKAGE, and it is a port problem rather than a
 * schema problem.
 *
 * `recordOccurrence` in `@tmos/world` knows which source made the observation.
 * `PredicateStore.upsert` does not: it receives a whole `PredicateDef` in which
 * that observation has already been folded into `occurrences + 1` and a
 * `distinctSources` array that may not have changed at all. So:
 *
 *   · a source that is new to the ledger gets a row with `count` 1 — exact.
 *   · a repeat sighting by a source already in the ledger arrives as nothing but
 *     `occurrences + 1`. The total must still move (promotion reads it), so the
 *     surplus is attributed to the LAST source in `distinctSources`. Every
 *     observable the port exposes — the total, the distinct set, and therefore
 *     `evaluatePromotion` — is then identical to the memory store's. What is
 *     lost is per-source attribution inside `predicate_occurrence.count`, which
 *     the port never had a way to express.
 *
 * `recordPredicateOccurrence` above does it exactly, and a port method taking
 * `(predicate, sourceId)` would remove the guesswork entirely. That is a
 * `packages/world` change — a serial one — and is filed in the README.
 */
async function reconcileOccurrences(
  predicate: string,
  def: PredicateDef,
  before: PredicateDef | null,
  ex: Executor,
): Promise<void> {
  const known = new Set(before?.distinctSources ?? []);
  const added = def.distinctSources.filter((sourceId) => !known.has(sourceId));
  const delta = def.occurrences - (before?.occurrences ?? 0);
  const surplus = Math.max(0, delta - added.length);

  for (const sourceId of added) await bumpOccurrence(predicate, sourceId, 1, ex);

  const attributed = def.distinctSources.at(-1);
  if (surplus > 0 && attributed !== undefined) {
    await bumpOccurrence(predicate, attributed, surplus, ex);
  }
}

/**
 * `count` is quoted because it is also a function name; unquoted it reads as an
 * aggregate to anyone scanning the file even where Postgres accepts it.
 * `last_seen` is the one timestamp in this package the database supplies — the
 * port has no field for it, so there is nothing for a caller to pass.
 */
async function bumpOccurrence(
  predicate: string,
  sourceId: string,
  count: number,
  ex: Executor,
): Promise<void> {
  await guard('recordOccurrence', () =>
    ex.execute(sql`
      insert into predicate_occurrence (predicate, source_id, "count")
      values (${predicate}, ${sourceId}::uuid, ${count})
      on conflict (predicate, source_id) do update
        set "count"  = predicate_occurrence."count" + excluded."count",
            last_seen = now()`),
  );
}

/** See `createPostgresFactStore` — `executor` is resolved per call, never captured. */
export function createPostgresPredicateStore(executor?: Executor): PredicateStore {
  const ex = (): Executor => executor ?? db();

  return {
    get: (predicate) => predicateByName(predicate, ex()),
    byAlias: (alias) => predicateByAlias(alias, ex()),
    upsert: (def) => upsertPredicate(def, ex()),
    all: () => allPredicates(ex()),
  };
}
