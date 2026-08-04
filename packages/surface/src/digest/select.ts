/**
 * What earns an interruption.
 *
 * The scarce resource here is not compute, it is the founder's attention, and
 * attention has a property compute does not: spending it badly this week makes
 * next week's spend worth less. A digest that pushes six things trains the
 * reader to skim, and a skimmed digest is a digest that failed even when every
 * item in it was true. So the cap below is a CAP, not a target — three is the
 * most we may send, never the number we try to reach.
 *
 * Two consequences follow, and both are load-bearing:
 *
 *   1. Selection is competitive, not threshold-only. Clearing the materiality
 *      gate earns candidacy; it does not earn a slot. The fourth-best finding
 *      in a strong week is held, and the held set is returned so nothing is
 *      lost silently.
 *
 *   2. Sending nothing is a FIRST-CLASS OUTPUT, not an empty array. A system
 *      that goes quiet and a system that is broken look identical from the
 *      outside, and the reader has no way to tell which one they are living
 *      with. So the quiet state is a distinct arm of the union, it names why
 *      it is quiet, and it carries the count of signals examined. Silence with
 *      a receipt is a result. Silence without one is an outage.
 */
import type { Finding } from '@tmos/contracts';
import { basisDisplay, mayQuoteAsFact } from '../basis.js';

/* ── the numbers, and why they are these numbers ──────────────────────────── */

/** Three pushes a week. Chosen as the largest number that still forces a real
 *  ranking decision: at four-plus the selector can say yes to everything good,
 *  which is the same as having no selector. */
export const WEEKLY_PUSH_CAP = 3;

/** Trailing window the cap is measured over. Rolling, not calendar-aligned —
 *  a calendar week lets a Sunday-night burst and a Monday-morning burst sit in
 *  different buckets while landing on the same reader inside twelve hours. */
export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum materiality to be a candidate at all.
 *
 * 0.6 on the composite below. Calibrated so that the two shapes we most want to
 * keep out — a low-stakes finding with an impeccable basis, and a mid-scoring
 * finding nobody would act on — both land under it, while a high-stakes finding
 * on a weak basis lands over it. That asymmetry is deliberate: see the weights.
 */
export const MATERIALITY_GATE = 0.6;

/**
 * Bar for exceeding the weekly cap.
 *
 * Pre-emption is allowed, narrowly, because the cap exists to protect attention
 * and not to make the system incapable of reporting a fire. A cap that cannot
 * be broken under any circumstance is one the reader learns to distrust the
 * first time something urgent arrives on a Friday.
 *
 * Three conditions, all required. The finding must be high-stakes; its basis
 * must be one that `mayQuoteAsFact` accepts, so a rumour can never pre-empt
 * (pre-empting on an exploratory finding is precisely how a rumour becomes an
 * emergency); and it must clear 0.85, well above the ordinary gate. It only
 * fires when the cap leaves ZERO slots — if a slot remains the finding is not
 * being silenced, it is merely being ranked, and ranking is the system working.
 */
export const PREEMPTION_GATE = 0.85;

/** And the exception is capped too. An uncapped exception is not an exception,
 *  it is a second and softer cap. If two separate things are genuinely on fire
 *  in one week, the second one is not a Slack-message problem. */
export const PREEMPTION_CAP = 1;

/**
 * Composite materiality weights.
 *
 * `domain_score` dominates because it is the domain pack's own judgement of how
 * much this matters in its field, and that is the thing we are actually asking.
 * Stakes is second: it is what makes an interruption worth its cost. Basis is
 * last and smallest ON PURPOSE — basis governs how a finding is RENDERED, not
 * whether it deserves to be seen. A high-stakes exploratory finding still needs
 * to reach the reader; it just must not look certain when it gets there. If
 * basis were weighted heavily it would silently become a second gate, and the
 * system would go blind to exactly the early, unverified signals it exists to
 * catch. (`basis.ts`: "A high-stakes exploratory finding still needs to be
 * seen; it just must not look certain.")
 */
const W_DOMAIN = 0.6;
const W_STAKES = 0.25;
const W_BASIS = 0.15;

const STAKES_WEIGHT: Record<Finding['stakes'], number> = { low: 0, medium: 0.5, high: 1 };
const STAKES_ORDER: Record<Finding['stakes'], number> = { low: 0, medium: 1, high: 2 };

/**
 * Materiality in [0, 1]. For RANKING and gating only.
 *
 * Never render this, and never render `domain_score`: a 0–1 number shown to a
 * human reads as confidence no matter what the label above it says, and that is
 * the one thing this package refuses to do. `assertNoConfidenceNumber` guards
 * the rendering side; this comment guards the temptation.
 */
export function materiality(f: Finding): number {
  const basisWeight = basisDisplay(f.basis).rank / 3;
  const raw =
    W_DOMAIN * f.domain_score + W_STAKES * STAKES_WEIGHT[f.stakes] + W_BASIS * basisWeight;
  // Rounded so float noise can never decide a tie; ties are broken explicitly.
  return Math.round(raw * 1e6) / 1e6;
}

/* ── inputs and outputs ───────────────────────────────────────────────────── */

/** One past push. `preemptedCap` is recorded so the exception budget can be
 *  audited — an exception nobody counts is not an exception. */
export interface DeliveryRecord {
  findingId: string;
  /** ISO-8601. */
  deliveredAt: string;
  preemptedCap?: boolean;
}

