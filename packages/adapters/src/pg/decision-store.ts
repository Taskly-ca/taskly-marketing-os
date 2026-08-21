/**
 * `DecisionStore` (packages/decide/src/decision/store.ts) on Postgres
 * `decision_record` — migration 003, constraint repaired by 010, FK question
 * settled by 012.
 *
 * The behavioural specification is `createMemoryDecisionStore`, not this file.
 * Where the two could differ they are made to agree; where they CANNOT, the
 * difference is named in a comment here and in the report, because a divergence
 * nobody wrote down is a divergence someone discovers in production.
 *
 * FOUR THINGS ABOUT THIS TABLE THAT ARE NOT LIKE THE OTHERS:
 *
 *   `id` IS `text`, NOT A UUID. It is `DEC-YYYY-NNN`, assigned by a human and
 *   never reused. So there is no `isUuid` guard on the read path here — every
 *   string is a legal lookup key and a miss is a miss, exactly as in memory.
 *
 *   `prediction_ids` IS `uuid[]` WITH NO FOREIGN KEY, and `prediction.decision_id`
 *   is `text` with no foreign key back. Both directions are soft references and
 *   012 says why the constraint is impossible rather than merely absent: a
 *   genuine cycle. `decision_needs_prediction` requires the predictions to exist
 *   BEFORE the decision row, while `decision_id` points the other way. Keeping
 *   the two sides consistent is the application's job — which is what
 *   `predictionFactsFor` below is for.
 *
 *   THE TWO CHECK CONSTRAINTS ARE THE MECHANISM, and one of them used to be
 *   decorative. 003 wrote `array_length(prediction_ids, 1) >= 1`, which PASSES
 *   on an empty array: `array_length('{}', 1)` is NULL, `NULL >= 1` is NULL, and
 *   a CHECK evaluating to NULL passes. 010 replaced it with
 *   `coalesce(array_length(...), 0) >= 1`. The sibling
 *   `decision_needs_alternatives` was always sound (`jsonb_array_length('[]')`
 *   is 0, not NULL). Both now surface as `DecisionRejectedError` carrying the
 *   domain's own `Rejection`, with the detail worded EXACTLY as Zod words it —
 *   so a caller that catches `rejection.code === 'schema'` cannot tell whether
 *   the refusal came from `decisionRecordSchema` or from Postgres, which is the
 *   entire point of a port.
 *
 *   `expected_cost_cents` IS `bigint`, and node-postgres hands int8 back as a
 *   STRING. `Number('9007199254740993')` is 9007199254740992 — a wrong answer,
 *   silently, in a money column. It is therefore selected `::text` and decoded
 *   through `BigInt`, which refuses rather than rounds. See `asBigintCents`.
 *
 * `ex: Executor = db()` IS THE LAST PARAMETER of every function. Called with
 * nothing it uses the pool; called inside someone's `withTx` it enlists in it.
 */
import { db, sql, type Executor, type QueryRow } from '@tmos/db';
import { decisionRecordSchema, type DecisionRecord } from '@tmos/contracts';
import type { DecisionStore, PredictionFacts, Rejection, WriteDeps } from '@tmos/decide';

import {
  AdapterError,
  ConstraintError,
  DecodeError,
  guard,
  isPgError,
  translatePgError,
} from '../errors.js';
import { asBoolean, asIso, asStringArray, asText, isUuid } from './values.js';

/**
 * A write the DATABASE refused for a reason the DOMAIN already has a word for.
 *
 * `ConstraintError` would be true and useless: the caller of a `DecisionStore`
 * is written against `Rejection`/`RejectCode`, and telling it "23514
 * decision_needs_prediction" makes it parse a SQLSTATE to recover a code it
 * already has an enum for. Subclasses `AdapterError`, so the generic
 * `catch (e) { if (e instanceof AdapterError) }` still works.
 */
export class DecisionRejectedError extends AdapterError {
  readonly rejection: Rejection;

  constructor(rejection: Rejection, options?: ErrorOptions) {
    super(`${rejection.code}: ${rejection.detail}`, options);
    this.rejection = rejection;
  }
}

