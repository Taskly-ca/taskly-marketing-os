/**
 * The run ledger: the prediction is written BEFORE the outcome, or there is no
 * run.
 *
 * That one ordering constraint is the whole integrity mechanism. A playbook
 * that records what it expected after seeing what happened is not learning, it
 * is narrating — and the narration always flatters, because the writer already
 * knows the answer. Every refusal here closes one route back to narration:
 *
 *   no prediction          → the outcome has nothing to be scored against
 *   overwriting an outcome → the ledger becomes editable history
 *   reading early          → a 30-day hypothesis called at day 3 is a peek
 *   n below min_n          → an underpowered result is not a result
 *   version drift          → v3's record says nothing about v4
 *
 * The verdict is DERIVED from the frozen hypothesis; `recordRunOutcome` takes a
 * measurement, never a judgement. The caller cannot declare a win.
 *
 * UNITS. `expected_effect` is the pre-registered band of IMPROVEMENT on
 * `metric`, and `metric_actual` is the observed signed change in the same
 * units. `direction` says which sign counts as improvement, so a `down`
 * hypothesis is satisfied by a negative change; the band is read by magnitude,
 * which makes [5,12] and [-12,-5] mean the same thing for a reduction of 5–12.
 */
import { playbookSchema } from '@tmos/contracts';
import type { Playbook, PlaybookRun } from '@tmos/contracts';

const DAY_MS = 86_400_000;
const ms = (iso: string): number => new Date(iso).getTime();
const addDays = (iso: string, d: number): string => new Date(ms(iso) + d * DAY_MS).toISOString();

/* ── shapes ───────────────────────────────────────────────────────────────── */

/** Mirrors `playbookRunSchema.prediction`. */
export interface RunPrediction {
  metric: string;
  point: number;
  ci80: [number, number];
  recorded_at: string;
}

/** The hypothesis, frozen at start — copied, not referenced, so a later edit to
 *  the playbook cannot retroactively move the bar this run was judged against.
 *  That is the commonest way a ledger quietly stops being a ledger. */
export interface RunFalsifier {
  metric: string;
  direction: 'up' | 'down';
  expected_effect: [number, number];
  horizon_days: number;
  min_n: number;
  /** started_at + horizon_days. Anything read before this is a peek. */
  due_at: string;
}

export type RunClassification = 'win' | 'loss' | 'underpowered' | 'inconclusive' | 'aborted';
export type RunVerdict = NonNullable<PlaybookRun['outcome']>['verdict'];

export interface RunOutcome {
  metric_actual: number | null;
  /** Sample size behind the measurement, against the frozen `min_n`. */
  n: number;
  classification: RunClassification;
  /** The contract's coarser enum: `underpowered` has no seat there, so it
   *  collapses to `inconclusive` and states itself in `confounds`. */
  verdict: RunVerdict;
  measured_at: string;
  confounds: string[];
  /** Non-null when the horizon had not elapsed and someone read it anyway. */
  forced: { reason: string; days_early: number } | null;
}

export interface OutcomeInput {
  metric_actual: number | null;
  n: number;
  confounds?: string[];
  lessons?: LedgerRun['lessons'];
  aborted?: { reason: string };
  /** Reading before the horizon takes a stated reason, never a boolean. */
  force?: { reason: string };
}

export interface LedgerRun {
  run_id: string;
  playbook_id: string;
  playbook_version: number;
  situation_snapshot: Record<string, unknown>;
  params_bound: Record<string, unknown>;
  /** Null only for rows that came from elsewhere. `startRun` never writes one. */
  prediction: RunPrediction | null;
  falsifier: RunFalsifier | null;
  started_at: string;
  outcome: RunOutcome | null;
  lessons: Array<{ kind: 'do' | 'dont' | 'precondition'; text: string }>;
  /** Corrections are new rows, not edits. This points at what they replace. */
  supersedes: string | null;
  correction_reason: string | null;
}

export type RunRejectCode =
  | 'schema'
  | 'prediction_not_falsifiable'
  | 'prediction_after_start'
  | 'prediction_missing'
  | 'duplicate_run'
  | 'outcome_exists'
  | 'before_horizon'
  | 'invalid_measurement'
  | 'correction_needs_reason'
  | 'not_found';

export interface RunRejection {
  code: RunRejectCode;
  detail: string;
}
export type RunResult = { ok: true; run: LedgerRun } | { ok: false; rejection: RunRejection };

const no = (code: RunRejectCode, detail: string): RunResult => ({
  ok: false,
  rejection: { code, detail },
});

/* ── the port ─────────────────────────────────────────────────────────────── */

export interface PlaybookRunStore {
  put(run: LedgerRun): Promise<void>;
  get(runId: string): Promise<LedgerRun | null>;
  byPlaybook(playbookId: string): Promise<LedgerRun[]>;
  all(): Promise<LedgerRun[]>;
}

/** Append-only is enforced by the functions below, not by the port — the store
 *  is a dumb row sink, exactly as the SQL table is. */
