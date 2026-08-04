/**
 * Pre-mortem, and the debrief that grades it.
 *
 * A pre-mortem is Klein's move: it is six months from now and this failed —
 * why? The value is social, not analytical. Asking a room to explain a failure
 * that has already happened licenses dissent that the same room will not offer
 * when asked to predict one, because predicting failure sounds like doubting
 * the person proposing it. The exercise buys the dissent for free.
 *
 * Every refusal here exists because the ceremony is easy to perform without
 * doing the thing: three failure modes that are one failure mode reworded, or
 * three that are all the world's fault, or three that nobody could notice
 * happening. Those pass a review and buy nothing.
 *
 * The debrief closes it. It inherits `luck_attribution` from decision/store.ts:
 * process and outcome are recorded SEPARATELY and this module refuses to let a
 * writer collapse them, because judging a decision by its result is how a good
 * bet that lost once stops being made.
 */
import type { DecisionRecord } from '@tmos/contracts';

/* ── text helpers ─────────────────────────────────────────────────────────── */

// Duplicated deliberately from decision/store.ts, which does not export it and
// which this lane may not edit.
// TODO(consolidate): one `norm` for the package once `decide` has an index.
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'was', 'were', 'not']);
const words = (s: string): Set<string> =>
  new Set(
    norm(s)
      .split(' ')
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );

/** Overlap coefficient, not Jaccard: a terse pre-mortem line and a long
 *  post-hoc account of the same failure score near zero on Jaccard purely
 *  because one is longer. */
const overlap = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const w of a) if (b.has(w)) hits += 1;
  return hits / Math.min(a.size, b.size);
};

/* ── when a pre-mortem is mandatory ───────────────────────────────────────── */

/**
 * A default worth arguing with, which is why it is injected rather than read
 * from here: ~$2,500 is roughly a week of founder time at TMOS scale, the point
 * where the half-hour of ceremony is cheap against the mistake. A funded team
 * should raise it; a pre-revenue one should lower it.
 */
export const SUGGESTED_PREMORTEM_THRESHOLD_CENTS = 250_000;

/**
 * One failure mode is the one you already feared. Two is that one plus its
 * restatement. Three is the first count that forces a thought you had not
 * already had — and it is low enough that padding it is more work than meaning
 * it. Injected for the same reason as the threshold.
 */
export const SUGGESTED_MIN_PREMORTEM_ENTRIES = 3;

export interface PremortemPolicy {
  thresholdCents: number;
  minEntries: number;
}

export interface PremortemRequirement {
  required: boolean;
  reason: 'one_way_door' | 'cost_above_threshold' | 'not_required';
  detail: string;
}

/**
 * Reversibility, not price, sets the bar. A cheap one-way door is routinely the
 * expensive decision — a schema you can not un-ship, a partner you can not
 * un-announce — and it is exactly the one a cost threshold waves through.
 */
export function requiresPremortem(
  decision: Pick<DecisionRecord, 'door' | 'expected_cost_cents'>,
  policy: Pick<PremortemPolicy, 'thresholdCents'>,
): PremortemRequirement {
  if (decision.door === 'one_way') {
    return {
      required: true,
      reason: 'one_way_door',
      detail: 'a one-way door needs a pre-mortem at any cost — you cannot buy the option back',
    };
  }
  if (decision.expected_cost_cents >= policy.thresholdCents) {
    return {
      required: true,
      reason: 'cost_above_threshold',
      detail: `${decision.expected_cost_cents}¢ ≥ ${policy.thresholdCents}¢`,
    };
  }
  return {
    required: false,
    reason: 'not_required',
    detail: 'reversible and below the cost threshold',
  };
}

/* ── the pre-mortem itself ────────────────────────────────────────────────── */

export interface PremortemEntry {
  failureMode: string;
  mechanism: string;
  /** REQUIRED. A failure you cannot see coming is not actionable; it is mood. */
  earlyIndicator: string;
  mitigation: string;
  owner: string;
  /** endogenous = something WE do wrong. exogenous = the world moves. */
  locus: 'endogenous' | 'exogenous';
  /** The `kill_criteria[].metric` that would catch this, or null if none does. */
  killCriterionMetric: string | null;
}

export type PremortemRejectCode =
  | 'too_few_entries'
  | 'missing_early_indicator'
  | 'missing_owner'
  | 'duplicate_failure_mode'
  | 'all_exogenous'
  | 'unknown_kill_criterion';

export interface PremortemRejection {
  code: PremortemRejectCode;
  detail: string;
}

export interface PremortemReport {
  entries: number;
  endogenous: number;
  exogenous: number;
  /** Predicted failures with no kill criterion watching for them. */
  unmonitored: readonly string[];
  /** The mirror: kill criteria no failure mode predicts. */
  unpredicted: readonly string[];
}

export interface PremortemCheck {
  ok: boolean;
  rejections: readonly PremortemRejection[];
  /** Returned even on refusal — the gaps are worth seeing either way. */
  report: PremortemReport;
}

