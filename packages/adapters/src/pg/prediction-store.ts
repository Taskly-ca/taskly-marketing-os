/**
 * `PredictionStore` (packages/intel/src/prediction/store.ts) on Postgres
 * `prediction` — migration 003, extended by 012.
 *
 * The behavioural specification is `createMemoryStore`, not this file. Where the
 * two can agree they are made to; where they CANNOT, the difference is named
 * here and in the README, because a divergence nobody wrote down is a
 * divergence someone finds in production.
 *
 * THE ONE THAT WOULD HAVE BEEN SILENT. `prediction.outcome` is `text` holding
 * '0' | '1' | 'annulled'; `PredictionRecord.outcome` is `0 | 1 | 'annulled' |
 * null` — NUMERIC zero and one. `'0'` is truthy in JavaScript and `'0' == 0` is
 * true, so an adapter that handed the column straight back would turn every
 * prediction that resolved FALSE into one that looks resolved TRUE the moment
 * anything asks `if (row.outcome)`, and every Brier score computed from the
 * ledger would be wrong in a way no TypeScript-side test would notice — the
 * type says `0 | 1` and the value is a string that passes every loose check.
 * Migration 012 wrote the mapping down rather than leave it to be guessed at;
 * `outcomeToColumn` / `outcomeFromColumn` below are that comment, executable,
 * and `prediction-store.test.ts` round-trips all four states through them.
 *
 * The house rules from `fact-store.ts` hold here too:
 *
 *   `ex: Executor = db()` IS THE LAST PARAMETER of every function, so each one
 *   works standalone against the pool and enlists in a caller's `withTx` with
 *   no plumbing.
 *
 *   ONE METHOD, ONE STATEMENT — except on the failure path. `insert` conflicts
 *   with `on conflict (id) do nothing` and `resolve` guards `outcome is null`
 *   in the WHERE clause, so a duplicate or an already-resolved row comes back
 *   as zero rows instead of raising. Only then does a second read work out
 *   which it was. `withTx` has no savepoints: an exception aborts the whole
 *   transaction, and the diagnosis would fail with "current transaction is
 *   aborted" — the caller would lose both the reason and the rest of the batch.
 *
 *   THE ADAPTER NEVER READS THE CLOCK. `due(now)` and `resolve({resolvedAt})`
 *   take their instants from the caller; `created_at`'s `default now()` is
 *   never used, because `now()` is frozen for a whole transaction.
 */
import { resolverSchema } from '@tmos/contracts';
import { db, sql, type Executor, type SqlQuery } from '@tmos/db';
import type { PredictionRecord, PredictionStore, ResolverSpec, Scores } from '@tmos/intel';

import { ConstraintError, DecodeError, NotFoundError, guard } from '../errors.js';
import {
  asIso,
  asIsoOrNull,
  asJsonObject,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
  isUuid,
} from './values.js';

/**
 * The projection, nested into every read so the decoder only ever meets one
 * shape. `id` is cast `::text` (a `PredictionRecord.id` is a string, and
 * casting in the query means the result cannot depend on a driver type parser);
 * `belief_ids` is cast `::text[]` because `text[]` is a type node-postgres
 * parses everywhere and `uuid[]` is not guaranteed to be.
 */
const PREDICTION_COLUMNS = sql`
  id::text as id,
  claim,
  p,
  author,
  created_at,
  resolve_at,
  resolver,
  evidence_snapshot_hash,
  decision_id,
  belief_ids::text[] as belief_ids,
  outcome,
  observed,
  resolved_at,
  annul_reason`;

/**
 * The port says nothing about order and the memory store returns `Map`
 * insertion order. `prediction` has no insertion counter and a random-uuid
 * primary key, so the closest honest ordering is when the forecast was made,
 * with the id as a deterministic tiebreak for rows written in one transaction
 * (where `now()` is frozen, so ties are the normal case, not a rare one).
 */
const PREDICTION_ORDER = sql`order by created_at, id`;

/* ── the outcome mapping, in both directions ────────────────────────────── */

/** Column text for a `PredictionRecord.outcome`. 012: 0 → '0', 1 → '1'. */
export function outcomeToColumn(outcome: PredictionRecord['outcome']): string | null {
  if (outcome === null) return null;
  return outcome === 'annulled' ? 'annulled' : String(outcome);
}

