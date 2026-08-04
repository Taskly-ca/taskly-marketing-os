import { describe, it, expect } from 'vitest';
import {
  requiresPremortem,
  assertPremortemComplete,
  debrief,
  SUGGESTED_PREMORTEM_THRESHOLD_CENTS,
  SUGGESTED_MIN_PREMORTEM_ENTRIES,
} from './premortem.js';
import type { PremortemEntry, ActualOutcome, DebriefResult } from './premortem.js';

/** Refusal codes, or `[]` when the debrief was accepted. */
const codes = (r: DebriefResult): string[] => (r.ok ? [] : r.rejections.map((x) => x.code));

const policy = { thresholdCents: SUGGESTED_PREMORTEM_THRESHOLD_CENTS };

const entry = (over: Partial<PremortemEntry> = {}): PremortemEntry => ({
  failureMode: 'Taskers stop opening the daily digest',
  mechanism: 'we send it at 7am, before anyone has picked up a job',
  earlyIndicator: 'digest open rate falls under 20% for two consecutive weeks',
  mitigation: 'move the send to 5pm and A/B the subject line',
  owner: 'nishant',
  locus: 'endogenous',
  killCriterionMetric: 'digest_open_rate',
  ...over,
});

/** Three distinct entries, one of them ours to get wrong. */
const goodPremortem = (): PremortemEntry[] => [
  entry(),
  entry({
    failureMode: 'Supply dries up in Scarborough',
    mechanism: 'our only three taskers there churn in the same month',
    earlyIndicator: 'active taskers in M1x postal codes drops below 3',
    locus: 'exogenous',
    killCriterionMetric: 'active_taskers_scarborough',
  }),
  entry({
    failureMode: 'The classifier mislabels plumbing as handyman',
    mechanism: 'the enum collapsed two subcategories in migration 031',
    earlyIndicator: 'manual re-categorisation rate above 10% of posted tasks',
    locus: 'endogenous',
    killCriterionMetric: null,
  }),
];

const killCriteria = [
  { metric: 'digest_open_rate', threshold: 0.2, by: '2026-12-01' },
  { metric: 'active_taskers_scarborough', threshold: 3, by: '2026-12-01' },
  { metric: 'refund_rate', threshold: 0.05, by: '2026-12-01' },
];

const decision = { kill_criteria: killCriteria };

describe('when a pre-mortem is mandatory', () => {
  it('demands one for a one-way door at ANY cost — reversibility, not price', () => {
    const free = { door: 'one_way' as const, expected_cost_cents: 0 };
    const r = requiresPremortem(free, policy);
    expect(r.required).toBe(true);
    expect(r.reason).toBe('one_way_door');
  });

  it('demands one for an expensive two-way door', () => {
    const r = requiresPremortem(
      { door: 'two_way', expected_cost_cents: policy.thresholdCents + 1 },
      policy,
    );
    expect(r.required).toBe(true);
    expect(r.reason).toBe('cost_above_threshold');
  });

  it('does not demand one for a cheap reversible decision', () => {
    const r = requiresPremortem({ door: 'two_way', expected_cost_cents: 500 }, policy);
    expect(r.required).toBe(false);
    expect(r.reason).toBe('not_required');
  });

  it('takes the threshold as an injected value, so a different balance sheet gets a different bar', () => {
    const cheap = { door: 'two_way' as const, expected_cost_cents: 1_000 };
    expect(requiresPremortem(cheap, { thresholdCents: 100 }).required).toBe(true);
    expect(requiresPremortem(cheap, { thresholdCents: 10_000 }).required).toBe(false);
  });
});

