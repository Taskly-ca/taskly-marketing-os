/**
 * The ER label store — mirrors the `er_label` table from migration 002.
 *
 * Labels are not paperwork. They are the two things that make the rest of this
 * directory improvable:
 *
 *   1. a REGRESSION SUITE — replay every human verdict through a changed scorer
 *      and see which previously-correct decisions the change breaks. Without
 *      it, "the scorer got better" is an unfalsifiable claim.
 *   2. a CALIBRATION SET — the thresholds in `blocking.ts` were guessed; these
 *      labels replace the guess with a measurement on this pool.
 *
 * Deterministic throughout: no clock, no randomness. `decidedAt` is supplied by
 * the caller precisely so the store never reads the wall clock.
 */
// The store-failure taxonomy lives with the first fake that needed it. One
// definition, not two: `export *` from the package index silently DROPS a name
// exported by two modules, so a second local `ConstraintError` would remove the
// class from `@tmos/world` altogether rather than collide loudly.
import { ConstraintError } from '../fact/memory-store.js';
import { AUTO_MERGE, AUTO_REJECT } from './blocking.js';

export type HumanVerdict = 'match' | 'no_match' | 'unsure';

/** One row of `er_label`. */
export interface ErLabel {
  id: string;
  leftEntity: string;
  rightEntity: string;
  /** The score the pipeline produced at the time the human ruled on it. */
  score: number;
  llmVerdict: string | null;
  llmRationale: string | null;
  humanVerdict: HumanVerdict;
  decidedBy: string;
  /** ISO timestamp, supplied by the caller — this module never reads a clock. */
  decidedAt: string;
}

export type ErLabelInput = Omit<ErLabel, 'id'>;

/** (A,B) and (B,A) are the same pair; storing both would double-count. */
export const pairKey = (left: string, right: string): string =>
  left < right ? `${left}|${right}` : `${right}|${left}`;

export interface LabelStore {
  add(label: ErLabelInput): Promise<ErLabel>;
  all(): Promise<ErLabel[]>;
  byPair(left: string, right: string): Promise<ErLabel | null>;
}

let counter = 0;
/** Deterministic ids — a test that prints a label id stays reproducible. */
const nextId = (): string => `erl_${(++counter).toString(36).padStart(6, '0')}`;

export function resetLabelIds(): void {
  counter = 0;
}

/** In-memory store. A re-label of the same pair REPLACES the old verdict:
 *  humans correct themselves, and two contradictory rows would silently skew
 *  every precision number computed afterwards — which is exactly what 006's
 *  `er_label_pair_uidx` enforces on disk, and why the Postgres adapter's `add`
 *  is an `on conflict … do update` rather than a plain insert. */
export function createMemoryLabelStore(): LabelStore {
  const rows = new Map<string, ErLabel>();
  return {
    async add(label) {
      // 006's other constraint, `er_label_not_self`. A pair is never a
      // self-match: that row is always a mistake, and it hands the calibration
      // set a free true positive — which moves the auto-merge threshold every
      // precision number here is fitted to. Compared case-insensitively
      // because these are uuids on disk and Postgres normalizes them to lower
      // case before the check ever sees them.
      if (label.leftEntity.toLowerCase() === label.rightEntity.toLowerCase()) {
        throw new ConstraintError(
          `add: ${label.leftEntity} labelled against itself — migration 006's er_label_not_self ` +
            'rejects a self-pair, because it is always a mistake and it inflates precision with ' +
            'a free true positive.',
        );
      }

      const key = pairKey(label.leftEntity, label.rightEntity);
      const stored: ErLabel = { ...label, id: rows.get(key)?.id ?? nextId() };
      rows.set(key, stored);
      return { ...stored };
    },
    async all() {
      return [...rows.values()].map((r) => ({ ...r }));
    },
    async byPair(left, right) {
      const hit = rows.get(pairKey(left, right));
      return hit ? { ...hit } : null;
    },
  };
}

/* ── review queue ────────────────────────────────────────────────────────── */

/**
 * The point where the pipeline's decision flips. Midpoint of the adjudication
 * band, which is the score the current thresholds are least sure about.
 */