/**
 * The inverse. 012's comment says `Number(v)`; this is deliberately narrower —
 * only the three strings the CHECK constraint permits decode, and anything else
 * is a `DecodeError` naming the value rather than a silent `NaN` propagating
 * into a Brier score. The mapping is identical on the constrained domain.
 */
export function outcomeFromColumn(value: unknown, column = 'outcome'): PredictionRecord['outcome'] {
  if (value === null || value === undefined) return null;
  const text = asText(value, column);
  if (text === 'annulled') return 'annulled';
  if (text === '0') return 0;
  if (text === '1') return 1;
  throw new DecodeError(`${column}: ${text} is not one of 0 | 1 | annulled`);
}

/**
 * `observed` is `unknown`, so it is serialized rather than mapped. `undefined`
 * — which `resolve({observed: undefined})` can produce — has no JSON encoding
 * and becomes SQL NULL, and reads back as `null`. The memory store keeps the
 * `undefined`. Both are "nothing was observed"; only `===` can tell them apart.
 */
function observedToColumn(observed: unknown): string | null {
  if (observed === undefined) return null;
  const json: string | undefined = JSON.stringify(observed);
  return json ?? null;
}

/**
 * `resolver` is validated on the way OUT, not cast. It is the only column whose
 * shape the calibration loop executes rather than reads, and `DecodeError`
 * exists for exactly this: "the row that came back is not a PredictionRecord".
 * A spec written by another tool that `resolverSchema` rejects makes the row
 * unreadable, which is louder — and cheaper — than a resolver that runs against
 * a `source_url` that is not a URL.
 */
function resolverFromColumn(value: unknown): ResolverSpec {
  const parsed = resolverSchema.safeParse(asJsonObject(value, 'resolver'));
  if (parsed.success) return parsed.data;
  throw new DecodeError(
    `resolver: not a ResolverSpec — ${parsed.error.issues[0]?.message ?? 'schema rejected it'}`,
  );
}

export function rowToPrediction(row: Record<string, unknown>): PredictionRecord {
  return {
    id: asText(row.id, 'id'),
    claim: asText(row.claim, 'claim'),
    p: asNumber(row.p, 'p'),
    author: asText(row.author, 'author'),
    created_at: asIso(row.created_at, 'created_at'),
    resolve_at: asIso(row.resolve_at, 'resolve_at'),
    resolver: resolverFromColumn(row.resolver),
    evidence_snapshot_hash: asText(row.evidence_snapshot_hash, 'evidence_snapshot_hash'),
    decision_id: asTextOrNull(row.decision_id, 'decision_id'),
    belief_ids: asStringArray(row.belief_ids, 'belief_ids'),
    outcome: outcomeFromColumn(row.outcome),
    observed: row.observed ?? null,
    resolved_at: asIsoOrNull(row.resolved_at, 'resolved_at'),
    annul_reason: asTextOrNull(row.annul_reason, 'annul_reason'),
  };
}

/* ── the port ───────────────────────────────────────────────────────────── */

/**
 * A non-uuid id is refused BEFORE the statement, not after. The memory store
 * mints and accepts arbitrary strings; `prediction.id` is a uuid, so Postgres
 * would raise 22P02 — and a raised error aborts the caller's whole transaction,
 * which is a far worse way to learn that an id was malformed.
 */
export async function insertPrediction(row: PredictionRecord, ex: Executor = db()): Promise<void> {
  if (!isUuid(row.id)) {
    throw new ConstraintError(
      `insert: ${row.id} is not a uuid — prediction.id is uuid, while the in-memory store ` +
        'takes any string as an id. Mint ids with randomUUID(), as writePrediction() does.',
    );
  }

  const inserted = await guard('insert', () =>
    ex.execute(sql`
      insert into prediction (
        id, decision_id, belief_ids, claim, p, author, created_at, resolve_at,
        resolver, evidence_snapshot_hash, outcome, observed, resolved_at, annul_reason
      ) values (
        ${row.id}::uuid, ${row.decision_id}, ${row.belief_ids}::uuid[], ${row.claim}, ${row.p},
        ${row.author}, ${row.created_at}::timestamptz, ${row.resolve_at}::timestamptz,
        ${JSON.stringify(row.resolver)}::jsonb, ${row.evidence_snapshot_hash},
        ${outcomeToColumn(row.outcome)}, ${observedToColumn(row.observed)}::jsonb,
        ${row.resolved_at}::timestamptz, ${row.annul_reason}
      )
      on conflict (id) do nothing`),
  );

  // Copied verbatim from the memory store, so one assertion covers both.
  if (inserted === 0) throw new ConstraintError(`duplicate prediction id: ${row.id}`);
}

