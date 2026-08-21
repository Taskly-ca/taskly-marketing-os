/**
 * `PlaybookRunStore` (packages/decide/src/playbook/ledger.ts) on `playbook_run`,
 * plus the repository functions for `playbook` — the one table in the decide
 * lane that has no port at all.
 *
 * THE LEDGER'S RULE IS NARROWER AND STRONGER THAN `NOT NULL`. 003 wrote
 * `prediction jsonb not null`; 012 dropped that and added
 * `check (outcome is null or prediction is not null)`, because `LedgerRun`
 * says the prediction is null "only for rows that came from elsewhere". An
 * IMPORTED run may lack a prediction; a run WITH AN OUTCOME may not. That
 * ordering — prediction first, outcome second — is the whole integrity
 * mechanism of the ledger, and NOT NULL only enforced it by accident. The
 * adapter surfaces its violation as the ledger's own `prediction_missing`,
 * worded exactly as `recordRunOutcome` words it.
 *
 * 012 ALSO ADDED THE THREE COLUMNS THE LEDGER HAD NOWHERE TO PUT:
 * `falsifier` (the hypothesis frozen at start — without a column the copy was
 * made and thrown away, and the run would be judged against whatever the
 * playbook says at read time), `supersedes` and `correction_reason`, guarded by
 * `check (supersedes is null or correction_reason is not null)` — the database
 * refusing what `correctRun` already refuses.
 *
 * `LedgerRun` IS snake_case IN TYPESCRIPT (`run_id`, `playbook_id`,
 * `situation_snapshot`), unlike every other domain type in this repo. It is left
 * that way. The mapping below is therefore 1:1 on names, which is the one thing
 * that makes this adapter boring, and boring is the goal.
 *
 * `ex: Executor = db()` is the LAST parameter of every function; the factory
 * resolves its executor PER CALL, never in a default argument. See
 * `createPostgresFactStore` for why that distinction is load-bearing.
 */
import { db, sql, type Executor, type QueryRow } from '@tmos/db';
import { playbookSchema, type Playbook } from '@tmos/contracts';
import type {
  LedgerRun,
  PlaybookRunStore,
  RunClassification,
  RunFalsifier,
  RunOutcome,
  RunPrediction,
  RunRejection,
  RunVerdict,
} from '@tmos/decide';

import {
  AdapterError,
  AppendOnlyError,
  DecodeError,
  guard,
  isPgError,
  translatePgError,
} from '../errors.js';
import {
  asBoolean,
  asIso,
  asJsonObject,
  asNumber,
  asNumberOrNull,
  asStringArray,
  asText,
  asTextOrNull,
  asUnion,
  isUuid,
} from './values.js';

/**
 * A write the DATABASE refused for a reason the LEDGER already has a word for.
 * See `DecisionRejectedError` in `decision-store.ts` for the argument; the two
 * are separate classes rather than one generic because the value a caller
 * actually switches on — `RunRejectCode` vs `RejectCode` — is different, and a
 * shared class would hand back a union of two vocabularies.
 */
export class RunRejectedError extends AdapterError {
  readonly rejection: RunRejection;

  constructor(rejection: RunRejection, options?: ErrorOptions) {
    super(`${rejection.code}: ${rejection.detail}`, options);
    this.rejection = rejection;
  }
}

/**
 * CHECK constraint → the rejection the ledger would have produced, worded
 * verbatim from `recordRunOutcome` and `correctRun` so one assertion covers
 * both the domain path and the database path.
 *
 * The FOREIGN KEY on `(playbook_id, playbook_version)` is deliberately NOT
 * mapped: the ledger has no code for "that playbook version does not exist" —
 * `startRun` receives a whole `Playbook` object and never doubts it — so it
 * stays a `MissingReferenceError`, which is what `errors.ts` exists to say.
 */
