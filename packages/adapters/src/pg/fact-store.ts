/**
 * `FactStore` (packages/world/src/fact/types.ts) on Postgres `fact` — migration
 * 002, semantics fixed by 009.
 *
 * The behavioural specification is `createMemoryFactStore`, not this file. Where
 * the two could differ they are made to agree, and where they CANNOT agree the
 * difference is named in a comment here and in the README, because a divergence
 * nobody wrote down is a divergence someone discovers in production.
 *
 * Three rules govern everything below:
 *
 *   THE ADAPTER NEVER READS THE CLOCK. Every instant — both bounds of both
 *   axes, `observed_at`, the argument to `closeAsserted` — arrives from the
 *   caller. The `asserted` column's `default tstzrange(now(), null)` is
 *   therefore never used. This is not fussiness: `now()` is FROZEN for the
 *   duration of a transaction, so an adapter that reached for it would produce
 *   an empty range the moment a caller inserted and closed inside one `withTx`,
 *   and 009 would reject the write with a message about ranges rather than
 *   about time. Every instant coming from above is also the reason the memory
 *   store and this one agree on temporal behaviour at all.
 *
 *   ONE METHOD, ONE STATEMENT — except on the failure path. `closeAsserted` and
 *   `closeValid` guard their preconditions in the WHERE clause, so a violation
 *   returns zero rows instead of raising. Then, and only then, a second read
 *   works out which precondition failed and throws the error the memory store
 *   would have thrown. That ordering matters more than it looks: `withTx` has
 *   no savepoints, so a raised exception poisons the whole transaction and the
 *   diagnostic read would fail with "current transaction is aborted" — the
 *   caller would lose both the real reason and everything else in the batch.
 *
 *   `ex: Executor = db()` IS THE LAST PARAMETER of every function. Called with
 *   nothing it uses the pool; called inside someone's `withTx` — or handed that
 *   transaction explicitly — it enlists in it. No repository here knows or
 *   cares which.
 */
import { db, sql, type Executor } from '@tmos/db';
import type { FactRow, FactStatus, FactStore } from '@tmos/world';

import { AppendOnlyError, ConstraintError, EmptyRangeError, NotFoundError, guard } from '../errors.js';
import { boundsOf, evidenceToColumn, factValueToColumns, rowToFact } from './fact-row.js';
import { isUuid } from './values.js';

/**
 * The projection, nested into every read so the decoder only ever meets one
 * shape. Ranges are selected as their bounds (node-postgres cannot parse
 * `tstzrange`), uuids as `::text` (a `FactRow` id is a string, and casting in
 * the query means the result does not depend on a driver type parser), and
 * `object_json is not null` because SQL NULL and the jsonb document `null` are
 * indistinguishable by the time they reach JavaScript.
 */