/**
 * Returns rather than throws, and returns EVERY defect rather than the first:
 * a pre-mortem sent back one complaint at a time gets rewritten to satisfy
 * complaints instead of rewritten to be true.
 */
export function assertPremortemComplete(
  decision: Pick<DecisionRecord, 'kill_criteria'>,
  premortem: readonly PremortemEntry[],
  policy: Partial<PremortemPolicy> = {},
): PremortemCheck {
  const minEntries = policy.minEntries ?? SUGGESTED_MIN_PREMORTEM_ENTRIES;
  const rejections: PremortemRejection[] = [];
  const no = (code: PremortemRejectCode, detail: string): number =>
    rejections.push({ code, detail });
  const metrics = new Map(decision.kill_criteria.map((k) => [norm(k.metric), k.metric]));

  if (premortem.length < minEntries) {
    no(
      'too_few_entries',
      `${premortem.length} failure mode(s) — ${minEntries} is the floor for the exercise to have cost anyone a thought`,
    );
  }

  const seen = new Set<string>();
  const linked = new Set<string>();
  const unmonitored: string[] = [];

  for (const e of premortem) {
    if (norm(e.earlyIndicator) === '') {
      no(
        'missing_early_indicator',
        `"${e.failureMode}" has no early indicator — you cannot act on it, only regret it`,
      );
    }
    if (norm(e.owner) === '') {
      no('missing_owner', `"${e.failureMode}" has no owner — an unowned mitigation is a wish`);
    }
    const key = norm(e.failureMode);
    if (seen.has(key)) {
      no(
        'duplicate_failure_mode',
        `"${e.failureMode}" is already in the list — a reworded repeat pads the count without adding a thought`,
      );
    }
    seen.add(key);

    if (e.killCriterionMetric === null) {
      unmonitored.push(e.failureMode);
    } else if (!metrics.has(norm(e.killCriterionMetric))) {
      no(
        'unknown_kill_criterion',
        `"${e.failureMode}" links to kill criterion "${e.killCriterionMetric}", which this decision does not have — it reads as monitored and is not`,
      );
    } else {
      linked.add(norm(e.killCriterionMetric));
    }
  }

  const endogenous = premortem.filter((e) => e.locus === 'endogenous').length;
  if (premortem.length > 0 && endogenous === 0) {
    no(
      'all_exogenous',
      'every failure mode is the world doing something to us — a pre-mortem that blames only the world is a comfort exercise, and at least one thing WE could get wrong must be named',
    );
  }

  return {
    ok: rejections.length === 0,
    rejections,
    report: {
      entries: premortem.length,
      endogenous,
      exogenous: premortem.length - endogenous,
      unmonitored,
      unpredicted: decision.kill_criteria
        .filter((k) => !linked.has(norm(k.metric)))
        .map((k) => k.metric),
    },
  };
}

/* ── the debrief ──────────────────────────────────────────────────────────── */

export interface CitedPrediction {
  id: string;
  claim: string;
  p: number;
  outcome: 0 | 1 | 'annulled';
}

export interface OccurredFailure {
  what: string;
  /** The pre-mortem `failureMode` the author says this was, or null. */
  foreseenAs: string | null;
  /** Did the early indicator fire before the failure landed? */
  earlyIndicatorSeen: boolean | null;
}

export interface ActualOutcome {
  result: 'good' | 'bad' | 'mixed';
  evidence: string;
  /** Must cite predictions the decision actually made. */
  predictions: readonly CitedPrediction[];
  occurred: readonly OccurredFailure[];
  /** Assumptions written down at decision time (e.g. a playbook's). */
  assumptionsAtDecisionTime: readonly string[];
  brokenAssumptions: readonly string[];
  /** Judged on its own terms, with its own reasoning. */
  process: {
    sound: boolean;
    reasoning: string;
    luckAttribution: 'process' | 'luck' | 'unknown';
  };
  whatWouldChangeNextTime: readonly string[];
}

export interface ForeseenFailure {
  failureMode: string;
  mitigation: string;
  owner: string;
  occurredAs: string;
  /** False = we predicted it, then wrote a history in which we did not. */
  citedByAuthor: boolean;
  indicatorObserved: boolean | null;
}

export interface Debrief {
  whatWePredicted: readonly string[];
  whatHappened: readonly string[];
  whichAssumptionsBroke: {
    stated: readonly string[];
    /** Found only by breaking. Usually the most valuable line in the debrief. */
    unstated: readonly string[];
  };
  luckAttribution: {
    outcome: 'good' | 'bad' | 'mixed';
    processSound: boolean;
    attribution: 'process' | 'luck' | 'unknown';
    /** The process verdict tracks the result. Legitimate, often — flagged so a
     *  reviewer confirms it was reached independently rather than read off. */
    resultingRisk: boolean;
    note: string;
  };
  whatWouldChangeNextTime: readonly string[];
  foreseen: readonly ForeseenFailure[];
  headline: string;
}