export const DECISION_BOUNDARY = (AUTO_REJECT + AUTO_MERGE) / 2;

export interface ReviewPair {
  leftEntity: string;
  rightEntity: string;
  score: number;
  llmVerdict?: string | null;
  llmRationale?: string | null;
}

export interface ReviewQueue {
  enqueue(pair: ReviewPair): void;
  /** Most decision-relevant first. */
  pending(limit?: number): ReviewPair[];
  size(): number;
  resolve(left: string, right: string): void;
}

/**
 * Ordered by DISTANCE FROM THE DECISION BOUNDARY, ascending — not by score.
 *
 * Sorting by score is the intuitive choice and the wrong one. A pair at 0.99 is
 * one the pipeline already decides correctly, so a human confirming it teaches
 * nothing and moves no threshold. A pair at 0.85 is a coin flip, and its label
 * is the one that actually shifts where the cutoff belongs. This is uncertainty
 * sampling: label where the model is least certain, because that is where a
 * label carries the most information. Ties break on the pair key, so the queue
 * is stable across runs.
 */
export function createReviewQueue(opts: { boundary?: number } = {}): ReviewQueue {
  const boundary = opts.boundary ?? DECISION_BOUNDARY;
  const items = new Map<string, ReviewPair>();
  return {
    enqueue(pair) {
      items.set(pairKey(pair.leftEntity, pair.rightEntity), { ...pair });
    },
    resolve(left, right) {
      items.delete(pairKey(left, right));
    },
    size: () => items.size,
    pending(limit) {
      const sorted = [...items.entries()].sort((a, b) => {
        const da = Math.abs((a[1].score ?? 0) - boundary);
        const db = Math.abs((b[1].score ?? 0) - boundary);
        if (da !== db) return da - db;
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });
      const out = sorted.map(([, v]) => ({ ...v }));
      return limit === undefined ? out : out.slice(0, limit);
    },
  };
}

/* ── calibration ─────────────────────────────────────────────────────────── */

/**
 * Floor for fitting a threshold. A cutoff chosen on 12 labels is noise: with ~6
 * positives, one relabelled pair moves measured precision by ~17 points, and
 * the threshold that looks best is usually the one overfitting the two nearest
 * scores. 50 usable labels with ≥10 positives is still a small sample — it is
 * where the number stops being actively misleading, not where it becomes
 * trustworthy.
 */
export const MIN_CALIBRATION_LABELS = 50;
export const MIN_CALIBRATION_POSITIVES = 10;
export const DEFAULT_TARGET_PRECISION = 0.98;

/** `unsure` is not ground truth — it is dropped everywhere, including the floor. */
export const usableLabels = (labels: readonly ErLabel[]): ErLabel[] =>
  labels.filter((l) => l.humanVerdict !== 'unsure');