const FACT_COLUMNS = sql`
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
 * The port says "in insertion order". `fact` has no insertion counter and its
 * primary key is a random uuid, so the closest honest ordering is when we
 * started believing the row, with the id as a deterministic tiebreak for facts
 * asserted in the same transaction (where `now()` is frozen, so ties are the
 * normal case rather than a rare one).
 *
 * This is the one place the two stores can hand back the same rows in a
 * different order — a backfill that supplies an old `asserted.from` sorts early
 * here and last in the memory store. Nothing depends on it: `query.ts` sorts
 * explicitly before choosing, and `golden.test.ts` deliberately REVERSES the
 * store's output to prove the golden record is order-independent.
 */
const FACT_ORDER = sql`order by lower(asserted), fact_id`;

/**
 * Refuse a degenerate range BEFORE the statement runs.
 *
 * Two failures, and the database handles each one badly in a different way.
 *
 * INVERTED (`to` < `from`): the range constructor raises 22000, which ABORTS
 * the caller's transaction. `withTx` has no savepoints, so everything after it
 * dies with 25P02 and the real diagnosis is lost — the same reason the close
 * guards are WHERE clauses rather than raises.
 *
 * EMPTY (`to` == `from`): far worse, because it SUCCEEDS. Postgres normalises
 * `tstzrange(T0, T0)` to `empty`, after which `lower()` and `upper()` are both
 * NULL — so the row is undecodable, and since reads are per-entity it takes
 * every later read of that ENTITY down with it, not just itself. Migration 009
 * cannot catch it: its guards are BEFORE UPDATE and BEFORE DELETE, and this is
 * an INSERT. A `check (not isempty(...))` belongs in a later migration as
 * defence in depth, but the row is best never written at all.
 */
function assertRangeStorable(range: { from: string; to: string | null }, axis: string): void {
  if (range.to === null) return;
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new ConstraintError(`insert: ${axis} has an unparseable bound (${range.from}, ${range.to})`);
  }
  if (to === from) {
    throw new EmptyRangeError(
      `insert: ${axis} would be empty — ${range.from} to ${range.to} contains no instant. ` +
        'Postgres normalises it to `empty`, whose bounds are both NULL, which makes this row ' +
        'and every later read of this entity undecodable.',
    );
  }
  if (to < from) {
    throw new ConstraintError(
      `insert: ${axis} upper bound ${range.to} precedes its lower bound ${range.from} ` +
        '(range lower bound must be less than or equal to range upper bound)',
    );
  }
}

export async function insertFact(
  row: Omit<FactRow, 'factId'>,
  ex: Executor = db(),
): Promise<FactRow> {
  assertRangeStorable(row.valid, 'valid');
  assertRangeStorable(row.asserted, 'asserted');

  const value = factValueToColumns(row.value);
  const evidence = JSON.stringify(evidenceToColumn(row.evidence));

  return guard('insert', async () =>
    rowToFact(
      await ex.one(sql`
        insert into fact (
          entity_id, predicate,
          object_text, object_num, object_entity, object_json,
          valid, asserted,
          source_id, observed_at, confidence, method, evidence, supersedes, status
        ) values (
          ${row.entityId}::uuid, ${row.predicate},
          ${value.text}, ${value.num}, ${value.entity}::uuid, ${value.json}::jsonb,
          tstzrange(${row.valid.from}::timestamptz, ${row.valid.to}::timestamptz),
          tstzrange(${row.asserted.from}::timestamptz, ${row.asserted.to}::timestamptz),
          ${row.sourceId}::uuid, ${row.observedAt}::timestamptz, ${row.confidence},
          ${row.method}, ${evidence}::jsonb, ${row.supersedes}::uuid, ${row.status}
        )
        returning ${FACT_COLUMNS}`),
    ),
  );
}

/**
 * A malformed id is "not found", never an error. The memory store's ids look
 * like `fact_00000a`; handing one to Postgres would raise 22P02 and turn a
 * miss into a crash, which is exactly the class of difference that makes two
 * implementations of a port non-substitutable.
 */
export async function factById(factId: string, ex: Executor = db()): Promise<FactRow | null> {
  if (!isUuid(factId)) return null;

  return guard('byId', async () => {
    const row = await ex.maybeOne(
      sql`select ${FACT_COLUMNS} from fact where fact_id = ${factId}::uuid`,
    );
    return row === null ? null : rowToFact(row);
  });
}

export async function factsForPredicate(
  entityId: string,
  predicate: string,
  ex: Executor = db(),
): Promise<FactRow[]> {
  if (!isUuid(entityId)) return [];

  return guard('forPredicate', async () => {
    const rows = await ex.query(sql`
      select ${FACT_COLUMNS} from fact
       where entity_id = ${entityId}::uuid and predicate = ${predicate}
       ${FACT_ORDER}`);
    return rows.map(rowToFact);
  });
}

export async function factsForEntity(entityId: string, ex: Executor = db()): Promise<FactRow[]> {
  if (!isUuid(entityId)) return [];

  return guard('forEntity', async () => {
    const rows = await ex.query(sql`
      select ${FACT_COLUMNS} from fact where entity_id = ${entityId}::uuid ${FACT_ORDER}`);
    return rows.map(rowToFact);
  });
}

/** Correcting OURSELVES: we stopped believing this at `at`. */
export const closeFactAsserted = (factId: string, at: string, ex: Executor = db()): Promise<void> =>
  closeBound('asserted', 'closeAsserted', factId, at, ex);

/** The WORLD changing: it stopped being true at `at`. */
export const closeFactValid = (factId: string, at: string, ex: Executor = db()): Promise<void> =>
  closeBound('valid', 'closeValid', factId, at, ex);

export async function setFactStatus(
  factId: string,
  status: FactStatus,
  ex: Executor = db(),
): Promise<void> {
  if (!isUuid(factId)) throw new NotFoundError(`setStatus: no such fact ${factId}`);

  const changed = await guard('setStatus', () =>
    ex.execute(sql`update fact set status = ${status} where fact_id = ${factId}::uuid`),
  );
  if (changed === 0) throw new NotFoundError(`setStatus: no such fact ${factId}`);
}

/**
 * Both closers, sharing one implementation so the two axes cannot drift — the
 * same argument 009 makes for sharing `fact_range_append_only` between them.
 *
 * The axis reaches the SQL as a nested `SqlQuery` rather than as a parameter: a
 * placeholder can carry a value but never an identifier, and there is
 * deliberately no `sql.raw` to reach for.
 */
async function closeBound(
  axis: 'valid' | 'asserted',
  op: string,
  factId: string,
  at: string,
  ex: Executor,
): Promise<void> {
  if (!isUuid(factId)) throw new NotFoundError(`${op}: no such fact ${factId}`);

  const column = axis === 'valid' ? sql`valid` : sql`asserted`;

  const closed = await guard(op, () =>
    ex.execute(sql`
      update fact
         set ${column} = tstzrange(lower(${column}), ${at}::timestamptz)
       where fact_id = ${factId}::uuid
         and upper_inf(${column})
         and lower(${column}) < ${at}::timestamptz`),
  );
  if (closed === 1) return;

  await explainFailedClose(axis, op, factId, at, ex);
}

/**
 * Zero rows updated. Exactly one of four things is true, and the caller is
 * entitled to know which — so this reads the row back and reconstructs the
 * error the memory store would have raised, verbatim where one exists.
 */
async function explainFailedClose(
  axis: 'valid' | 'asserted',
  op: string,
  factId: string,
  at: string,
  ex: Executor,
): Promise<never> {
  const row = await guard(op, () =>
    ex.maybeOne(sql`
      select lower(valid) as valid_from, upper(valid) as valid_to,
             lower(asserted) as asserted_from, upper(asserted) as asserted_to
        from fact where fact_id = ${factId}::uuid`),
  );

  if (row === null) throw new NotFoundError(`${op}: no such fact ${factId}`);

  const bounds = boundsOf(row, axis);

  if (bounds.to !== null) {
    // The memory store's `closeAsserted` refuses this too, in the same words.
    // Its `closeValid` does NOT — it silently overwrites a closed bound, which
    // 009 forbids on both axes. See README, "where the two disagree".
    throw new AppendOnlyError(
      `${op}: ${factId} already closed at ${bounds.to}` +
        (axis === 'valid'
          ? ' — migration 009 permits infinite → finite once and nothing else; correct a ' +
            'wrong end date on the asserted axis, by superseding the row'
          : ''),
    );
  }

  if (new Date(at).getTime() === new Date(bounds.from).getTime()) {
    throw new EmptyRangeError(
      `${op}: ${at} is the instant ${axis} opened, so closing there stores an interval ` +
        'containing no instant, which migration 009 rejects. If this is unexpected: now() is ' +
        'FROZEN for a whole transaction, so asserting and then closing a fact inside one ' +
        'withTx() gives both bounds the same timestamp. Take the instant from the caller, ' +
        'or close in a later transaction.',
    );
  }

  // `at` precedes the lower bound. Word for word what the memory store says for
  // closeValid; its closeAsserted has no such check and would have accepted it.
  throw new AppendOnlyError(`${op}: ${at} precedes ${axis}.from ${bounds.from}`);
}

/**
 * The port, bound to an executor.
 *
 * `executor` is resolved PER CALL, not captured at construction: a store built
 * at module scope and used inside a `withTx` must enlist in that transaction,
 * and `db()` only knows which one is running while it is running. Written as
 * `createPostgresFactStore(ex = db())` the default would bind the pool once,
 * forever, and every write through this store would silently escape the
 * caller's transaction.
 */
export function createPostgresFactStore(executor?: Executor): FactStore {
  const ex = (): Executor => executor ?? db();

  return {
    insert: (row) => insertFact(row, ex()),
    byId: (factId) => factById(factId, ex()),
    forPredicate: (entityId, predicate) => factsForPredicate(entityId, predicate, ex()),
    forEntity: (entityId) => factsForEntity(entityId, ex()),
    closeAsserted: (factId, at) => closeFactAsserted(factId, at, ex()),
    closeValid: (factId, at) => closeFactValid(factId, at, ex()),
    setStatus: (factId, status) => setFactStatus(factId, status, ex()),
  };
}