export type DebriefRejectCode =
  'no_prior_prediction' | 'unknown_prediction' | 'collapsed_process_and_outcome' | 'no_lesson';

export interface DebriefRejection {
  code: DebriefRejectCode;
  detail: string;
}

export type DebriefResult =
  { ok: true; debrief: Debrief } | { ok: false; rejections: readonly DebriefRejection[] };

/** Above this token overlap, a described failure and a predicted one are taken
 *  to be the same event even when the author did not say so. */
export const FORESEEN_MATCH_THRESHOLD = 0.5;

export function debrief(
  decision: Pick<DecisionRecord, 'id' | 'predictions'>,
  actual: ActualOutcome,
  opts: { premortem?: readonly PremortemEntry[]; matchThreshold?: number } = {},
): DebriefResult {
  const premortem = opts.premortem ?? [];
  const threshold = opts.matchThreshold ?? FORESEEN_MATCH_THRESHOLD;
  const rejections: DebriefRejection[] = [];
  const no = (code: DebriefRejectCode, detail: string): number => rejections.push({ code, detail });

  if (actual.predictions.length === 0) {
    no(
      'no_prior_prediction',
      `${decision.id}: a debrief that cites no prior prediction is a story about the past, not a measurement of it`,
    );
  }
  const made = new Set(decision.predictions);
  for (const p of actual.predictions) {
    if (!made.has(p.id)) {
      no(
        'unknown_prediction',
        `prediction ${p.id} was not one this decision made — grading against a forecast invented afterwards is retroactive credit`,
      );
    }
  }

  // Resulting, mechanically: the process verdict is the outcome wearing a
  // different hat. Both directions do damage — "it worked so the call was
  // right" is the one that survives longest.
  const evidence = norm(actual.evidence);
  const reasoning = norm(actual.process.reasoning);
  if (reasoning === '' || evidence.includes(reasoning) || reasoning.includes(evidence)) {
    no(
      'collapsed_process_and_outcome',
      'the process verdict is the outcome restated — that is *resulting*, and it teaches the wrong lesson in both directions',
    );
  }

  if (actual.whatWouldChangeNextTime.length === 0) {
    no(
      'no_lesson',
      'nothing to do differently — write "nothing, we would repeat this" and mean it',
    );
  }

  if (rejections.length > 0) return { ok: false, rejections };

  const foreseen: ForeseenFailure[] = [];
  for (const e of premortem) {
    const emWords = words(e.failureMode);
    const cited = actual.occurred.find(
      (o) => o.foreseenAs !== null && norm(o.foreseenAs) === norm(e.failureMode),
    );
    const matched =
      cited ?? actual.occurred.find((o) => overlap(emWords, words(o.what)) >= threshold);
    if (!matched) continue;
    foreseen.push({
      failureMode: e.failureMode,
      mitigation: e.mitigation,
      owner: e.owner,
      occurredAs: matched.what,
      citedByAuthor: cited !== undefined,
      indicatorObserved: matched.earlyIndicatorSeen,
    });
  }

  const uncited = foreseen.filter((f) => !f.citedByAuthor).length;
  const ignored = foreseen.filter((f) => f.indicatorObserved === true).length;
  const headline =
    foreseen.length === 0
      ? premortem.length === 0
        ? 'No pre-mortem to check this against.'
        : 'Nothing the pre-mortem predicted occurred — the failure, if any, was a surprise.'
      : `WE PREDICTED THIS — ${foreseen.length} of ${premortem.length} pre-mortem failure mode(s) occurred` +
        (uncited > 0 ? `; ${uncited} not cited in this debrief` : '') +
        (ignored > 0 ? `; ${ignored} had an early indicator that fired and was not acted on` : '') +
        '.';

  const stated = new Set(actual.assumptionsAtDecisionTime.map(norm));
  const resultingRisk =
    actual.result !== 'mixed' && actual.process.sound === (actual.result === 'good');

  return {
    ok: true,
    debrief: {
      whatWePredicted: [
        ...actual.predictions.map((p) => `p=${p.p} — ${p.claim} (resolved: ${p.outcome})`),
        ...premortem.map((e) => `pre-mortem: ${e.failureMode}`),
      ],
      whatHappened: [actual.evidence, ...actual.occurred.map((o) => o.what)],
      whichAssumptionsBroke: {
        stated: actual.brokenAssumptions.filter((a) => stated.has(norm(a))),
        unstated: actual.brokenAssumptions.filter((a) => !stated.has(norm(a))),
      },
      luckAttribution: {
        outcome: actual.result,
        processSound: actual.process.sound,
        attribution: actual.process.luckAttribution,
        resultingRisk,
        note: resultingRisk
          ? 'the process verdict matches the result — confirm it was judged on what was known BEFORE'
          : 'process and outcome disagree, which is the case this record exists to keep',
      },
      whatWouldChangeNextTime: actual.whatWouldChangeNextTime,
      foreseen,
      headline,
    },
  };
}