function checkRejection(error: unknown, runId: string): RunRejectedError | null {
  if (!isPgError(error) || error.code !== '23514') return null;

  switch (error.constraint) {
    case 'playbook_run_outcome_needs_prediction':
      return new RunRejectedError(
        {
          code: 'prediction_missing',
          detail:
            `run ${runId} recorded no prediction — nothing to score against. ` +
            'A prediction is written BEFORE an outcome, or there is no run (migration 012).',
        },
        { cause: error },
      );
    case 'playbook_run_correction_needs_reason':
      return new RunRejectedError(
        {
          code: 'correction_needs_reason',
          detail: `a correction without a reason is a rewrite (run ${runId} supersedes another)`,
        },
        { cause: error },
      );
    default:
      return null;
  }
}

/* ── decoding the jsonb documents ─────────────────────────────────────────── */

const CLASSIFICATIONS: readonly RunClassification[] = [
  'win',
  'loss',
  'underpowered',
  'inconclusive',
  'aborted',
];
const VERDICTS: readonly RunVerdict[] = ['win', 'loss', 'inconclusive', 'aborted'];
const DIRECTIONS = ['up', 'down'] as const;
const LESSON_KINDS = ['do', 'dont', 'precondition'] as const;

/** `[number, number]` — `expected_effect` and `ci80` are tuples, not arrays. */
function asNumberPair(value: unknown, column: string): [number, number] {
  if (Array.isArray(value) && value.length === 2) {
    return [asNumber(value[0], `${column}[0]`), asNumber(value[1], `${column}[1]`)];
  }
  throw new DecodeError(`${column}: expected a pair of numbers, got ${JSON.stringify(value)}`);
}

/**
 * A nullable jsonb column. `present` is `<column> is not null` selected
 * alongside it, because SQL NULL and the jsonb document `null` are
 * indistinguishable once node-postgres has parsed them — the same reason `fact`
 * selects `has_json`. Here it matters more than usual: "this run has no
 * prediction" is a legitimate state the CHECK constraint reasons about, and
 * confusing it with "this run's prediction is the JSON value null" would make
 * the constraint and the adapter disagree about the same row.
 */
function jsonbOrNull<T>(
  raw: unknown,
  present: unknown,
  column: string,
  decode: (value: unknown, column: string) => T,
): T | null {
  if (!asBoolean(present, `${column} is not null`)) return null;
  if (raw === null) {
    throw new DecodeError(
      `${column}: the column holds the jsonb document \`null\`, which the CHECK ` +
        'constraints read as PRESENT and this decoder cannot use. Write SQL NULL.',
    );
  }
  return decode(raw, column);
}

function asRunPrediction(value: unknown, column: string): RunPrediction {
  const o = asJsonObject(value, column);
  return {
    metric: asText(o.metric, `${column}.metric`),
    point: asNumber(o.point, `${column}.point`),
    ci80: asNumberPair(o.ci80, `${column}.ci80`),
    recorded_at: asIso(o.recorded_at, `${column}.recorded_at`),
  };
}

function asRunFalsifier(value: unknown, column: string): RunFalsifier {
  const o = asJsonObject(value, column);
  return {
    metric: asText(o.metric, `${column}.metric`),
    direction: asUnion(o.direction, DIRECTIONS, `${column}.direction`),
    expected_effect: asNumberPair(o.expected_effect, `${column}.expected_effect`),
    horizon_days: asNumber(o.horizon_days, `${column}.horizon_days`),
    min_n: asNumber(o.min_n, `${column}.min_n`),
    due_at: asIso(o.due_at, `${column}.due_at`),
  };
}

/**
 * NOTE THE SHAPE STORED HERE. `playbook_run.outcome` holds the ledger's
 * `RunOutcome`, which is a SUPERSET of `playbookRunSchema.outcome`: it also
 * carries `classification` (`underpowered` has no seat in the contract enum),
 * `n`, and `forced`. `toPlaybookRun` is the projection down to the contract, and
 * it is a one-way trip — reading this column through `playbookRunSchema` would
 * silently drop the three fields that say whether the result was powered and
 * whether someone peeked.
 */
