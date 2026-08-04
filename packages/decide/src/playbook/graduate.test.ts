import { describe, it, expect } from 'vitest';
import type { Playbook } from '@tmos/contracts';
import type { LedgerRun, RunClassification } from './ledger.js';
import { DEFAULT_GRADUATION, DEMOTION_LOWER_BOUND, graduate, playbookScore } from './graduate.js';
import type { GraduationInput } from './graduate.js';

const DAY = 86_400_000;
const at = (day: number): string => new Date(Date.UTC(2026, 0, 1) + day * DAY).toISOString();

const pb = (over: Partial<Playbook> = {}): Playbook => ({
  id: 'pb_cold_outreach',
  version: 3,
  title: 'Cold outreach',
  intent: 'book demos',
  status: 'candidate',
  applies_when: [],
  excludes_when: [],
  params: {},
  steps: [{ n: 1, do: 'send', owner: 'agent' }],
  hypothesis: {
    metric: 'reply_rate_pct',
    direction: 'up',
    expected_effect: [5, 12],
    horizon_days: 30,
    min_n: 10,
  },
  kill_criteria: [{ field: 'reply_rate_pct', op: '<', value: 1 }],
  assumptions: [],
  decay_after_days: 180,
  ...over,
});

let seq = 0;
const mkRun = (
  classification: RunClassification,
  cluster: string,
  day: number,
  over: Partial<LedgerRun> = {},
): LedgerRun => {
  seq += 1;
  return {
    run_id: `run_${String(seq).padStart(3, '0')}`,
    playbook_id: 'pb_cold_outreach',
    playbook_version: 3,
    situation_snapshot: { cluster },
    params_bound: {},
    prediction: { metric: 'reply_rate_pct', point: 8, ci80: [5, 12], recorded_at: at(day - 30) },
    falsifier: {
      metric: 'reply_rate_pct',
      direction: 'up',
      expected_effect: [5, 12],
      horizon_days: 30,
      min_n: 10,
      due_at: at(day),
    },
    started_at: at(day - 30),
    outcome: {
      metric_actual: classification === 'win' ? 9 : 1,
      n: classification === 'underpowered' ? 2 : 40,
      classification,
      verdict:
        classification === 'win' ? 'win' : classification === 'loss' ? 'loss' : 'inconclusive',
      measured_at: at(day),
      confounds: [],
      forced: null,
    },
    lessons: [],
    supersedes: null,
    correction_reason: null,
    ...over,
  };
};

const clusterOf = (r: LedgerRun): string => String(r.situation_snapshot['cluster'] ?? 'unknown');

const evaluate = (over: Partial<GraduationInput> & { runs: readonly LedgerRun[] }) =>
  graduate({ playbook: pb(), clusterOf, now: at(100), ...over });

/* ── the score ────────────────────────────────────────────────────────────── */

describe('score on the lower credible bound, never the mean', () => {
  it('does not let 1-for-1 outrank 12-for-15', () => {
    const thin = playbookScore(1, 0);
    const proven = playbookScore(12, 3);
    expect(thin).toBeLessThan(proven);
    // The mean is exactly the trap this avoids: 1.00 would beat 0.80.
    expect(thin).toBeCloseTo(0.224, 2);
    expect(proven).toBeCloseTo(0.583, 2);
  });

  it('rises with evidence, not just with the ratio', () => {
    expect(playbookScore(2, 0)).toBeLessThan(playbookScore(8, 0));
    expect(playbookScore(8, 0)).toBeLessThan(playbookScore(40, 0));
  });

  it('pins the demotion bar to the weakest record that could ever promote', () => {
    // 2 wins, 1 loss — the minimum graduating record. Promotion and demotion
    // therefore cannot both fire on the same evidence.
    expect(DEMOTION_LOWER_BOUND).toBeCloseTo(playbookScore(2, 1), 12);
    expect(DEMOTION_LOWER_BOUND).toBeCloseTo(0.249, 2);
  });
});