export interface ThresholdReport {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Confusion matrix for "predict match iff score ≥ threshold".
 *
 * Precision with no positive predictions is 0 by convention, not 1: a rule that
 * merges nothing has not achieved perfect precision, it has abstained, and
 * reporting 1.0 would make the empty rule win every threshold search.
 */
export function thresholdReport(labels: readonly ErLabel[], threshold: number): ThresholdReport {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const l of usableLabels(labels)) {
    const predicted = l.score >= threshold;
    const actual = l.humanVerdict === 'match';
    if (predicted && actual) tp++;
    else if (predicted && !actual) fp++;
    else if (!predicted && actual) fn++;
    else tn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { threshold, tp, fp, fn, tn, precision, recall, f1 };
}

export interface Calibration {
  labelCount: number;
  positives: number;
  targetPrecision: number;
  /** How the threshold in force today actually performs on these labels. */
  current: ThresholdReport;
  /** Lowest threshold reaching the target precision — null if none does. */
  suggested: ThresholdReport | null;
  note: string;
}

export interface CalibrateOptions {
  targetPrecision?: number;
  /** The cutoff in force today. Defaults to the auto-merge edge. */
  currentThreshold?: number;
}

/**
 * Measure the current threshold and suggest one that hits a target precision.
 *
 * Returns **null** below the label floor rather than a number with a wide
 * invisible error bar — an unreliable threshold that looks authoritative is
 * worse than no threshold, because it gets deployed. Among the thresholds that
 * clear the target we take the LOWEST, which keeps the most recall. The
 * reported precision is in-sample, so it is optimistic: expect live precision
 * to come in a little lower.
 */
export function calibrate(
  labels: readonly ErLabel[],
  opts: CalibrateOptions = {},
): Calibration | null {
  const usable = usableLabels(labels);
  const positives = usable.filter((l) => l.humanVerdict === 'match').length;
  if (usable.length < MIN_CALIBRATION_LABELS || positives < MIN_CALIBRATION_POSITIVES) return null;

  const targetPrecision = opts.targetPrecision ?? DEFAULT_TARGET_PRECISION;
  const current = thresholdReport(usable, opts.currentThreshold ?? AUTO_MERGE);

  // Every distinct observed score is a candidate cutoff; nothing between two
  // adjacent scores can change the partition, so this scan is exhaustive.
  const candidates = [...new Set(usable.map((l) => l.score))].sort((a, b) => a - b);
  let suggested: ThresholdReport | null = null;
  for (const t of candidates) {
    const r = thresholdReport(usable, t);
    if (r.tp + r.fp > 0 && r.precision >= targetPrecision) {
      suggested = r;
      break;
    }
  }

  return {
    labelCount: usable.length,
    positives,
    targetPrecision,
    current,
    suggested,
    note: suggested
      ? `precision ${suggested.precision.toFixed(3)} at threshold ${suggested.threshold.toFixed(3)} — in-sample, expect slightly lower live`
      : `no threshold on ${usable.length} labels reaches precision ${targetPrecision} — the scorer, not the cutoff, is the problem`,
  };
}

/* ── regression suite ────────────────────────────────────────────────────── */

export type Decision = 'match' | 'no_match';

export interface RegressionCase {
  label: ErLabel;
  oldScore: number;
  newScore: number;
  oldDecision: Decision;
  newDecision: Decision;
  oldCorrect: boolean;
  newCorrect: boolean;
}

export interface RegressionReport {
  evaluated: number;
  /** Labels the scorer could not re-score (entity gone) — excluded, not guessed. */
  skipped: number;
  threshold: number;
  /** Was right, is now wrong. The only column that blocks a change. */
  broke: RegressionCase[];
  fixed: RegressionCase[];
  oldAccuracy: number;
  newAccuracy: number;
}

/**
 * Replay every label through a changed scorer.
 *
 * `rescore` returns null when the pair can no longer be scored — an entity was
 * deleted or merged away. Those are counted as skipped rather than folded into
 * accuracy, because scoring them as wrong would make an unrelated deletion look
 * like a regression.
 */
export function regressionSuite(
  labels: readonly ErLabel[],
  rescore: (label: ErLabel) => number | null,
  opts: { threshold?: number } = {},
): RegressionReport {
  const threshold = opts.threshold ?? DECISION_BOUNDARY;
  const decide = (s: number): Decision => (s >= threshold ? 'match' : 'no_match');

  const broke: RegressionCase[] = [];
  const fixed: RegressionCase[] = [];
  let evaluated = 0;
  let skipped = 0;
  let oldRight = 0;
  let newRight = 0;

  for (const label of usableLabels(labels)) {
    const newScore = rescore(label);
    if (newScore === null) {
      skipped++;
      continue;
    }
    evaluated++;
    const oldDecision = decide(label.score);
    const newDecision = decide(newScore);
    const oldCorrect = oldDecision === label.humanVerdict;
    const newCorrect = newDecision === label.humanVerdict;
    if (oldCorrect) oldRight++;
    if (newCorrect) newRight++;
    const entry: RegressionCase = {
      label,
      oldScore: label.score,
      newScore,
      oldDecision,
      newDecision,
      oldCorrect,
      newCorrect,
    };
    if (oldCorrect && !newCorrect) broke.push(entry);
    else if (!oldCorrect && newCorrect) fixed.push(entry);
  }

  return {
    evaluated,
    skipped,
    threshold,
    broke,
    fixed,
    oldAccuracy: evaluated > 0 ? oldRight / evaluated : 0,
    newAccuracy: evaluated > 0 ? newRight / evaluated : 0,
  };
}