export function createMemoryRunStore(): PlaybookRunStore {
  const rows = new Map<string, LedgerRun>();
  const sorted = (rs: LedgerRun[]): LedgerRun[] =>
    rs.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.run_id.localeCompare(b.run_id));
  const clone = (r: LedgerRun): LedgerRun => structuredClone(r);
  return {
    async put(r) {
      rows.set(r.run_id, clone(r));
    },
    async get(id) {
      const r = rows.get(id);
      return r ? clone(r) : null;
    },
    async byPlaybook(id) {
      return sorted([...rows.values()].filter((r) => r.playbook_id === id).map(clone));
    },
    async all() {
      return sorted([...rows.values()].map(clone));
    },
  };
}

/* ── starting a run ───────────────────────────────────────────────────────── */

export interface StartRunDeps {
  store: PlaybookRunStore;
  /** Injected like the clock. Nothing here may call Math.random(). */
  runId: string;
  situation?: Record<string, unknown>;
}

/** A hypothesis is falsifiable only if it names all five: what is measured,
 *  which way it should move, by how much, by when, and over how many. Drop one
 *  and the run can be talked into a win afterwards. */
function falsifierFrom(playbook: Playbook, startedAt: string): RunFalsifier | RunRejection {
  const h = playbook.hypothesis as Partial<Playbook['hypothesis']> | undefined;
  const eff = h?.expected_effect;
  const pos = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const missing = [
    typeof h?.metric === 'string' && h.metric.length > 0 ? '' : 'metric',
    h?.direction === 'up' || h?.direction === 'down' ? '' : 'direction',
    Array.isArray(eff) && Number.isFinite(eff[0]) && Number.isFinite(eff[1])
      ? ''
      : 'expected_effect',
    pos(h?.horizon_days) ? '' : 'horizon_days',
    pos(h?.min_n) ? '' : 'min_n',
  ].filter((s) => s.length > 0);

  if (missing.length > 0) {
    return {
      code: 'prediction_not_falsifiable',
      detail: `hypothesis is missing ${missing.join(', ')} — it cannot be shown wrong`,
    };
  }
  const hyp = playbook.hypothesis;
  return {
    metric: hyp.metric,
    direction: hyp.direction,
    expected_effect: [hyp.expected_effect[0], hyp.expected_effect[1]],
    horizon_days: hyp.horizon_days,
    min_n: hyp.min_n,
    due_at: addDays(startedAt, hyp.horizon_days),
  };
}

/** What makes a prediction unscoreable against its own hypothesis. */
function predictionProblem(p: RunPrediction, f: RunFalsifier): string | null {
  const ci: readonly number[] = Array.isArray(p.ci80) ? p.ci80 : [];
  const lo = ci[0] ?? Number.NaN;
  const hi = ci[1] ?? Number.NaN;
  if (p.metric !== f.metric) return `predicts "${p.metric}", hypothesis is on "${f.metric}"`;
  if (!Number.isFinite(p.point) || !Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi)
    return 'needs a finite point and an ordered 80% interval';
  if (p.point < lo || p.point > hi) return `point ${p.point} sits outside its own interval`;
  return null;
}

