import { describe, it, expect } from 'vitest';
import { playbookRunSchema } from '@tmos/contracts';
import type { Playbook } from '@tmos/contracts';
import {
  correctRun,
  createMemoryRunStore,
  effectiveRuns,
  recordRunOutcome,
  runsFor,
  startRun,
  toPlaybookRun,
} from './ledger.js';
import type { LedgerRun, RunPrediction } from './ledger.js';

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const RUN_C = '33333333-3333-4333-8333-333333333333';

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

const prediction = (over: Partial<RunPrediction> = {}): RunPrediction => ({
  metric: 'reply_rate_pct',
  point: 8,
  ci80: [5, 12],
  recorded_at: at(0),
  ...over,
});

const started = async (over: { playbook?: Playbook; runId?: string; now?: string } = {}) => {
  const store = createMemoryRunStore();
  const now = over.now ?? at(0);
  const res = await startRun(over.playbook ?? pb(), { channel: 'email' }, prediction(), now, {
    store,
    runId: over.runId ?? RUN_A,
    situation: { region: 'ca' },
  });
  if (!res.ok) throw new Error(`fixture failed: ${res.rejection.code} ${res.rejection.detail}`);
  return { store, run: res.run };
};

describe('the prediction is written before the outcome, or there is no run', () => {
  it('writes the prediction with no outcome slot filled', async () => {
    const { run } = await started();
    expect(run.prediction?.point).toBe(8);
    expect(run.outcome).toBeNull();
    expect(run.falsifier?.due_at).toBe(at(30));
  });

  it('REFUSES an outcome on a run that carries no prediction', async () => {
    // Rows arrive from backfills and other writers, not only from startRun.
    // An outcome with nothing to be scored against is a story, not a result.
    const store = createMemoryRunStore();
    const orphan: LedgerRun = {
      run_id: RUN_B,
      playbook_id: 'pb_cold_outreach',
      playbook_version: 3,
      situation_snapshot: {},
      params_bound: {},
      prediction: null,
      falsifier: null,
      started_at: at(0),
      outcome: null,
      lessons: [],
      supersedes: null,
      correction_reason: null,
    };
    await store.put(orphan);
    const res = await recordRunOutcome(RUN_B, { metric_actual: 9, n: 40 }, at(40), { store });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('prediction_missing');
  });

  it('refuses a hypothesis that cannot be shown wrong, naming what is missing', async () => {
    const store = createMemoryRunStore();
    const vague = pb({
      hypothesis: { metric: 'reply_rate_pct', direction: 'up' } as Playbook['hypothesis'],
    });
    const res = await startRun(vague, {}, prediction(), at(0), { store, runId: RUN_A });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('prediction_not_falsifiable');
    expect(res.rejection.detail).toMatch(/expected_effect/);
    expect(res.rejection.detail).toMatch(/horizon_days/);
    expect(res.rejection.detail).toMatch(/min_n/);
  });

  it('refuses a prediction about a different metric than the hypothesis', async () => {
    const store = createMemoryRunStore();
    const res = await startRun(pb(), {}, prediction({ metric: 'open_rate_pct' }), at(0), {
      store,
      runId: RUN_A,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('prediction_not_falsifiable');
  });

  it('refuses a prediction recorded after the run started', async () => {
    const store = createMemoryRunStore();
    const res = await startRun(pb(), {}, prediction({ recorded_at: at(5) }), at(1), {
      store,
      runId: RUN_A,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('prediction_after_start');
  });

  it('refuses to start the same run twice', async () => {
    const { store } = await started();
    const res = await startRun(pb(), {}, prediction(), at(0), { store, runId: RUN_A });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('duplicate_run');
  });
});

describe('an outcome is written once', () => {
  it('refuses to overwrite an existing outcome', async () => {
    const { store } = await started();
    const first = await recordRunOutcome(RUN_A, { metric_actual: 9, n: 40 }, at(40), { store });
    expect(first.ok).toBe(true);
    const second = await recordRunOutcome(RUN_A, { metric_actual: 20, n: 40 }, at(41), { store });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.rejection.code).toBe('outcome_exists');
    expect(second.rejection.detail).toMatch(/correct/i);
  });

  it('corrects by appending a new row that supersedes the old one', async () => {
    const { store } = await started();
    await recordRunOutcome(RUN_A, { metric_actual: 9, n: 40 }, at(40), { store });
    const fixed = await correctRun(
      RUN_A,
      { reason: 'analytics double-counted replies', outcome: { metric_actual: 2, n: 40 } },
      at(50),
      { store, runId: RUN_C },
    );
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(fixed.run.supersedes).toBe(RUN_A);
    expect(fixed.run.outcome?.classification).toBe('loss');

    const original = await store.get(RUN_A);
    expect(original?.outcome?.metric_actual).toBe(9); // untouched: append-only
    const all = await store.byPlaybook('pb_cold_outreach');
    expect(all).toHaveLength(2);
    expect(effectiveRuns(all).map((r) => r.run_id)).toEqual([RUN_C]);
  });

  it('refuses a correction with no stated reason', async () => {
    const { store } = await started();
    await recordRunOutcome(RUN_A, { metric_actual: 9, n: 40 }, at(40), { store });
    const res = await correctRun(
      RUN_A,
      { reason: '  ', outcome: { metric_actual: 2, n: 40 } },
      at(50),
      { store, runId: RUN_C },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('correction_needs_reason');
  });
});

describe('the horizon is not a suggestion', () => {
  it('refuses an outcome read before the horizon has elapsed', async () => {
    const { store } = await started();
    const res = await recordRunOutcome(RUN_A, { metric_actual: 9, n: 40 }, at(3), { store });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('before_horizon');
    expect(res.rejection.detail).toMatch(/27/); // days still to run
  });

  it('allows an early read only with a stated reason, and records that it was forced', async () => {
    const { store } = await started();
    const res = await recordRunOutcome(
      RUN_A,
      { metric_actual: 9, n: 40, force: { reason: 'campaign cancelled by the client' } },
      at(3),
      { store },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.run.outcome?.forced).toEqual({
      reason: 'campaign cancelled by the client',
      days_early: 27,
    });
  });

  it('refuses a force with an empty reason — a boolean is not a reason', async () => {
    const { store } = await started();
    const res = await recordRunOutcome(
      RUN_A,
      { metric_actual: 9, n: 40, force: { reason: '' } },
      at(3),
      { store },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('before_horizon');
  });
});

describe('the verdict is derived from the frozen hypothesis, never asserted', () => {
  const outcomeOf = async (input: { metric_actual: number | null; n: number }, book = pb()) => {
    const { store } = await started({ playbook: book });
    const res = await recordRunOutcome(RUN_A, input, at(40), { store });
    if (!res.ok) throw new Error(res.rejection.detail);
    return res.run.outcome!;
  };

  it('counts reaching the low end of the pre-registered band as a win', async () => {
    expect((await outcomeOf({ metric_actual: 5, n: 40 })).classification).toBe('win');
    expect((await outcomeOf({ metric_actual: 30, n: 40 })).classification).toBe('win');
  });

  it('counts falling short of it as a loss', async () => {
    expect((await outcomeOf({ metric_actual: 4.9, n: 40 })).classification).toBe('loss');
    expect((await outcomeOf({ metric_actual: -8, n: 40 })).classification).toBe('loss');
  });

  it('reads the band in the hypothesised direction', async () => {
    const down = pb({
      hypothesis: {
        metric: 'reply_rate_pct',
        direction: 'down',
        expected_effect: [5, 12],
        horizon_days: 30,
        min_n: 10,
      },
    });
    expect((await outcomeOf({ metric_actual: -7, n: 40 }, down)).classification).toBe('win');
    expect((await outcomeOf({ metric_actual: 7, n: 40 }, down)).classification).toBe('loss');
  });

  it('marks an unmeasurable run inconclusive rather than guessing', async () => {
    expect((await outcomeOf({ metric_actual: null, n: 40 })).classification).toBe('inconclusive');
  });

  it('records an abort as its own thing', async () => {
    const { store } = await started();
    const res = await recordRunOutcome(
      RUN_A,
      { metric_actual: null, n: 0, aborted: { reason: 'budget pulled' } },
      at(40),
      { store },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.run.outcome?.classification).toBe('aborted');
  });

  it('refuses a measurement with a nonsense n', async () => {
    const { store } = await started();
    const res = await recordRunOutcome(RUN_A, { metric_actual: 9, n: -3 }, at(40), { store });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('invalid_measurement');
  });
});

describe('an underpowered result is not a result', () => {
  it('classifies n below min_n as underpowered — neither win nor loss', async () => {
    const { store } = await started();
    const res = await recordRunOutcome(RUN_A, { metric_actual: 40, n: 2 }, at(40), { store });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const outcome = res.run.outcome!;
    expect(outcome.classification).toBe('underpowered');
    expect(outcome.classification).not.toBe('win');
    expect(outcome.classification).not.toBe('loss');
    // The reason survives the projection into the contract shape, which has no
    // `underpowered` verdict of its own.
    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.confounds.join(' ')).toMatch(/underpowered: n=2 < min_n=10/);
  });
});

describe('the ledger pins the version and the bound params', () => {
  it('records the exact version and params used', async () => {
    const { run } = await started();
    expect(run.playbook_version).toBe(3);
    expect(run.params_bound).toEqual({ channel: 'email' });
    expect(run.situation_snapshot).toEqual({ region: 'ca' });
  });

  it('does not hand v3 runs to v4', async () => {
    const { store } = await started();
    await recordRunOutcome(RUN_A, { metric_actual: 9, n: 40 }, at(40), { store });
    const v4 = await startRun(pb({ version: 4 }), {}, prediction(), at(41), {
      store,
      runId: RUN_B,
    });
    expect(v4.ok).toBe(true);

    const all = await store.byPlaybook('pb_cold_outreach');
    expect(runsFor(all, 'pb_cold_outreach', 3).map((r) => r.run_id)).toEqual([RUN_A]);
    expect(runsFor(all, 'pb_cold_outreach', 4).map((r) => r.run_id)).toEqual([RUN_B]);
  });
});

describe('projection into the stored contract shape', () => {
  it('produces a row that satisfies playbookRunSchema', async () => {
    const { store } = await started();
    await recordRunOutcome(RUN_A, { metric_actual: 9, n: 40 }, at(40), { store });
    const row = toPlaybookRun((await store.get(RUN_A))!);
    expect(row).not.toBeNull();
    expect(playbookRunSchema.safeParse(row).success).toBe(true);
  });

  it('refuses to project a run with no prediction', () => {
    const orphan: LedgerRun = {
      run_id: RUN_B,
      playbook_id: 'pb_x',
      playbook_version: 1,
      situation_snapshot: {},
      params_bound: {},
      prediction: null,
      falsifier: null,
      started_at: at(0),
      outcome: null,
      lessons: [],
      supersedes: null,
      correction_reason: null,
    };
    expect(toPlaybookRun(orphan)).toBeNull();
  });
});

describe('refusals name what is missing', () => {
  it('says so when the run does not exist', async () => {
    const store = createMemoryRunStore();
    const res = await recordRunOutcome(RUN_A, { metric_actual: 1, n: 40 }, at(40), { store });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('not_found');
  });

  it('refuses a correction of a run that does not exist', async () => {
    const store = createMemoryRunStore();
    const res = await correctRun(
      RUN_A,
      { reason: 'typo', outcome: { metric_actual: 1, n: 40 } },
      at(40),
      { store, runId: RUN_C },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejection.code).toBe('not_found');
  });
});