/**
 * CHECK constraint → the rejection `writeDecision` would have produced.
 *
 * Both map to `schema`, not to `prediction_missing`: these two constraints are
 * the database's copy of `decisionRecordSchema`'s own `.min(2)` / `.min(1)`, and
 * `prediction_missing` means something else entirely ("the prediction row you
 * cited does not exist"), which is `predictionFactsFor`'s department. The detail
 * strings are Zod's, verbatim — `${path}: ${message}`, the shape `writeDecision`
 * builds when `safeParse` fails — so one assertion covers both stores.
 */
const CHECK_REJECTIONS: Readonly<Record<string, Rejection>> = {
  decision_needs_prediction: {
    code: 'schema',
    detail: 'predictions: Too small: expected array to have >=1 items',
  },
  decision_needs_alternatives: {
    code: 'schema',
    detail: 'alternatives: Too small: expected array to have >=2 items',
  },
};

/** Why the constraint exists, kept out of `rejection.detail` so that stays Zod's. */
const CHECK_CONTEXT: Readonly<Record<string, string>> = {
  decision_needs_prediction:
    'migration 010: the 003 form of this CHECK passed on an empty array, because ' +
    'array_length of an empty array is NULL and a NULL CHECK passes',
  decision_needs_alternatives:
    'migration 003: two alternatives, or the record is a diary entry — ' +
    'jsonb_array_length has no NULL hole, so this one always worked',
};

function checkRejection(error: unknown, op: string): DecisionRejectedError | null {
  if (!isPgError(error) || error.code !== '23514') return null;
  const rejection = CHECK_REJECTIONS[error.constraint ?? ''];
  if (rejection === undefined) return null;

  return new DecisionRejectedError(
    {
      code: rejection.code,
      detail: `${rejection.detail} [${op}, ${error.constraint}] — ${CHECK_CONTEXT[error.constraint ?? ''] ?? ''}`,
    },
    { cause: error },
  );
}

/**
 * The projection, nested into every read so the decoder only ever meets one
 * shape. `uuid[]` is cast to `text[]` (a type node-postgres parses everywhere,
 * and a `DecisionRecord`'s ids are strings), `bigint` to `text` (see
 * `asBigintCents`), and `outcome is not null` is selected separately because
 * SQL NULL and the jsonb document `null` are indistinguishable by the time they
 * reach JavaScript — the same reason `fact` selects `has_json`.
 */
const DECISION_COLUMNS = sql`
  id,
  status,
  door,
  context,
  decision,
  alternatives,
  beliefs_relied_on::text[] as beliefs_relied_on,
  prediction_ids::text[] as prediction_ids,
  kill_criteria,
  expected_cost_cents::text as expected_cost_cents,
  decided_at,
  decided_by,
  outcome,
  outcome is not null as has_outcome`;

/**
 * The port says nothing about order and the memory store returns `Map`
 * insertion order. `decision_record` has no insertion counter, so the closest
 * honest ordering is when the decision was made, with the id as a deterministic
 * tiebreak — and `DEC-YYYY-NNN` sorts lexicographically into chronological
 * order within a year, so the tiebreak is meaningful rather than arbitrary.
 */
const DECISION_ORDER = sql`order by decided_at, id`;

/**
 * `bigint` → number, or a refusal. Never a rounding.
 *
 * `pg/values.ts`'s `asNumber` accepts int8's string form and calls `Number()`,
 * which is right for `numeric` (float64 is the best JS can do and the loss is
 * documented) and WRONG here: `expected_cost_cents` is a count of cents, an
 * exact integer, and quietly returning a neighbouring integer for a money value
 * is the failure mode this repo writes migrations about. `BigInt` parses
 * exactly and the safe-integer bound is checked before the narrowing, so the
 * only outcomes are "the exact number" and "a DecodeError naming the column".
 *
 * Deliberately module-private: it belongs in `pg/values.ts` next to `asNumber`,
 * and that file is another lane's to edit. Flagged in the report.
 */
function asBigintCents(value: unknown, column: string): number {
  const text = asText(value, column);
  if (!/^-?\d+$/.test(text)) {
    throw new DecodeError(`${column}: expected a bigint, got ${JSON.stringify(text)}`);
  }
  const exact = BigInt(text);
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (exact > limit || exact < -limit) {
    throw new DecodeError(
      `${column}: ${text} is outside the safe integer range, so it cannot become a JS ` +
        'number without changing value. The column is bigint and the contract is ' +
        'z.number().int(), which Zod bounds to ±(2^53 − 1) — a value this large was ' +
        'written by something that is not this adapter.',
    );
  }
  return Number(exact);
}