function asRunOutcome(value: unknown, column: string): RunOutcome {
  const o = asJsonObject(value, column);
  const forced = o.forced;

  return {
    metric_actual: asNumberOrNull(o.metric_actual, `${column}.metric_actual`),
    n: asNumber(o.n, `${column}.n`),
    classification: asUnion(o.classification, CLASSIFICATIONS, `${column}.classification`),
    verdict: asUnion(o.verdict, VERDICTS, `${column}.verdict`),
    measured_at: asIso(o.measured_at, `${column}.measured_at`),
    confounds: asStringArray(o.confounds, `${column}.confounds`),
    forced:
      forced === null || forced === undefined
        ? null
        : {
            reason: asText(asJsonObject(forced, `${column}.forced`).reason, `${column}.forced.reason`),
            days_early: asNumber(
              asJsonObject(forced, `${column}.forced`).days_early,
              `${column}.forced.days_early`,
            ),
          },
  };
}

function asLessons(value: unknown, column: string): LedgerRun['lessons'] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DecodeError(`${column}: expected a jsonb array, got ${JSON.stringify(value)}`);
  }
  return value.map((entry, i) => {
    const o = asJsonObject(entry, `${column}[${i}]`);
    return {
      kind: asUnion(o.kind, LESSON_KINDS, `${column}[${i}].kind`),
      text: asText(o.text, `${column}[${i}].text`),
    };
  });
}

/* ── playbook_run ─────────────────────────────────────────────────────────── */

const RUN_COLUMNS = sql`
  run_id::text as run_id,
  playbook_id,
  playbook_version,
  situation_snapshot,
  params_bound,
  prediction,
  prediction is not null as has_prediction,
  falsifier,
  falsifier is not null as has_falsifier,
  started_at,
  outcome,
  outcome is not null as has_outcome,
  lessons,
  supersedes::text as supersedes,
  correction_reason`;

/**
 * `createMemoryRunStore` sorts by `started_at` then `run_id`, both as strings.
 * This is the same ordering with one caveat worth naming: Postgres compares
 * `started_at` as an INSTANT and the memory store compares it as TEXT, so two
 * ISO-8601 strings written in different offsets ('…T00:00:00Z' and
 * '…T02:00:00+02:00') are equal here and unequal there. Everything this system
 * writes is `new Date().toISOString()`, which is always UTC `Z`.
 */
const RUN_ORDER = sql`order by started_at, run_id`;

export function rowToLedgerRun(row: QueryRow): LedgerRun {
  const runId = asText(row.run_id, 'playbook_run.run_id');
  const at = (column: string): string => `playbook_run[${runId}].${column}`;

  return {
    run_id: runId,
    playbook_id: asText(row.playbook_id, at('playbook_id')),
    playbook_version: asNumber(row.playbook_version, at('playbook_version')),
    situation_snapshot: asJsonObject(row.situation_snapshot, at('situation_snapshot')),
    params_bound: asJsonObject(row.params_bound, at('params_bound')),
    prediction: jsonbOrNull(row.prediction, row.has_prediction, at('prediction'), asRunPrediction),
    falsifier: jsonbOrNull(row.falsifier, row.has_falsifier, at('falsifier'), asRunFalsifier),
    started_at: asIso(row.started_at, at('started_at')),
    outcome: jsonbOrNull(row.outcome, row.has_outcome, at('outcome'), asRunOutcome),
    lessons: asLessons(row.lessons, at('lessons')),
    supersedes: asTextOrNull(row.supersedes, at('supersedes')),
    correction_reason: asTextOrNull(row.correction_reason, at('correction_reason')),
  };
}

/**
 * Upsert, because `recordRunOutcome` writes the whole run back with an outcome
 * attached and the port is "a dumb row sink, exactly as the SQL table is".
 * Append-only-ness of the LEDGER is enforced above this: `recordRunOutcome`
 * refuses a second outcome and `correctRun` writes a NEW row that points at the
 * old one. Nothing here can tell the difference, and nothing here should.
 */