/**
 * The due query, exposed as a fragment so the live suite can `explain` THIS
 * statement rather than a hand-copied lookalike.
 *
 * `outcome is null` is written literally, and `resolve_at` is compared bare —
 * no `coalesce`, no function around the column. `prediction_due_idx on
 * prediction (resolve_at) where outcome is null` (003) is a PARTIAL index, and
 * the planner only considers it when the query's WHERE clause implies the index
 * predicate in that form. Wrapping either side is what makes an index that
 * exists for exactly one query stop being used by it.
 */
export function duePredictionsQuery(now: Date): SqlQuery {
  return sql`
    select ${PREDICTION_COLUMNS} from prediction
     where outcome is null and resolve_at <= ${now.toISOString()}::timestamptz
     order by resolve_at, id`;
}

export async function duePredictions(now: Date, ex: Executor = db()): Promise<PredictionRecord[]> {
  const rows = await guard('due', () => ex.query(duePredictionsQuery(now)));
  return rows.map(rowToPrediction);
}

/**
 * IDEMPOTENT, like the memory store: resolving an already-resolved prediction
 * is a no-op, never an overwrite. A calibration ledger that lets a second
 * resolution replace the first is not a ledger.
 *
 * The precondition is `outcome is null` IN THE WHERE CLAUSE, so the no-op costs
 * zero rows rather than an exception. Zero rows is ambiguous — unknown id, or
 * already resolved — so a second read says which, and only then does anything
 * throw.
 */
export async function resolvePrediction(
  id: string,
  r: { outcome: 0 | 1 | 'annulled'; observed: unknown; resolvedAt: string; annulReason?: string },
  ex: Executor = db(),
): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError(`unknown prediction: ${id}`);

  const changed = await guard('resolve', () =>
    ex.execute(sql`
      update prediction
         set outcome = ${outcomeToColumn(r.outcome)},
             observed = ${observedToColumn(r.observed)}::jsonb,
             resolved_at = ${r.resolvedAt}::timestamptz,
             annul_reason = ${r.annulReason ?? null}
       where id = ${id}::uuid and outcome is null`),
  );
  if (changed === 1) return;

  const row = await guard('resolve', () =>
    ex.maybeOne(sql`select outcome from prediction where id = ${id}::uuid`),
  );
  // Verbatim from the memory store.
  if (row === null) throw new NotFoundError(`unknown prediction: ${id}`);
  // Already resolved. The memory store returns silently; so does this.
}

export async function allPredictions(ex: Executor = db()): Promise<PredictionRecord[]> {
  const rows = await guard('all', () =>
    ex.query(sql`select ${PREDICTION_COLUMNS} from prediction ${PREDICTION_ORDER}`),
  );
  return rows.map(rowToPrediction);
}

/**
 * The port, bound to an executor.
 *
 * `executor` is resolved PER CALL, never in a default argument:
 * `createPostgresPredictionStore(ex = db())` would bind the pool once at
 * construction, and every write through a module-scope store would silently
 * escape the caller's transaction.
 */
export function createPostgresPredictionStore(executor?: Executor): PredictionStore {
  const ex = (): Executor => executor ?? db();

  return {
    insert: (p) => insertPrediction(p, ex()),
    due: (now) => duePredictions(now, ex()),
    resolve: (id, r) => resolvePrediction(id, r, ex()),
    all: () => allPredictions(ex()),
  };
}

/* ── scores: the write path the port does not have ──────────────────────── */