/**
 * Row → `DecisionRecord`, with the contract as the last gate.
 *
 * Columns are coerced first (so an error names the column), then the assembled
 * object goes through `decisionRecordSchema` — "Zod at every boundary", and the
 * boundary is here. The consequence is worth stating plainly: a row that
 * predates 010 and carries an EMPTY `prediction_ids` will not decode, it will
 * throw. That is the correct reading of `DecodeError` ("the row that came back
 * is not a DecisionRecord") and it is louder than handing a caller a record the
 * domain considers impossible — but it does mean one bad legacy row fails
 * `all()` rather than being skipped.
 */
export function rowToDecisionRecord(row: QueryRow): DecisionRecord {
  const id = asText(row.id, 'decision_record.id');
  const at = (column: string): string => `decision_record[${id}].${column}`;

  const hasOutcome = asBoolean(row.has_outcome, at('outcome'));
  if (hasOutcome && row.outcome === null) {
    throw new DecodeError(
      `${at('outcome')}: the column holds the jsonb document \`null\`, which is not an ` +
        'outcome and not "no outcome". Write SQL NULL for a decision whose result is ' +
        'not yet known.',
    );
  }

  const candidate = {
    id,
    status: row.status,
    door: row.door,
    context: row.context,
    decision: row.decision,
    alternatives: row.alternatives,
    beliefs_relied_on: asStringArray(row.beliefs_relied_on, at('beliefs_relied_on')),
    // The one column whose name differs from its field: `predictions` in the
    // contract, `prediction_ids` on disk. Nothing else here is renamed.
    predictions: asStringArray(row.prediction_ids, at('prediction_ids')),
    kill_criteria: row.kill_criteria,
    expected_cost_cents: asBigintCents(row.expected_cost_cents, at('expected_cost_cents')),
    decided_at: asIso(row.decided_at, at('decided_at')),
    decided_by: row.decided_by,
    outcome: hasOutcome ? row.outcome : null,
  };

  const parsed = decisionRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new DecodeError(
      `decision_record[${id}]: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * Upsert, because the memory store's `put` is a `Map.set` and
 * `recordDecisionOutcome` writes the whole record back with an outcome attached.
 * Append-only-ness of the decision log is `writeDecision`'s `immutable` refusal,
 * not the table's — there is no trigger here, and both stores accept a rewrite
 * of a `proposed` record.
 */
export async function putDecision(record: DecisionRecord, ex: Executor = db()): Promise<void> {
  // Unreachable through `writeDecision` — Zod v4's `.int()` is bounded by
  // Number.isSafeInteger — but the port takes a `DecisionRecord` and a caller
  // can build one by hand. Refused here rather than written, so that nothing is
  // ever stored that `asBigintCents` would later refuse to read back.
  if (!Number.isSafeInteger(record.expected_cost_cents)) {
    throw new ConstraintError(
      `put: expected_cost_cents ${record.expected_cost_cents} is not a safe integer — ` +
        'the column is bigint, but a value this large cannot round-trip back into a JS number',
    );
  }

  try {
    await ex.execute(sql`
      insert into decision_record (
        id, status, door, context, decision,
        alternatives, beliefs_relied_on, prediction_ids, kill_criteria,
        expected_cost_cents, decided_at, decided_by, outcome
      ) values (
        ${record.id}, ${record.status}, ${record.door}, ${record.context}, ${record.decision},
        ${JSON.stringify(record.alternatives)}::jsonb,
        ${record.beliefs_relied_on}::uuid[],
        ${record.predictions}::uuid[],
        ${JSON.stringify(record.kill_criteria)}::jsonb,
        ${String(record.expected_cost_cents)}::bigint,
        ${record.decided_at}::timestamptz,
        ${record.decided_by},
        ${record.outcome === null ? null : JSON.stringify(record.outcome)}::jsonb
      )
      on conflict (id) do update set
        status              = excluded.status,
        door                = excluded.door,
        context             = excluded.context,
        decision            = excluded.decision,
        alternatives        = excluded.alternatives,
        beliefs_relied_on   = excluded.beliefs_relied_on,
        prediction_ids      = excluded.prediction_ids,
        kill_criteria       = excluded.kill_criteria,
        expected_cost_cents = excluded.expected_cost_cents,
        decided_at          = excluded.decided_at,
        decided_by          = excluded.decided_by,
        outcome             = excluded.outcome`);
  } catch (error) {
    throw checkRejection(error, 'put') ?? translatePgError(error, 'put');
  }
}

/** No id guard: the primary key is `text`, so any string is a legal miss. */
export async function decisionById(id: string, ex: Executor = db()): Promise<DecisionRecord | null> {
  return guard('get', async () => {
    const row = await ex.maybeOne(
      sql`select ${DECISION_COLUMNS} from decision_record where id = ${id}`,
    );
    return row === null ? null : rowToDecisionRecord(row);
  });
}

export async function allDecisions(ex: Executor = db()): Promise<DecisionRecord[]> {
  return guard('all', async () => {
    const rows = await ex.query(
      sql`select ${DECISION_COLUMNS} from decision_record ${DECISION_ORDER}`,
    );
    return rows.map(rowToDecisionRecord);
  });
}

/**
 * `WriteDeps.predictionFacts` — the read that enforces "a decision cannot be
 * written against an already-resolved prediction".
 *
 * DUPLICATION, DELIBERATE AND FLAGGED: this reads the `prediction` table, which
 * `@tmos/intel` owns and whose adapter is another lane's file
 * (`pg/prediction-store.ts`). Three columns are projected here and nothing is
 * imported from there, so the two lanes cannot deadlock on each other; at
 * integration this should collapse into a projection over the intel adapter's
 * row mapper.
 *
 * `resolved` is deliberately the OR of both resolution markers. `intel`'s
 * `resolve()` writes `outcome` and `resolved_at` together and
 * `prediction_due_idx` keys on `outcome is null`, so they normally agree; if a
 * half-written resolution ever exists, counting it as resolved fails CLOSED,
 * and closed is the safe direction for a check whose whole purpose is to refuse
 * retroactive justification.
 *
 * A non-uuid id is a MISS, not a crash — `writeDecision` turns null into
 * `prediction_missing`, which is the right answer for an id no prediction can
 * have. (Unreachable through `writeDecision`, whose ids are Zod-validated
 * uuids; reachable through a hand-built record.)
 */
export async function predictionFactsFor(
  id: string,
  ex: Executor = db(),
): Promise<PredictionFacts | null> {
  if (!isUuid(id)) return null;

  return guard('predictionFacts', async () => {
    const row = await ex.maybeOne(sql`
      select created_at,
             (outcome is not null or resolved_at is not null) as resolved
        from prediction
       where id = ${id}::uuid`);
    if (row === null) return null;

    return {
      exists: true,
      resolved: asBoolean(row.resolved, `prediction[${id}].resolved`),
      recordedAt: asIso(row.created_at, `prediction[${id}].created_at`),
    };
  });
}

/**
 * The port, bound to an executor.
 *
 * `executor` is resolved PER CALL, not captured at construction: a store built
 * at module scope and used inside a `withTx` must enlist in that transaction,
 * and `db()` only knows which one is running while it is running. Written as
 * `createPostgresDecisionStore(ex = db())` the default would bind the pool once,
 * forever, and every write through this store would silently escape the
 * caller's transaction.
 */
export function createPostgresDecisionStore(executor?: Executor): DecisionStore {
  const ex = (): Executor => executor ?? db();

  return {
    put: (record) => putDecision(record, ex()),
    get: (id) => decisionById(id, ex()),
    all: () => allDecisions(ex()),
  };
}

/**
 * `WriteDeps`, ready for `writeDecision`. `now` comes from the CALLER — this
 * package never reads the clock, which is also why `decided_at` is written from
 * the record and the column's `default now()` is never used.
 */
export function createPostgresWriteDeps(now: string, executor?: Executor): WriteDeps {
  const ex = (): Executor => executor ?? db();

  return {
    store: createPostgresDecisionStore(executor),
    predictionFacts: (id) => predictionFactsFor(id, ex()),
    now,
  };
}