/* ── graduation ───────────────────────────────────────────────────────────── */

describe('proven is earned, and the cluster rule is what earns it', () => {
  it('refuses to graduate three wins that are all in the same cluster', () => {
    const v = evaluate({
      runs: [
        mkRun('win', 'gta_plumbing', 10),
        mkRun('win', 'gta_plumbing', 20),
        mkRun('win', 'gta_plumbing', 30),
      ],
    });
    expect(v.to).toBe('candidate');
    expect(v.changed).toBe(false);
    expect(v.rule).toBe('single_cluster');
    expect(v.justification.clusters.winning).toEqual(['gta_plumbing']);
    expect(v.justification.narrative).toMatch(/same context/i);
  });

  it('graduates on 3 runs, 2 wins, and a win in a different cluster', () => {
    const v = evaluate({
      runs: [
        mkRun('win', 'gta_plumbing', 10),
        mkRun('loss', 'gta_plumbing', 20),
        mkRun('win', 'gta_cleaning', 30),
      ],
    });
    expect(v.from).toBe('candidate');
    expect(v.to).toBe('proven');
    expect(v.changed).toBe(true);
    expect(v.rule).toBe('graduated');
    expect(v.justification.wins).toBe(2);
    expect(v.justification.losses).toBe(1);
    expect(v.justification.clusters.winning).toEqual(['gta_cleaning', 'gta_plumbing']);
  });

  it('holds when there are too few runs, and says so', () => {
    const v = evaluate({ runs: [mkRun('win', 'a', 10), mkRun('win', 'b', 20)] });
    expect(v.rule).toBe('insufficient_runs');
    expect(v.changed).toBe(false);
  });

  it('holds when there are runs but not enough wins', () => {
    const v = evaluate({
      runs: [mkRun('win', 'a', 10), mkRun('loss', 'b', 20), mkRun('loss', 'c', 30)],
    });
    expect(v.rule).toBe('insufficient_wins');
  });

  it('does not re-fire on the evidence that just promoted it', () => {
    // The freshly-promoted record sits exactly ON the demotion bar, not below
    // it, so the status cannot oscillate without new evidence.
    const runs = [
      mkRun('win', 'gta_plumbing', 10),
      mkRun('loss', 'gta_plumbing', 20),
      mkRun('win', 'gta_cleaning', 30),
    ];
    const v = evaluate({ playbook: pb({ status: 'proven' }), runs });
    expect(v.to).toBe('proven');
    expect(v.changed).toBe(false);
    expect(v.rule).toBe('holding');
  });
});

/* ── underpowered ─────────────────────────────────────────────────────────── */

describe('an underpowered run is evidence about measurability, not about effect', () => {
  it('counts toward neither wins nor losses', () => {
    const v = evaluate({
      runs: [
        mkRun('win', 'a', 10),
        mkRun('loss', 'b', 20),
        mkRun('win', 'b', 30),
        mkRun('underpowered', 'c', 40),
        mkRun('underpowered', 'd', 50),
      ],
    });
    expect(v.rule).toBe('graduated');
    expect(v.justification.wins).toBe(2);
    expect(v.justification.losses).toBe(1);
    expect(v.justification.conclusive).toBe(3);
    expect(v.justification.posterior).toEqual({ alpha: 3, beta: 2 });
  });

  it('does not let underpowered runs stand in for the run count', () => {
    const v = evaluate({
      runs: [
        mkRun('win', 'a', 10),
        mkRun('win', 'b', 20),
        mkRun('underpowered', 'c', 30),
        mkRun('underpowered', 'd', 40),
      ],
    });
    expect(v.rule).toBe('insufficient_runs');
  });

  it('surfaces a playbook nobody can conclusively measure as its own problem', () => {
    const v = evaluate({
      runs: [
        mkRun('win', 'a', 10),
        mkRun('underpowered', 'b', 20),
        mkRun('underpowered', 'c', 30),
        mkRun('underpowered', 'd', 40),
        mkRun('inconclusive', 'e', 50),
      ],
    });
    expect(v.justification.evaluability.underpowered).toBe(3);
    expect(v.justification.evaluability.hard_to_evaluate).toBe(true);
    expect(v.justification.narrative).toMatch(/hard to evaluate/i);
    expect(v.justification.inconclusive).toBe(1);
  });
});