/**
 * `brier` / `log_score` / `baseline` / `peer` are columns nothing writes.
 * `packages/intel/src/calibration/scoring.ts` computes them purely from rows it
 * has already read, and `PredictionStore` has no method to persist them — 012
 * calls that "a missing write path, not a schema defect".
 *
 * These three functions are that path. They are repository functions and NOT
 * new port methods on purpose: `packages/intel` is outside this lane, and a
 * port method would have to be added to the in-memory store in the same change.
 * The consequence is that the calibration loop must call them directly rather
 * than through `PredictionStore` — which is honest, because the memory store
 * cannot store a score at all.
 *
 * `Scores` is taken verbatim from `@tmos/intel` so `score(f)` lands here with
 * no mapping in between. Only the column name differs: `Scores.log` is
 * `log_score` on disk (`log` is a Postgres function name).
 */
const SCORE_COLUMNS = sql`brier, log_score, baseline, peer`;

/**
 * Persists the four scores for ONE resolved prediction.
 *
 * `outcome in ('0','1')` is a precondition in the WHERE clause, because a score
 * belongs to a prediction that RESOLVED. An annulled question "carries no score
 * and no penalty" (resolver/types.ts) and an unresolved one has no outcome to
 * score against; storing a number for either is how an annulled question
 * quietly re-enters an aggregate. No CHECK constraint says so — `check (brier
 * is null or outcome in ('0','1'))` would be the schema-level version of this
 * guard, and belongs in a migration, which is a serial change.
 */
export async function writePredictionScores(
  id: string,
  scores: Scores,
  ex: Executor = db(),
): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError(`unknown prediction: ${id}`);
  finite('brier', scores.brier);
  finite('log', scores.log);
  finite('baseline', scores.baseline);
  if (scores.peer !== null) finite('peer', scores.peer);

  const changed = await guard('writeScores', () =>
    ex.execute(sql`
      update prediction
         set brier = ${scores.brier}, log_score = ${scores.log},
             baseline = ${scores.baseline}, peer = ${scores.peer}
       where id = ${id}::uuid and outcome in ('0','1')`),
  );
  if (changed === 1) return;

  const row = await guard('writeScores', () =>
    ex.maybeOne(sql`select outcome from prediction where id = ${id}::uuid`),
  );
  if (row === null) throw new NotFoundError(`unknown prediction: ${id}`);

  const outcome = outcomeFromColumn(row.outcome);
  throw new ConstraintError(
    outcome === 'annulled'
      ? `writeScores: ${id} was annulled, and an annulled prediction carries no score`
      : `writeScores: ${id} is unresolved, so there is no outcome to score against`,
  );
}

/** The scores as stored. `null` when the row is absent or has never been scored. */
export async function predictionScores(id: string, ex: Executor = db()): Promise<Scores | null> {
  if (!isUuid(id)) return null;

  const row = await guard('scores', () =>
    ex.maybeOne(sql`select ${SCORE_COLUMNS} from prediction where id = ${id}::uuid`),
  );
  if (row === null || row.brier === null || row.brier === undefined) return null;

  return {
    brier: asNumber(row.brier, 'brier'),
    log: asNumber(row.log_score, 'log_score'),
    baseline: asNumber(row.baseline, 'baseline'),
    peer: asNumberOrNull(row.peer, 'peer'),
  };
}

/**
 * The loop's input: resolved, and not yet scored. `annulled` is excluded by the
 * same rule `writePredictionScores` enforces, so a run over this list can never
 * put a score on a question that was withdrawn.
 */
export async function unscoredPredictions(ex: Executor = db()): Promise<PredictionRecord[]> {
  const rows = await guard('unscored', () =>
    ex.query(sql`
      select ${PREDICTION_COLUMNS} from prediction
       where outcome in ('0','1') and brier is null ${PREDICTION_ORDER}`),
  );
  return rows.map(rowToPrediction);
}

/**
 * `numeric` has no infinity. `Infinity` reaches the driver as the literal
 * `Infinity` and fails at the server with a syntax error that names neither the
 * column nor the caller — and an exception there aborts the whole transaction.
 * A log score is only infinite when a forecast was 0 or 1, which `clampP`
 * exists to prevent, so this firing means the clamp was bypassed.
 */
function finite(field: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new ConstraintError(
      `writeScores: ${field} must be a finite number, got ${value} — an infinite log score ` +
        'means a probability of exactly 0 or 1 escaped clampP().',
    );
  }
}