describe('what a pre-mortem must contain to be worth doing', () => {
  it('accepts a complete one', () => {
    const r = assertPremortemComplete(decision, goodPremortem());
    expect(r.ok).toBe(true);
  });

  it('refuses a pre-mortem that blames only the world', () => {
    // The comfort exercise: every failure is someone else's fault, so nothing
    // in our control has to change.
    const external = goodPremortem().map((e) => entry({ ...e, locus: 'exogenous' }));
    const r = assertPremortemComplete(decision, external);
    expect(r.ok).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain('all_exogenous');
  });

  it('refuses an entry with no early indicator — that is pessimism, not a warning', () => {
    const blind = goodPremortem();
    blind[0] = entry({ earlyIndicator: '  ' });
    const r = assertPremortemComplete(decision, blind);
    expect(r.ok).toBe(false);
    const codes = r.rejections.map((x) => x.code);
    expect(codes).toContain('missing_early_indicator');
  });

  it('refuses fewer than the minimum number of entries', () => {
    const r = assertPremortemComplete(decision, goodPremortem().slice(0, 1));
    expect(r.ok).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain('too_few_entries');
    expect(SUGGESTED_MIN_PREMORTEM_ENTRIES).toBeGreaterThanOrEqual(3);
  });

  it('takes the minimum as an injected value too', () => {
    const r = assertPremortemComplete(decision, goodPremortem().slice(0, 1), { minEntries: 1 });
    expect(r.ok).toBe(true);
  });

  it('refuses the same failure mode written twice', () => {
    const padded = goodPremortem();
    padded[2] = entry({ failureMode: 'Taskers stop opening the daily digest.' });
    const r = assertPremortemComplete(decision, padded);
    expect(r.ok).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain('duplicate_failure_mode');
  });

  it('refuses an entry with no owner', () => {
    const orphan = goodPremortem();
    orphan[1] = entry({ ...orphan[1]!, owner: '' });
    const r = assertPremortemComplete(decision, orphan);
    expect(r.ok).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain('missing_owner');
  });

  it('refuses a link to a kill criterion that does not exist — it looks monitored and is not', () => {
    const dangling = goodPremortem();
    dangling[0] = entry({ killCriterionMetric: 'a_metric_nobody_measures' });
    const r = assertPremortemComplete(decision, dangling);
    expect(r.ok).toBe(false);
    expect(r.rejections.map((x) => x.code)).toContain('unknown_kill_criterion');
  });
});

describe('which predicted failures nobody is watching for', () => {
  it('reports entries with no kill criterion rather than refusing them', () => {
    const r = assertPremortemComplete(decision, goodPremortem());
    expect(r.ok).toBe(true);
    expect(r.report.unmonitored).toEqual(['The classifier mislabels plumbing as handyman']);
  });

  it('reports the mirror gap: kill criteria no failure mode predicts', () => {
    const r = assertPremortemComplete(decision, goodPremortem());
    expect(r.report.unpredicted).toEqual(['refund_rate']);
  });

  it('counts endogenous and exogenous separately', () => {
    const r = assertPremortemComplete(decision, goodPremortem());
    expect(r.report.endogenous).toBe(2);
    expect(r.report.exogenous).toBe(1);
  });
});

/* ── debrief ──────────────────────────────────────────────────────────────── */

const decided = {
  id: 'DEC-2026-001',
  predictions: ['11111111-1111-4111-8111-111111111111'],
};

const actual = (over: Partial<ActualOutcome> = {}): ActualOutcome => ({
  result: 'bad',
  evidence: 'digest opens fell to 11% and two taskers asked to be unsubscribed',
  predictions: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      claim: 'digest open rate is above 30% on 2026-11-01',
      p: 0.6,
      outcome: 0,
    },
  ],
  occurred: [
    {
      what: 'taskers stopped opening the daily digest entirely',
      foreseenAs: null,
      earlyIndicatorSeen: true,
    },
  ],
  assumptionsAtDecisionTime: ['taskers read email in the morning'],
  brokenAssumptions: [
    'taskers read email in the morning',
    'email is how taskers want to be reached',
  ],
  process: {
    sound: true,
    reasoning: 'we chose the send time from a 40-person survey, which was the best data we had',
    luckAttribution: 'process',
  },
  whatWouldChangeNextTime: ['instrument opens before choosing a send time, not after'],
  ...over,
});