export async function putPlaybookRun(run: LedgerRun, ex: Executor = db()): Promise<void> {
  const json = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

  try {
    await ex.execute(sql`
      insert into playbook_run (
        run_id, playbook_id, playbook_version, situation_snapshot, params_bound,
        prediction, falsifier, started_at, outcome, lessons, supersedes, correction_reason
      ) values (
        ${run.run_id}::uuid, ${run.playbook_id}, ${run.playbook_version},
        ${JSON.stringify(run.situation_snapshot)}::jsonb,
        ${JSON.stringify(run.params_bound)}::jsonb,
        ${json(run.prediction)}::jsonb,
        ${json(run.falsifier)}::jsonb,
        ${run.started_at}::timestamptz,
        ${json(run.outcome)}::jsonb,
        ${JSON.stringify(run.lessons)}::jsonb,
        ${run.supersedes}::uuid,
        ${run.correction_reason}
      )
      on conflict (run_id) do update set
        playbook_id        = excluded.playbook_id,
        playbook_version   = excluded.playbook_version,
        situation_snapshot = excluded.situation_snapshot,
        params_bound       = excluded.params_bound,
        prediction         = excluded.prediction,
        falsifier          = excluded.falsifier,
        started_at         = excluded.started_at,
        outcome            = excluded.outcome,
        lessons            = excluded.lessons,
        supersedes         = excluded.supersedes,
        correction_reason  = excluded.correction_reason`);
  } catch (error) {
    throw checkRejection(error, run.run_id) ?? translatePgError(error, 'put');
  }
}

/**
 * A malformed run id is "not found", never an error — `run_id` is a uuid, and
 * handing Postgres the memory store's `run_1` would raise 22P02 and turn a miss
 * into a crash, which is exactly the class of difference that makes two
 * implementations of a port non-substitutable.
 */
export async function playbookRunById(
  runId: string,
  ex: Executor = db(),
): Promise<LedgerRun | null> {
  if (!isUuid(runId)) return null;

  return guard('get', async () => {
    const row = await ex.maybeOne(
      sql`select ${RUN_COLUMNS} from playbook_run where run_id = ${runId}::uuid`,
    );
    return row === null ? null : rowToLedgerRun(row);
  });
}

/** Every version's runs, not one version's — `runsFor` filters by version. */
export async function playbookRunsByPlaybook(
  playbookId: string,
  ex: Executor = db(),
): Promise<LedgerRun[]> {
  return guard('byPlaybook', async () => {
    const rows = await ex.query(
      sql`select ${RUN_COLUMNS} from playbook_run where playbook_id = ${playbookId} ${RUN_ORDER}`,
    );
    return rows.map(rowToLedgerRun);
  });
}

export async function allPlaybookRuns(ex: Executor = db()): Promise<LedgerRun[]> {
  return guard('all', async () => {
    const rows = await ex.query(sql`select ${RUN_COLUMNS} from playbook_run ${RUN_ORDER}`);
    return rows.map(rowToLedgerRun);
  });
}

/** See `createPostgresFactStore` — `executor` is resolved per call, never captured. */
export function createPostgresPlaybookRunStore(executor?: Executor): PlaybookRunStore {
  const ex = (): Executor => executor ?? db();

  return {
    put: (run) => putPlaybookRun(run, ex()),
    get: (runId) => playbookRunById(runId, ex()),
    byPlaybook: (playbookId) => playbookRunsByPlaybook(playbookId, ex()),
    all: () => allPlaybookRuns(ex()),
  };
}

/* ── playbook — a table with no port ──────────────────────────────────────── */

/**
 * `playbook` has no `*Store` interface anywhere in `packages/decide`: selection
 * (`select.ts`), binding (`bind.ts`) and graduation (`graduate.ts`) all take
 * `Playbook` objects that someone else has already loaded. These three
 * functions are that someone. No port is invented for them here — adding one
 * would be a change to `packages/decide`, which is another lane.
 *
 * The table is APPEND-ONLY by primary key: `(id, version)`, "a shipped version
 * never mutates". There is deliberately no upsert below.
 */