export interface SelectInput {
  candidates: readonly Finding[];
  /** Every push ever made, not just this week: the cap is windowed, the
   *  never-send-it-twice rule is not. */
  history: readonly DeliveryRecord[];
  /** How many raw signals the pipeline examined to produce these candidates.
   *  This is what makes a quiet week legible rather than suspicious. */
  signalsExamined: number;
  /** Injected — library code does not read the clock. */
  now: Date;
}

export interface SelectedFinding {
  finding: Finding;
  score: number;
  /** True when this finding exceeded the weekly cap under the rule above. */
  preempts: boolean;
}

export type HoldReason = 'superseded' | 'already_delivered' | 'below_gate' | 'weekly_cap';

export interface HeldFinding {
  finding: Finding;
  score: number;
  reason: HoldReason;
}

export type QuietReason = 'nothing_material' | 'weekly_cap_reached';

export type DigestSelection =
  | {
      kind: 'digest';
      items: SelectedFinding[];
      held: HeldFinding[];
      checked: number;
      windowStart: string;
    }
  | {
      kind: 'quiet';
      /** Nothing has been pushed since this instant. */
      since: string;
      /** Signals examined to reach this silence. */
      checked: number;
      reason: QuietReason;
      held: HeldFinding[];
    };

/* ── ranking ──────────────────────────────────────────────────────────────── */

interface Scored {
  finding: Finding;
  score: number;
}

/**
 * Total order, so the result cannot depend on the order candidates arrived in.
 *
 * The last key is the id, which is arbitrary but TOTAL — without it two findings
 * identical on every other key would keep their input order, and the selector
 * would quietly become a function of upstream iteration order.
 */
function compareScored(a: Scored, b: Scored): number {
  return (
    b.score - a.score ||
    STAKES_ORDER[b.finding.stakes] - STAKES_ORDER[a.finding.stakes] ||
    basisDisplay(b.finding.basis).rank - basisDisplay(a.finding.basis).rank ||
    // Older first: a finding that has been waiting has already lost freshness.
    Date.parse(a.finding.created_at) - Date.parse(b.finding.created_at) ||
    (a.finding.id < b.finding.id ? -1 : a.finding.id > b.finding.id ? 1 : 0)
  );
}

const compareHeld = (a: HeldFinding, b: HeldFinding): number =>
  compareScored(a, b) || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0);

const qualifiesForPreemption = (s: Scored): boolean =>
  s.finding.stakes === 'high' && mayQuoteAsFact(s.finding.basis) && s.score >= PREEMPTION_GATE;

/* ── selection ────────────────────────────────────────────────────────────── */

export function selectDigest(input: SelectInput): DigestSelection {
  const windowStart = new Date(input.now.getTime() - WINDOW_MS);
  const delivered = new Set(input.history.map((h) => h.findingId));
  const inWindow = input.history.filter((h) => Date.parse(h.deliveredAt) >= windowStart.getTime());

  const held: HeldFinding[] = [];
  const eligible: Scored[] = [];

  for (const finding of input.candidates) {
    const score = materiality(finding);
    // A correction must never be outranked by the thing it corrects.
    if (finding.superseded_by !== null) {
      held.push({ finding, score, reason: 'superseded' });
    } else if (delivered.has(finding.id)) {
      // Re-pushing is worse than not pushing: it costs attention and returns
      // nothing, and it is indistinguishable from the system losing its place.
      held.push({ finding, score, reason: 'already_delivered' });
    } else {
      eligible.push({ finding, score });
    }
  }

  const ranked = [...eligible].sort(compareScored);
  const passed: Scored[] = [];
  for (const s of ranked) {
    if (s.score >= MATERIALITY_GATE) passed.push(s);
    else held.push({ finding: s.finding, score: s.score, reason: 'below_gate' });
  }

  const slots = Math.max(0, WEEKLY_PUSH_CAP - inWindow.length);
  const items: SelectedFinding[] = passed
    .slice(0, slots)
    .map((s) => ({ finding: s.finding, score: s.score, preempts: false }));

  const overflow = passed.slice(items.length);

  // Pre-emption fires only when the cap leaves nothing at all: with a slot free
  // the finding is being ranked, not silenced, and ranking is the system
  // working as designed.
  if (slots === 0) {
    const spent = inWindow.filter((h) => h.preemptedCap === true).length;
    let budget = Math.max(0, PREEMPTION_CAP - spent);
    for (const s of overflow) {
      if (budget === 0) break;
      if (!qualifiesForPreemption(s)) continue;
      items.push({ finding: s.finding, score: s.score, preempts: true });
      budget -= 1;
    }
  }

  const pushedIds = new Set(items.map((i) => i.finding.id));
  for (const s of overflow) {
    if (pushedIds.has(s.finding.id)) continue;
    held.push({ finding: s.finding, score: s.score, reason: 'weekly_cap' });
  }

  items.sort(compareScored);
  held.sort(compareHeld);

  if (items.length === 0) {
    const lastDelivery = input.history
      .map((h) => h.deliveredAt)
      .sort()
      .at(-1);
    return {
      kind: 'quiet',
      since: lastDelivery ?? windowStart.toISOString(),
      checked: input.signalsExamined,
      reason: passed.length === 0 ? 'nothing_material' : 'weekly_cap_reached',
      held,
    };
  }

  return {
    kind: 'digest',
    items,
    held,
    checked: input.signalsExamined,
    windowStart: windowStart.toISOString(),
  };
}