/* ── auto-retirement ──────────────────────────────────────────────────────── */

describe('a status that can only go up is a ratchet', () => {
  it('demotes a proven playbook whose recent record no longer supports it', () => {
    const runs = [
      mkRun('win', 'a', 10),
      ...[20, 30, 40, 50, 60, 70, 80].map((d) => mkRun('loss', 'a', d)),
    ];
    const v = evaluate({ playbook: pb({ status: 'proven' }), runs });
    expect(v.from).toBe('proven');
    expect(v.to).toBe('candidate');
    expect(v.changed).toBe(true);
    expect(v.rule).toBe('deteriorated');
    expect(v.justification.recent.lower_bound).toBeLessThan(DEMOTION_LOWER_BOUND);
    expect(v.justification.narrative).toMatch(/deteriorated/);
  });

  it('retires it outright when the recent window holds no wins at all', () => {
    const runs = [10, 20, 30, 40, 50].map((d) => mkRun('loss', 'a', d));
    const v = evaluate({ playbook: pb({ status: 'proven' }), runs, now: at(60) });
    expect(v.to).toBe('retired');
    expect(v.rule).toBe('no_recent_wins');
    expect(v.justification.recent.wins).toBe(0);
    expect(v.justification.recent.losses).toBe(5);
  });

  it('does not demote on a single loss — one loss is what a good playbook does routinely', () => {
    const runs = [
      mkRun('win', 'a', 10),
      mkRun('win', 'b', 20),
      mkRun('win', 'a', 30),
      mkRun('loss', 'b', 40),
    ];
    const v = evaluate({ playbook: pb({ status: 'proven' }), runs });
    expect(v.to).toBe('proven');
    expect(v.rule).toBe('holding');
  });

  it('retires on decay when nothing has succeeded inside decay_after_days', () => {
    const runs = [mkRun('win', 'a', 5), mkRun('loss', 'b', 8), mkRun('win', 'b', 10)];
    const v = evaluate({ playbook: pb({ status: 'proven' }), runs, now: at(300) });
    expect(v.to).toBe('retired');
    expect(v.rule).toBe('decayed');
    expect(v.justification.days_since_last_win).toBe(290);
    expect(v.justification.narrative).toMatch(/180/);
  });

  it('treats retirement as terminal — revival is a version bump, not a status flip', () => {
    const runs = [mkRun('win', 'a', 10), mkRun('win', 'b', 20), mkRun('win', 'c', 30)];
    const v = evaluate({ playbook: pb({ status: 'retired' }), runs });
    expect(v.to).toBe('retired');
    expect(v.changed).toBe(false);
    expect(v.rule).toBe('retired_is_terminal');
  });
});

/* ── evidence is per version ──────────────────────────────────────────────── */

describe('v3 does not vindicate v4', () => {
  it('starts a new version with an empty record and says where the other runs went', () => {
    const runs = [
      mkRun('win', 'gta_plumbing', 10),
      mkRun('loss', 'gta_plumbing', 20),
      mkRun('win', 'gta_cleaning', 30),
    ];
    expect(evaluate({ runs }).rule).toBe('graduated');

    const v4 = evaluate({ playbook: pb({ version: 4 }), runs });
    expect(v4.rule).toBe('insufficient_runs');
    expect(v4.to).toBe('candidate');
    expect(v4.justification.wins).toBe(0);
    expect(v4.justification.other_version_runs).toBe(3);
    expect(v4.justification.narrative).toMatch(/other version/i);
  });

  it('ignores runs a correction superseded', () => {
    const bad = mkRun('win', 'gta_plumbing', 10);
    const fixed = mkRun('loss', 'gta_plumbing', 12, { supersedes: bad.run_id });
    const v = evaluate({ runs: [bad, fixed, mkRun('win', 'gta_cleaning', 30)] });
    expect(v.justification.wins).toBe(1);
    expect(v.justification.losses).toBe(1);
    expect(v.rule).toBe('insufficient_runs');
  });
});