const PLAYBOOK_COLUMNS = sql`
  id,
  version,
  title,
  intent,
  status,
  applies_when,
  excludes_when,
  params,
  steps,
  hypothesis,
  kill_criteria,
  assumptions,
  decay_after_days`;

/**
 * Row → `Playbook`, with the contract as the last gate. `created_at` is not a
 * contract field and is dropped; every other column maps 1:1 by name.
 */
export function rowToPlaybook(row: QueryRow): Playbook {
  const id = asText(row.id, 'playbook.id');
  const version = asNumber(row.version, `playbook[${id}].version`);

  const candidate = {
    id,
    version,
    title: row.title,
    intent: row.intent,
    status: row.status,
    applies_when: row.applies_when,
    excludes_when: row.excludes_when,
    params: row.params,
    steps: row.steps,
    hypothesis: row.hypothesis,
    kill_criteria: row.kill_criteria,
    assumptions: asStringArray(row.assumptions, `playbook[${id}].assumptions`),
    decay_after_days: row.decay_after_days,
  };

  const parsed = playbookSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new DecodeError(
      `playbook[${id}@${version}]: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * Append a version. Never an update: a shipped version is evidence, and
 * `graduate.ts` scores each version's runs separately precisely because "v3's
 * record says nothing about v4". Re-inserting `(id, version)` is therefore an
 * `AppendOnlyError` — the same class 009 produces for rewriting history in
 * `fact` — rather than a bare unique violation, because the fix is always the
 * same: bump the version.
 */
export async function insertPlaybookVersion(
  playbook: Playbook,
  ex: Executor = db(),
): Promise<Playbook> {
  try {
    return rowToPlaybook(
      await ex.one(sql`
        insert into playbook (
          id, version, title, intent, status,
          applies_when, excludes_when, params, steps, hypothesis, kill_criteria,
          assumptions, decay_after_days
        ) values (
          ${playbook.id}, ${playbook.version}, ${playbook.title}, ${playbook.intent},
          ${playbook.status},
          ${JSON.stringify(playbook.applies_when)}::jsonb,
          ${JSON.stringify(playbook.excludes_when)}::jsonb,
          ${JSON.stringify(playbook.params)}::jsonb,
          ${JSON.stringify(playbook.steps)}::jsonb,
          ${JSON.stringify(playbook.hypothesis)}::jsonb,
          ${JSON.stringify(playbook.kill_criteria)}::jsonb,
          ${playbook.assumptions}::text[],
          ${playbook.decay_after_days}
        )
        returning ${PLAYBOOK_COLUMNS}`),
    );
  } catch (error) {
    if (isPgError(error) && error.code === '23505') {
      throw new AppendOnlyError(
        `insertVersion: ${playbook.id} v${playbook.version} already exists — a shipped ` +
          'version never mutates. Publish the change as a new version; the run ledger ' +
          'scores each version separately, and rewriting v3 would silently re-target ' +
          "every run that was judged against v3's hypothesis.",
        { cause: error },
      );
    }
    throw translatePgError(error, 'insertVersion');
  }
}

/**
 * The version in force: the highest one. `status` is NOT filtered — a `retired`
 * playbook is still the current version of itself, and `selectPlaybooks`
 * reports `retired` as a verdict with a reason rather than silently seeing
 * nothing. Hiding it here would turn "this playbook was retired" into "this
 * playbook does not exist".
 */
export async function currentPlaybook(id: string, ex: Executor = db()): Promise<Playbook | null> {
  return guard('current', async () => {
    const row = await ex.maybeOne(sql`
      select ${PLAYBOOK_COLUMNS} from playbook
       where id = ${id}
       order by version desc
       limit 1`);
    return row === null ? null : rowToPlaybook(row);
  });
}

/** Every version of one playbook, oldest first. The history, not the current. */
export async function playbookVersions(id: string, ex: Executor = db()): Promise<Playbook[]> {
  return guard('versions', async () => {
    const rows = await ex.query(
      sql`select ${PLAYBOOK_COLUMNS} from playbook where id = ${id} order by version`,
    );
    return rows.map(rowToPlaybook);
  });
}
