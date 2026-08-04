import { describe, it, expect } from 'vitest';
import {
  writeDecision,
  recordDecisionOutcome,
  createMemoryDecisionStore,
  goodProcessBadOutcome,
  badProcessGoodOutcome,
} from './store.js';
import type { PredictionFacts, WriteDeps } from './store.js';
import type { DecisionRecord } from '@tmos/contracts';

const NOW = '2026-08-05T00:00:00.000Z';

const OPEN: PredictionFacts = {
  exists: true,
  resolved: false,
  recordedAt: '2026-08-01T00:00:00.000Z',
};

const deps = (over: Partial<WriteDeps> = {}): WriteDeps => ({
  store: createMemoryDecisionStore(),
  predictionFacts: async () => OPEN,
  now: NOW,
  ...over,
});

const decision = (over: Partial<DecisionRecord> = {}): unknown => ({
  id: 'DEC-2026-001',
  status: 'proposed',
  door: 'two_way',
  context: 'Jiffy raised prices 12% in the GTA.',
  decision: 'Hold our price and lead on the held-by-Taskly mechanic.',
  alternatives: [
    { option: 'Match the increase', why_rejected: 'gives up the only visible price advantage' },
    {
      option: 'Do nothing and say nothing',
      why_rejected: 'wastes a moment when posters are comparing',
    },
  ],
  beliefs_relied_on: [],
  predictions: ['11111111-1111-4111-8111-111111111111'],
  kill_criteria: [{ metric: 'weekly_posts', threshold: 40, by: '2026-09-30' }],
  expected_cost_cents: 0,
  decided_at: '2026-08-05T00:00:00.000Z',
  decided_by: 'human:nishant',
  outcome: null,
  ...over,
});

describe('a decision cannot be written without real alternatives', () => {
  it('accepts a well-formed record', async () => {
    const r = await writeDecision(decision(), deps());
    expect(r.ok).toBe(true);
  });

  it('refuses fewer than two alternatives (the schema constraint)', async () => {
    const r = await writeDecision(
      decision({
        alternatives: [{ option: 'Match it', why_rejected: 'no' }],
      } as Partial<DecisionRecord>),
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('schema');
  });

  it('refuses the same option written twice', async () => {
    // Two alternatives that are one option in different words are one
    // alternative. The schema counts; this checks.
    const r = await writeDecision(
      decision({
        alternatives: [
          { option: 'Match the increase', why_rejected: 'x' },
          { option: 'match the increase.', why_rejected: 'y' },
        ],
      } as Partial<DecisionRecord>),
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('duplicate_alternatives');
  });

  it('refuses listing the chosen course as its own alternative', async () => {
    const r = await writeDecision(
      decision({
        decision: 'Hold our price',
        alternatives: [
          { option: 'Hold our price', why_rejected: 'n/a' },
          { option: 'Match it', why_rejected: 'x' },
        ],
      } as Partial<DecisionRecord>),
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('alternative_is_the_decision');
  });
});

describe('a decision must cite a forecast that is still open', () => {
  it('refuses an already-resolved prediction', async () => {
    // Citing a prediction whose answer you already know is retroactive
    // justification wearing the costume of forecasting.
    const r = await writeDecision(
      decision(),
      deps({ predictionFacts: async () => ({ ...OPEN, resolved: true }) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('unresolved_prediction_required');
  });

  it('refuses a prediction recorded AFTER the decision', async () => {
    const r = await writeDecision(
      decision(),
      deps({ predictionFacts: async () => ({ ...OPEN, recordedAt: '2026-08-06T00:00:00.000Z' }) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.detail).toMatch(/after the decision/);
  });

  it('refuses a prediction that does not exist', async () => {
    const r = await writeDecision(decision(), deps({ predictionFacts: async () => null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('prediction_missing');
  });
});

describe('kill criteria must be able to fire', () => {
  it('refuses a kill date already in the past', async () => {
    const r = await writeDecision(
      decision({
        kill_criteria: [{ metric: 'weekly_posts', threshold: 40, by: '2026-01-01' }],
      } as Partial<DecisionRecord>),
      deps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('kill_criteria_in_the_past');
  });
});

describe('an accepted decision is history, not a draft', () => {
  it('refuses to rewrite one that is no longer proposed', async () => {
    const store = createMemoryDecisionStore();
    const d = deps({ store });
    await writeDecision(decision({ status: 'accepted' } as Partial<DecisionRecord>), d);
    const again = await writeDecision(
      decision({ status: 'accepted', decision: 'Actually, match it' } as Partial<DecisionRecord>),
      d,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.rejection.code).toBe('immutable');
  });

  it('allows editing while still proposed', async () => {
    const store = createMemoryDecisionStore();
    const d = deps({ store });
    await writeDecision(decision(), d);
    expect(
      (await writeDecision(decision({ context: 'revised' } as Partial<DecisionRecord>), d)).ok,
    ).toBe(true);
  });
});

describe('the anti-resulting query', () => {
  it('keeps good process with a bad outcome distinguishable from a mistake', async () => {
    // In a system that tracks only outcomes these look identical, and the
    // lesson learned is the wrong one: you stop making a good bet because it
    // lost once.
    const store = createMemoryDecisionStore();
    const d = deps({ store });
    await writeDecision(decision(), d);
    await recordDecisionOutcome(
      'DEC-2026-001',
      { result: 'bad', luck_attribution: 'luck', notes: 'a competitor exited the week after' },
      { store },
    );
    const all = await store.all();
    expect(goodProcessBadOutcome(all)).toHaveLength(1);
    expect(badProcessGoodOutcome(all)).toHaveLength(0);
  });

  it('flags the more dangerous case: it worked and we do not know why', async () => {
    const store = createMemoryDecisionStore();
    const d = deps({ store });
    await writeDecision(decision(), d);
    await recordDecisionOutcome(
      'DEC-2026-001',
      {
        result: 'good',
        luck_attribution: 'luck',
        notes: 'the market moved our way for unrelated reasons',
      },
      { store },
    );
    expect(badProcessGoodOutcome(await store.all())).toHaveLength(1);
  });

  it('refuses an outcome on a decision that does not exist', async () => {
    const store = createMemoryDecisionStore();
    const r = await recordDecisionOutcome(
      'DEC-2026-999',
      { result: 'good', luck_attribution: 'process', notes: '' },
      { store },
    );
    expect(r.ok).toBe(false);
  });
});