/* ── the justification ────────────────────────────────────────────────────── */

describe('no status changes without a visible reason', () => {
  const scenarios: Array<{ name: string; input: Parameters<typeof evaluate>[0] }> = [
    {
      name: 'graduated',
      input: {
        runs: [mkRun('win', 'a', 10), mkRun('loss', 'b', 20), mkRun('win', 'b', 30)],
      },
    },
    {
      name: 'deteriorated',
      input: {
        playbook: pb({ status: 'proven' }),
        runs: [mkRun('win', 'a', 10), mkRun('loss', 'a', 20), mkRun('loss', 'a', 30)],
      },
    },
    {
      name: 'no_recent_wins',
      input: {
        playbook: pb({ status: 'proven' }),
        runs: [10, 20, 30, 40].map((d) => mkRun('loss', 'a', d)),
      },
    },
    {
      name: 'decayed',
      input: {
        playbook: pb({ status: 'proven' }),
        runs: [mkRun('win', 'a', 5), mkRun('win', 'b', 10), mkRun('loss', 'b', 12)],
        now: at(400),
      },
    },
  ];

  for (const { name, input } of scenarios) {
    it(`carries counts, bound, clusters and the rule for ${name}`, () => {
      const v = evaluate(input);
      expect(v.changed).toBe(true);
      expect(v.rule).toBe(name);
      const j = v.justification;
      expect(j.narrative).toContain(name);
      expect(j.narrative).toContain(v.from);
      expect(j.narrative).toContain(v.to);
      expect(Number.isFinite(j.lower_bound)).toBe(true);
      expect(j.posterior.alpha).toBeGreaterThan(0);
      expect(Array.isArray(j.clusters.all)).toBe(true);
      expect(j.conclusive).toBe(j.wins + j.losses);
    });
  }

  it('counts forced early reads so a record built on peeks is visible', () => {
    const forced = mkRun('win', 'b', 30);
    forced.outcome!.forced = { reason: 'client cancelled', days_early: 20 };
    const v = evaluate({ runs: [mkRun('win', 'a', 10), mkRun('loss', 'a', 20), forced] });
    expect(v.justification.forced_reads).toBe(1);
    expect(v.justification.narrative).toMatch(/1 forced/);
  });
});

describe('determinism', () => {
  it('gives the same verdict whatever order the runs arrive in', () => {
    const runs = [
      mkRun('win', 'a', 10),
      mkRun('loss', 'b', 20),
      mkRun('win', 'b', 30),
      mkRun('underpowered', 'c', 40),
    ];
    const forward = evaluate({ runs });
    const backward = evaluate({ runs: [...runs].reverse() });
    expect(backward).toEqual(forward);
  });

  it('exposes the configuration it applied', () => {
    expect(DEFAULT_GRADUATION.minRuns).toBe(3);
    expect(DEFAULT_GRADUATION.minWins).toBe(2);
    expect(DEFAULT_GRADUATION.minWinningClusters).toBe(2);
    expect(DEFAULT_GRADUATION.recentWindow).toBe(8);
    expect(DEFAULT_GRADUATION.retireLossStreak).toBe(4);
  });

  it('takes an override without mutating the default', () => {
    const v = evaluate({
      runs: [mkRun('win', 'a', 10), mkRun('win', 'a', 20), mkRun('win', 'a', 30)],
      config: { minWinningClusters: 1 },
    });
    expect(v.rule).toBe('graduated');
    expect(DEFAULT_GRADUATION.minWinningClusters).toBe(2);
  });
});