describe('the debrief refuses to become a story', () => {
  it('refuses one that references no prior prediction', () => {
    const r = debrief(decided, actual({ predictions: [] }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('no_prior_prediction');
  });

  it('refuses a prediction the decision never made', () => {
    const r = debrief(
      decided,
      actual({
        predictions: [
          {
            id: '99999999-9999-4999-8999-999999999999',
            claim: 'invented after the fact',
            p: 0.9,
            outcome: 1,
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('unknown_prediction');
  });

  it('refuses to let the process verdict be the outcome restated', () => {
    // Resulting: "the process was bad because we lost". That reasoning teaches
    // nothing and un-teaches good bets.
    const collapsed = actual({
      process: {
        sound: false,
        reasoning: 'digest opens fell to 11% and two taskers asked to be unsubscribed',
        luckAttribution: 'process',
      },
    });
    const r = debrief(decided, collapsed);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('collapsed_process_and_outcome');
  });

  it('records a bad outcome from a sound process as exactly that', () => {
    const r = debrief(decided, actual());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.debrief.luckAttribution.outcome).toBe('bad');
    expect(r.debrief.luckAttribution.processSound).toBe(true);
    expect(r.debrief.luckAttribution.resultingRisk).toBe(false);
  });

  it('flags the comfortable case where the process verdict tracks the outcome', () => {
    const r = debrief(
      decided,
      actual({
        process: {
          sound: false,
          reasoning: 'we never wrote down how we would know the send time was wrong',
          luckAttribution: 'process',
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.debrief.luckAttribution.resultingRisk).toBe(true);
  });

  it('refuses a debrief with nothing to change', () => {
    const r = debrief(decided, actual({ whatWouldChangeNextTime: [] }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('no_lesson');
  });
});

describe('the debrief against the pre-mortem', () => {
  it('flags loudly a failure mode the pre-mortem predicted and we shipped anyway', () => {
    const r = debrief(decided, actual(), { premortem: goodPremortem() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hit = r.debrief.foreseen.find((f) =>
      f.failureMode.startsWith('Taskers stop opening the daily digest'),
    );
    expect(hit).toBeDefined();
    expect(hit!.citedByAuthor).toBe(false);
    expect(hit!.indicatorObserved).toBe(true);
    expect(r.debrief.headline).toMatch(/WE PREDICTED THIS/);
    expect(r.debrief.headline).toMatch(/not cited/);
  });

  it('honours an explicit citation', () => {
    const cited = actual({
      occurred: [
        {
          what: 'nobody opened it',
          foreseenAs: 'Taskers stop opening the daily digest',
          earlyIndicatorSeen: false,
        },
      ],
    });
    const r = debrief(decided, cited, { premortem: goodPremortem() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.debrief.foreseen).toHaveLength(1);
    expect(r.debrief.foreseen[0]!.citedByAuthor).toBe(true);
  });

  it('says so plainly when nothing we predicted happened', () => {
    const surprise = actual({
      occurred: [
        { what: 'stripe changed its payout schedule', foreseenAs: null, earlyIndicatorSeen: null },
      ],
    });
    const r = debrief(decided, surprise, { premortem: goodPremortem() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.debrief.foreseen).toHaveLength(0);
    expect(r.debrief.headline).not.toMatch(/WE PREDICTED THIS/);
  });

  it('separates assumptions we had written down from ones we only found by breaking', () => {
    const r = debrief(decided, actual(), { premortem: goodPremortem() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.debrief.whichAssumptionsBroke.stated).toEqual(['taskers read email in the morning']);
    expect(r.debrief.whichAssumptionsBroke.unstated).toEqual([
      'email is how taskers want to be reached',
    ]);
  });

  it('carries the prior forecast forward verbatim so the comparison is checkable', () => {
    const r = debrief(decided, actual(), { premortem: goodPremortem() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.debrief.whatWePredicted.some((p) => p.includes('0.6'))).toBe(true);
    expect(r.debrief.whatHappened.length).toBeGreaterThan(0);
  });
});
