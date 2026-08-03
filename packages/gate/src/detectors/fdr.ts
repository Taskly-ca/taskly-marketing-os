/**
 * The promotion gate — what a fired detection has to survive before anyone
 * hears about it.
 *
 * We run N detectors across M entities every single day. At N*M = 2000 tests
 * and a per-detector alpha of 0.05, roughly a hundred of them fire on pure
 * noise before anything real happens; the alert list is then majority noise and
 * gets ignored, which is the same as having no detectors. This is a
 * multiple-testing problem, not N independent tests, and it needs three
 * separate corrections because it fails in three separate ways:
 *
 * 1. BENJAMINI-HOCHBERG across the daily panel, controlling the expected
 *    proportion of false discoveries at q. Not Bonferroni: Bonferroni controls
 *    the probability of ANY false alarm, which at this panel size costs nearly
 *    all the power. FDR is the right target — we can tolerate one bad lead in
 *    ten, we cannot tolerate ten leads out of twenty being bad.
 *
 * 2. PERSISTENCE (2 of the last 3 windows). BH is a statement about one day's
 *    panel. A genuine change in a business persists; a one-off spike is a
 *    holiday, a bot, or a bad scrape. Requiring two of three windows costs one
 *    day of latency and removes most of what survives step 1 by luck.
 *
 * 3. HYSTERESIS — separate fire and clear thresholds. A signal parked at its
 *    threshold crosses it repeatedly on noise alone and re-fires every time,
 *    which reads as a stream of new findings about one unchanged fact. Once
 *    active, a signal stays active until it falls to the (lower) clear level.
 *
 * Detections carrying `pValue: null` are NON-STATISTICAL rules — the control
 * charts in `drift.ts`, and any deterministic rule added later. They are passed
 * through the BH filter unchanged and are not counted in the tested family:
 * a control limit is an ARL design point, not a tail probability, and
 * pretending otherwise would corrupt the very quantity BH is ranking. They
 * still face persistence and hysteresis, which is where they are actually
 * weak.
 */
import type { Detection } from './types.js';

/** One bad lead in ten is the tolerance this system was designed around. */
export const DEFAULT_Q = 0.1;

export type FdrOutcome =
  /** Detector did not fire; counted in the family, never promoted. */
  | 'not-fired'
  /** Fired, no p-value; not a statistical test, so BH has no opinion. */
  | 'passthrough'
  /** Fired and cleared the BH cutoff. */
  | 'survived'
  /** Fired but did not clear the BH cutoff. */
  | 'rejected';

export interface FdrDecision {
  detection: Detection;
  outcome: FdrOutcome;
  survived: boolean;
}

export interface FdrResult {
  q: number;
  /** Size of the tested family: every non-null p-value on the panel, fired or
   *  not. Restricting the family to fired detections would bias the cutoff —
   *  the family has to be the tests we ran, not the ones that came back loud. */
  tested: number;
  /** Largest p-value that survives, or null if nothing does. */
  threshold: number | null;
  decisions: FdrDecision[];
  survivors: Detection[];
}

/** Fail-closed: anything that is not a usable probability is treated as 1, so a
 *  malformed p-value can never manufacture a discovery. */
const safeP = (p: number): number => (Number.isFinite(p) && p >= 0 && p <= 1 ? p : 1);

/**
 * Benjamini-Hochberg step-up. Sort the family's p-values ascending, find the
 * LARGEST rank i where p_(i) <= (i/m) * q, and reject every hypothesis at or
 * below that rank — including ones that failed their own rank's cutoff. That
 * step-up behaviour is the whole procedure; a per-rank scan that stops at the
 * first failure is a different, much weaker test.
 */