/** Write the run and its prediction. The outcome slot stays empty by design. */
export async function startRun(
  playbook: Playbook,
  boundParams: Record<string, unknown>,
  prediction: RunPrediction,
  now: string,
  deps: StartRunDeps,
): Promise<RunResult> {
  const falsifier = falsifierFrom(playbook, now);
  if ('code' in falsifier) return { ok: false, rejection: falsifier };

  const problem = predictionProblem(prediction, falsifier);
  if (problem !== null) return no('prediction_not_falsifiable', problem);
  if (ms(prediction.recorded_at) > ms(now))
    return no('prediction_after_start', `recorded ${prediction.recorded_at}, after start ${now}`);

  const parsed = playbookSchema.safeParse(playbook);
  if (!parsed.success)
    return no(
      'schema',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  if (await deps.store.get(deps.runId))
    return no('duplicate_run', `run ${deps.runId} exists — a run id is claimed once`);

  const run: LedgerRun = {
    run_id: deps.runId,
    playbook_id: parsed.data.id,
    // Pinned, so a later analysis can tell whether v3's record bears on v4.
    playbook_version: parsed.data.version,
    situation_snapshot: deps.situation ?? {},
    params_bound: { ...boundParams },
    prediction: { ...prediction, ci80: [prediction.ci80[0], prediction.ci80[1]] },
    falsifier,
    started_at: now,
    outcome: null,
    lessons: [],
    supersedes: null,
    correction_reason: null,
  };
  await deps.store.put(run);
  return { ok: true, run };
}

/* ── recording the outcome ────────────────────────────────────────────────── */

const VERDICT_OF: Record<RunClassification, RunVerdict> = {
  win: 'win',
  loss: 'loss',
  underpowered: 'inconclusive',
  inconclusive: 'inconclusive',
  aborted: 'aborted',
};

function classify(
  f: RunFalsifier,
  input: OutcomeInput,
): Pick<RunOutcome, 'classification' | 'confounds'> {
  const note = (classification: RunClassification, extra?: string) => ({
    classification,
    confounds: [...(input.confounds ?? []), ...(extra === undefined ? [] : [extra])],
  });
  if (input.aborted) return note('aborted', `aborted: ${input.aborted.reason}`);
  // Underpowered is RECORDED, not refused: that the run could not be powered is
  // itself evidence, and refusing the write would delete it. Downstream scoring
  // counts it as neither a win nor a loss.
  if (input.n < f.min_n)
    return note('underpowered', `underpowered: n=${input.n} < min_n=${f.min_n}`);
  if (input.metric_actual === null || !Number.isFinite(input.metric_actual))
    return note('inconclusive');

  const improvement = (f.direction === 'up' ? 1 : -1) * input.metric_actual;
  const floor = Math.min(Math.abs(f.expected_effect[0]), Math.abs(f.expected_effect[1]));
  return note(improvement > 0 && improvement >= floor ? 'win' : 'loss');
}

/**
 * Attach the measurement. Refuses everything that would let the outcome rewrite
 * the prediction rather than answer it.
 */
export async function recordRunOutcome(
  runId: string,
  input: OutcomeInput,
  now: string,
  deps: { store: PlaybookRunStore },
): Promise<RunResult> {
  const run = await deps.store.get(runId);
  if (!run) return no('not_found', `no run ${runId}`);
  if (!run.prediction || !run.falsifier)
    return no(
      'prediction_missing',
      `run ${runId} recorded no prediction — nothing to score against`,
    );
  if (run.outcome)
    return no(
      'outcome_exists',
      `run ${runId} has an outcome — correct it with correctRun, which appends`,
    );
  if (!Number.isInteger(input.n) || input.n < 0)
    return no('invalid_measurement', `n must be a non-negative integer, got ${String(input.n)}`);

  const daysEarly = Math.round((ms(run.falsifier.due_at) - ms(now)) / DAY_MS);
  let forced: RunOutcome['forced'] = null;
  if (ms(now) < ms(run.falsifier.due_at)) {
    const reason = input.force?.reason.trim() ?? '';
    if (reason.length === 0) {
      return no(
        'before_horizon',
        `${run.falsifier.horizon_days}-day horizon ends ${run.falsifier.due_at}, ${daysEarly} day(s) out — force it with a stated reason or wait`,
      );
    }
    forced = { reason, days_early: daysEarly };
  }

  const { classification, confounds } = classify(run.falsifier, input);
  const updated: LedgerRun = {
    ...run,
    lessons: input.lessons ?? run.lessons,
    outcome: {
      metric_actual: input.metric_actual,
      n: input.n,
      classification,
      verdict: VERDICT_OF[classification],
      measured_at: now,
      confounds,
      forced,
    },
  };
  await deps.store.put(updated);
  return { ok: true, run: updated };
}

/**
 * Correct a recorded outcome by APPENDING a new row. The old row is never
 * touched: a ledger you can edit is a ledger whose past agrees with whoever is
 * reading it today.
 */
export async function correctRun(
  runId: string,
  correction: { reason: string; outcome: OutcomeInput },
  now: string,
  deps: { store: PlaybookRunStore; runId: string },
): Promise<RunResult> {
  const original = await deps.store.get(runId);
  if (!original) return no('not_found', `no run ${runId} to correct`);
  if (correction.reason.trim().length === 0)
    return no('correction_needs_reason', 'a correction without a reason is a rewrite');
  if (await deps.store.get(deps.runId)) return no('duplicate_run', `run ${deps.runId} exists`);

  await deps.store.put({
    ...structuredClone(original),
    run_id: deps.runId,
    outcome: null,
    supersedes: runId,
    correction_reason: correction.reason.trim(),
  });
  return recordRunOutcome(deps.runId, correction.outcome, now, deps);
}

/* ── reading the ledger ───────────────────────────────────────────────────── */

/** Drops every row that a later correction replaced. */
export function effectiveRuns(runs: readonly LedgerRun[]): LedgerRun[] {
  const replaced = new Set(runs.map((r) => r.supersedes).filter((id): id is string => id !== null));
  return runs.filter((r) => !replaced.has(r.run_id));
}

/** Evidence is per VERSION. A shipped version never mutates, so v3's wins are
 *  v3's; v4 starts with an empty record, which is the honest starting point. */
export const runsFor = (
  runs: readonly LedgerRun[],
  playbookId: string,
  version: number,
): LedgerRun[] =>
  effectiveRuns(runs).filter((r) => r.playbook_id === playbookId && r.playbook_version === version);

/** Project into the stored contract shape. Null when there is no prediction —
 *  such a row is not a playbook run under the contract, and never was. */
export function toPlaybookRun(run: LedgerRun): PlaybookRun | null {
  if (!run.prediction) return null;
  const o = run.outcome;
  return {
    run_id: run.run_id,
    playbook_id: run.playbook_id,
    playbook_version: run.playbook_version,
    situation_snapshot: run.situation_snapshot,
    params_bound: run.params_bound,
    prediction: run.prediction,
    outcome:
      o === null
        ? null
        : {
            metric_actual: o.metric_actual,
            verdict: o.verdict,
            measured_at: o.measured_at,
            confounds: o.confounds,
          },
    lessons: run.lessons,
  };
}