export function benjaminiHochberg(
  detections: readonly Detection[],
  q: number = DEFAULT_Q,
): FdrResult {
  if (!Number.isFinite(q) || q <= 0 || q > 1) {
    throw new RangeError(`q must be in (0, 1]; got ${q}`);
  }

  const family = detections.filter((d) => d.pValue !== null).map((d) => safeP(d.pValue ?? 1));
  const m = family.length;

  let threshold: number | null = null;
  if (m > 0) {
    const sorted = [...family].sort((a, b) => a - b);
    for (let i = m; i >= 1; i--) {
      const p = sorted[i - 1];
      if (p !== undefined && p <= (i / m) * q) {
        threshold = p;
        break;
      }
    }
  }

  const decisions: FdrDecision[] = detections.map((detection) => {
    if (!detection.fired) return { detection, outcome: 'not-fired', survived: false };
    if (detection.pValue === null) return { detection, outcome: 'passthrough', survived: true };
    const p = safeP(detection.pValue);
    const survived = threshold !== null && p <= threshold;
    return { detection, outcome: survived ? 'survived' : 'rejected', survived };
  });

  return {
    q,
    tested: m,
    threshold,
    decisions,
    survivors: decisions.filter((d) => d.survived).map((d) => d.detection),
  };
}

export interface PersistenceRule {
  /** How many trailing windows to look at. */
  readonly of: number;
  /** How many of them must have fired. */
  readonly need: number;
}

/** One day of latency in exchange for dropping most one-off noise. */
export const PERSISTENCE_2_OF_3: PersistenceRule = { of: 3, need: 2 };

/**
 * `fires` is the signal's own history, oldest first, one entry per window,
 * with the window just evaluated last. Fewer windows than the rule asks for is
 * fine — what matters is whether `need` fires are present among those that
 * exist, so a brand-new signal simply cannot reach the bar yet.
 */
export function passesPersistence(
  fires: readonly boolean[],
  rule: PersistenceRule = PERSISTENCE_2_OF_3,
): boolean {
  if (!Number.isInteger(rule.of) || rule.of < 1) {
    throw new RangeError(`persistence window must be a positive integer; got ${rule.of}`);
  }
  if (!Number.isInteger(rule.need) || rule.need < 1 || rule.need > rule.of) {
    throw new RangeError(`persistence needs 1..${rule.of} fires; got ${rule.need}`);
  }
  const recent = fires.slice(-rule.of);
  return recent.filter(Boolean).length >= rule.need;
}

export interface HysteresisBand {
  /** |score| at or above which an inactive signal turns on. */
  readonly fireAt: number;
  /** |score| below which an active signal turns off. Must be < fireAt. */
  readonly clearAt: number;
}

/** Detector scores are normalised so 1.0 is the firing threshold; clearing at
 *  0.6 means a signal has to fall meaningfully back before it can re-fire. */
export const DEFAULT_HYSTERESIS: HysteresisBand = { fireAt: 1, clearAt: 0.6 };

function assertBand(band: HysteresisBand): void {
  if (!(band.clearAt < band.fireAt)) {
    throw new RangeError(
      `hysteresis needs clearAt < fireAt; got clearAt=${band.clearAt}, fireAt=${band.fireAt}`,
    );
  }
}

/**
 * One step of the two-threshold latch. Works on |score|, because a drop is as
 * real as a spike; a signal that flips sign while staying large is handled
 * upstream by keying the latch state per direction, not here.
 */
export function hysteresisStep(
  score: number,
  active: boolean,
  band: HysteresisBand = DEFAULT_HYSTERESIS,
): boolean {
  assertBand(band);
  if (!Number.isFinite(score)) return false;
  const magnitude = Math.abs(score);
  return active ? magnitude >= band.clearAt : magnitude >= band.fireAt;
}

/** The latch applied over a sequence — one entry per window, oldest first. */
export function hysteresisRun(
  scores: readonly number[],
  band: HysteresisBand = DEFAULT_HYSTERESIS,
  initial = false,
): boolean[] {
  assertBand(band);
  let active = initial;
  return scores.map((s) => {
    active = hysteresisStep(s, active, band);
    return active;
  });
}
