/**
 * The `DecisionStore` and `PlaybookRunStore` conformance suites — the definition
 * of "substitutable" for the decide lane.
 *
 * Cases are DATA, not tests: a name and an async function taking `(store,
 * fixtures)`, asserting with `node:assert/strict` so nothing in `src/` imports a
 * test framework. `decide.conformance.test.ts` runs them against
 * `createMemoryDecisionStore` / `createMemoryRunStore` with no database at all;
 * `pg/*.live.test.ts` runs the same arrays against Postgres inside a
 * transaction it rolls back. When the two disagree, one of them is wrong and
 * the diff is one line of output.
 *
 * WHAT IS DELIBERATELY NOT IN HERE, because the two stores genuinely differ and
 * a shared case would have to assert one of them is wrong:
 *
 *   · `put` with an EMPTY `predictions` array, or with fewer than two
 *     alternatives. Memory accepts both (it is a `Map.set`); Postgres refuses
 *     both (`decision_needs_prediction` / `decision_needs_alternatives`). Those
 *     live in `decision-store.live.test.ts`.
 *   · `put` of a run that has an outcome and no prediction. Memory accepts it;
 *     `playbook_run_outcome_needs_prediction` does not. Same treatment.
 *   · any assertion that `all()` is exactly N rows. A live database has rows in
 *     it that this suite did not write, so `all()` is asserted to CONTAIN what
 *     was written, in the right relative order, and to exclude what was not.
 *
 * `fixtures` is the seam. `DecisionStoreFixtures.predictionFacts` is the
 * interesting half: in memory it is a canned map, and against Postgres it is
 * `predictionFactsFor` reading real `prediction` rows — so the four cases that
 * drive `writeDecision` exercise the whole refusal path, which is where the
 * decision record's value actually lives.
 */
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';

import type { DecisionRecord, Playbook } from '@tmos/contracts';
import {
  correctRun,
  recordDecisionOutcome,
  recordRunOutcome,
  startRun,
  writeDecision,
  type DecisionStore,
  type LedgerRun,
  type PlaybookRunStore,
  type PredictionFacts,
  type RunPrediction,
} from '@tmos/decide';

import { ABSENT_UUID, type ConformanceCase } from './conformance.js';

/* ── DecisionStore ────────────────────────────────────────────────────────── */

export interface DecisionStoreFixtures {
  /** Predictions that exist, are still open, and were recorded BEFORE `DECIDED_AT`. */
  readonly openPredictionIds: readonly [string, string];
  /** Exists, already resolved. Citing it is retroactive justification. */
  readonly resolvedPredictionId: string;
  /** Exists, but was recorded AFTER `DECIDED_AT` — it cannot have informed it. */
  readonly latePredictionId: string;
  /** `beliefs_relied_on` is `uuid[]` with no FK in either store; shaped as uuids
   *  anyway so the same values exercise the Postgres `::uuid[]` cast. */
  readonly beliefIds: readonly string[];
  /** `WriteDeps.predictionFacts`, resolved against whatever backs this run. */
  readonly predictionFacts: (id: string) => Promise<PredictionFacts | null>;
}

export type DecisionStoreCase = ConformanceCase<DecisionStore, DecisionStoreFixtures>;

export const DECIDED_AT = '2026-08-01T00:00:00.000Z';
/** After `DECIDED_AT`, before every kill-criterion date below. */
export const DECISION_NOW = '2026-08-02T00:00:00.000Z';

const decision = (fx: DecisionStoreFixtures, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: 'DEC-9999-001',
  status: 'proposed',
  door: 'two_way',
  context: 'The operator list has stopped replying and nobody knows whether it is the list or us.',
  decision: 'Ship a weekly digest to the GTA operator list for eight weeks',
  alternatives: [
    { option: 'Do nothing', why_rejected: 'the list decays either way and we learn nothing' },
    { option: 'Buy a paid test first', why_rejected: 'costs more than the answer is worth' },
  ],
  beliefs_relied_on: [...fx.beliefIds],
  predictions: [fx.openPredictionIds[0]],
  kill_criteria: [{ metric: 'reply_rate', threshold: 0.02, by: '2027-03-01' }],
  expected_cost_cents: 250_000,
  decided_at: DECIDED_AT,
  decided_by: 'human:nishant',
  outcome: null,
  ...over,
});

const decisionIds = (rows: readonly DecisionRecord[]): string[] => rows.map((r) => r.id);

export const DECISION_STORE_CONFORMANCE: readonly DecisionStoreCase[] = [
  {
    name: 'put stores the record, and get reads it back identically',
    async run(store, fx) {
      const record = decision(fx);
      await store.put(record);
      deepStrictEqual(await store.get(record.id), record);
    },
  },

  {
    name: 'get returns null for an id nothing holds — well-formed or not',
    async run(store) {
      strictEqual(await store.get('DEC-9999-900'), null);
      // `decision_record.id` is `text`, so a malformed id is a MISS in both
      // stores. There is no uuid guard on this table and none is needed.
      strictEqual(await store.get('not-a-decision-id'), null);
    },
  },

  {
    name: 'all contains every record written, and excludes what was not',
    async run(store, fx) {
      const later = decision(fx, { id: 'DEC-9999-002', decided_at: '2026-08-05T00:00:00.000Z' });
      const earlier = decision(fx, { id: 'DEC-9999-003', decided_at: '2026-07-01T00:00:00.000Z' });
      await store.put(later);
      await store.put(earlier);

      // ORDER IS NOT ASSERTED, and that is a real divergence rather than
      // laziness: `createMemoryDecisionStore.all()` returns `Map` insertion
      // order and does not sort, while `decision_record` has no insertion
      // counter and the adapter orders by `decided_at, id`. The two disagree
      // whenever a decision is written out of chronological order — as here.
      // `createMemoryRunStore` DOES sort, which is why the ledger's `all()` can
      // be asserted in order and this one cannot. Compared as a set.
      const mine = decisionIds(await store.all())
        .filter((id) => [earlier.id, later.id].includes(id))
        .sort();
      deepStrictEqual(mine, [later.id, earlier.id].sort());
      ok(!decisionIds(await store.all()).includes('DEC-9999-900'));
    },
  },

  {
    name: 'a null outcome stays null, and an outcome round-trips through put',
    async run(store, fx) {
      const record = decision(fx);
      await store.put(record);
      strictEqual((await store.get(record.id))?.outcome, null);

      const updated = await recordDecisionOutcome(
        record.id,
        { result: 'bad', luck_attribution: 'luck', notes: 'the list was fine; the timing was not' },
        { store },
      );
      ok(updated.ok);
      deepStrictEqual((await store.get(record.id))?.outcome, {
        result: 'bad',
        luck_attribution: 'luck',
        notes: 'the list was fine; the timing was not',
      });
    },
  },

  {
    name: 'put overwrites in place — the store is a row sink, immutability lives above it',
    async run(store, fx) {
      const record = decision(fx);
      await store.put(record);
      await store.put({ ...record, status: 'accepted', decision: 'Ship it for four weeks' });

      const read = await store.get(record.id);
      strictEqual(read?.status, 'accepted');
      strictEqual(read.decision, 'Ship it for four weeks');
      strictEqual((await store.all()).filter((r) => r.id === record.id).length, 1);
    },
  },

  {
    name: 'expected_cost_cents survives the top of the safe integer range exactly',
    async run(store, fx) {
      // The column is `bigint` and node-postgres hands int8 back as a STRING.
      // 2^53 − 1 is the largest value `z.number().int()` admits and the largest
      // a JS number can hold without changing; one more is a wrong answer in a
      // money column, which is why the adapter decodes through BigInt.
      const record = decision(fx, { id: 'DEC-9999-004', expected_cost_cents: 9_007_199_254_740_991 });
      await store.put(record);
      strictEqual((await store.get(record.id))?.expected_cost_cents, 9_007_199_254_740_991);
    },
  },

  {
    name: 'empty uuid arrays round-trip as empty arrays, not as null',
    async run(store, fx) {
      const record = decision(fx, { id: 'DEC-9999-005', beliefs_relied_on: [] });
      await store.put(record);
      deepStrictEqual((await store.get(record.id))?.beliefs_relied_on, []);
      deepStrictEqual((await store.get(record.id))?.predictions, [fx.openPredictionIds[0]]);
    },
  },

  {
    name: 'the record handed back is a copy — mutating it does not reach the store',
    async run(store, fx) {
      const record = decision(fx);
      await store.put(record);

      const read = await store.get(record.id);
      ok(read !== null);
      read.status = 'reversed';
      read.alternatives.push({ option: 'invented later', why_rejected: 'never considered' });

      const again = await store.get(record.id);
      strictEqual(again?.status, 'proposed');
      strictEqual(again.alternatives.length, 2);
      notStrictEqual(again, read);
    },
  },

  /* ── the domain's own write rules, driven through the store ───────────── */

  {
    name: 'rule: a decision citing an open, earlier prediction is written',
    async run(store, fx) {
      const result = await writeDecision(decision(fx), {
        store,
        predictionFacts: fx.predictionFacts,
        now: DECISION_NOW,
      });

      ok(result.ok, result.ok ? '' : result.rejection.detail);
      strictEqual((await store.get('DEC-9999-001'))?.id, 'DEC-9999-001');
    },
  },

  {
    name: 'rule: citing an already-resolved prediction is refused',
    async run(store, fx) {
      const result = await writeDecision(
        decision(fx, { predictions: [fx.resolvedPredictionId] }),
        { store, predictionFacts: fx.predictionFacts, now: DECISION_NOW },
      );

      ok(!result.ok);
      strictEqual(result.rejection.code, 'unresolved_prediction_required');
      strictEqual(await store.get('DEC-9999-001'), null, 'a refused decision is not written');
    },
  },

  {
    name: 'rule: citing a prediction recorded after the decision is refused',
    async run(store, fx) {
      const result = await writeDecision(decision(fx, { predictions: [fx.latePredictionId] }), {
        store,
        predictionFacts: fx.predictionFacts,
        now: DECISION_NOW,
      });

      ok(!result.ok);
      strictEqual(result.rejection.code, 'unresolved_prediction_required');
    },
  },

  {
    name: 'rule: citing a prediction that does not exist is refused',
    async run(store, fx) {
      const result = await writeDecision(decision(fx, { predictions: [ABSENT_UUID] }), {
        store,
        predictionFacts: fx.predictionFacts,
        now: DECISION_NOW,
      });

      ok(!result.ok);
      strictEqual(result.rejection.code, 'prediction_missing');
    },
  },

  {
    name: 'rule: an accepted decision is not rewritten — it is superseded',
    async run(store, fx) {
      await store.put(decision(fx, { status: 'accepted' }));

      const result = await writeDecision(decision(fx, { decision: 'Actually, ship it monthly' }), {
        store,
        predictionFacts: fx.predictionFacts,
        now: DECISION_NOW,
      });

      ok(!result.ok);
      strictEqual(result.rejection.code, 'immutable');
      strictEqual(
        (await store.get('DEC-9999-001'))?.decision,
        'Ship a weekly digest to the GTA operator list for eight weeks',
      );
    },
  },
];

/* ── PlaybookRunStore ─────────────────────────────────────────────────────── */

export interface PlaybookRunFixtures {
  /** Must EXIST in `playbook` for the live run — `playbook_run` has a composite
   *  FK on `(playbook_id, playbook_version)`. The memory store has no FKs and
   *  only reads the object. */
  readonly playbook: Playbook;
  readonly otherPlaybook: Playbook;
}

export type PlaybookRunCase = ConformanceCase<PlaybookRunStore, PlaybookRunFixtures>;

/** `playbook_run.run_id` is a uuid; the memory store would take any string. */
export const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const RUN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const RUN_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const STARTED_AT = '2026-08-01T00:00:00.000Z';
/** `STARTED_AT` + the fixture playbook's 30-day horizon, to the millisecond. */
export const DUE_AT = '2026-08-31T00:00:00.000Z';
export const MEASURED_AT = '2026-09-05T00:00:00.000Z';

/** A valid `Playbook`, for a harness that needs to build one. */
export const conformancePlaybook = (id: string, version: number): Playbook => ({
  id,
  version,
  title: 'Weekly digest to the GTA operator list',
  intent: 'Lift reply rate without buying attention',
  status: 'candidate',
  applies_when: [{ field: 'region', op: '=', value: 'ca' }],
  excludes_when: [{ field: 'list_age_days', op: '<', value: 30 }],
  params: { budget_cents: { type: 'money_cents', required: true } },
  steps: [{ n: 1, do: "Draft this week's digest from the findings", owner: 'agent' }],
  hypothesis: {
    metric: 'reply_rate',
    direction: 'up',
    expected_effect: [2, 6],
    horizon_days: 30,
    min_n: 40,
  },
  kill_criteria: [{ field: 'unsubscribe_rate', op: '>', value: 0.02 }],
  assumptions: ['the list is warm enough to answer at all'],
  decay_after_days: 180,
});

const PREDICTION: RunPrediction = {
  metric: 'reply_rate',
  point: 4,
  ci80: [1, 8],
  recorded_at: STARTED_AT,
};

const run = (fx: PlaybookRunFixtures, over: Partial<LedgerRun> = {}): LedgerRun => ({
  run_id: RUN_A,
  playbook_id: fx.playbook.id,
  playbook_version: fx.playbook.version,
  situation_snapshot: { region: 'ca', list_age_days: 400 },
  params_bound: { budget_cents: 250_000 },
  prediction: { ...PREDICTION },
  falsifier: {
    metric: 'reply_rate',
    direction: 'up',
    expected_effect: [2, 6],
    horizon_days: 30,
    min_n: 40,
    due_at: DUE_AT,
  },
  started_at: STARTED_AT,
  outcome: null,
  lessons: [],
  supersedes: null,
  correction_reason: null,
  ...over,
});

const runIds = (rows: readonly LedgerRun[]): string[] => rows.map((r) => r.run_id);

export const PLAYBOOK_RUN_CONFORMANCE: readonly PlaybookRunCase[] = [
  {
    name: 'put stores the run, and get reads it back identically',
    async run(store, fx) {
      const row = run(fx);
      await store.put(row);
      deepStrictEqual(await store.get(RUN_A), row);
    },
  },

  {
    name: 'get returns null for a run id nothing holds — it does not throw',
    async run(store) {
      strictEqual(await store.get(ABSENT_UUID), null);
      // The memory store mints whatever id it is handed; `run_id` is a uuid, so
      // a non-uuid must MISS rather than raise 22P02.
      strictEqual(await store.get('run_1'), null);
    },
  },

  {
    name: 'an imported run with no prediction round-trips as null — and so does its falsifier',
    async run(store, fx) {
      const row = run(fx, { run_id: RUN_B, prediction: null, falsifier: null });
      await store.put(row);

      const read = await store.get(RUN_B);
      strictEqual(read?.prediction, null);
      strictEqual(read.falsifier, null);
    },
  },

  {
    name: 'the rich outcome round-trips whole — classification, n and forced included',
    async run(store, fx) {
      const row = run(fx, {
        outcome: {
          metric_actual: 4.5,
          n: 12,
          classification: 'underpowered',
          verdict: 'inconclusive',
          measured_at: MEASURED_AT,
          confounds: ['underpowered: n=12 < min_n=40', 'a competitor launched mid-window'],
          forced: { reason: 'the quarter ends Friday', days_early: 3 },
        },
        lessons: [
          { kind: 'dont', text: 'do not read a 30-day hypothesis at day 3' },
          { kind: 'precondition', text: 'the list must be older than 30 days' },
        ],
      });
      await store.put(row);
      deepStrictEqual(await store.get(RUN_A), row);
    },
  },

  {
    name: 'byPlaybook filters to one playbook and sorts by started_at then run_id',
    async run(store, fx) {
      await store.put(run(fx, { run_id: RUN_B, started_at: '2026-08-10T00:00:00.000Z' }));
      await store.put(run(fx, { run_id: RUN_A, started_at: '2026-08-02T00:00:00.000Z' }));
      await store.put(
        run(fx, {
          run_id: RUN_C,
          playbook_id: fx.otherPlaybook.id,
          playbook_version: fx.otherPlaybook.version,
        }),
      );

      deepStrictEqual(runIds(await store.byPlaybook(fx.playbook.id)), [RUN_A, RUN_B]);
      deepStrictEqual(runIds(await store.byPlaybook(fx.otherPlaybook.id)), [RUN_C]);
      deepStrictEqual(await store.byPlaybook('pb_nothing_here'), []);
    },
  },

  {
    name: 'all contains every run written, in started_at order, and excludes what was not',
    async run(store, fx) {
      await store.put(run(fx, { run_id: RUN_B, started_at: '2026-08-10T00:00:00.000Z' }));
      await store.put(run(fx, { run_id: RUN_A, started_at: '2026-08-02T00:00:00.000Z' }));

      const mine = runIds(await store.all()).filter((id) => [RUN_A, RUN_B].includes(id));
      deepStrictEqual(mine, [RUN_A, RUN_B]);
      ok(!runIds(await store.all()).includes(ABSENT_UUID));
    },
  },

  {
    name: 'the run handed back is a copy — mutating it does not reach the store',
    async run(store, fx) {
      await store.put(run(fx));

      const read = await store.get(RUN_A);
      ok(read !== null);
      read.correction_reason = 'invented afterwards';
      read.lessons.push({ kind: 'do', text: 'never written' });

      const again = await store.get(RUN_A);
      strictEqual(again?.correction_reason, null);
      strictEqual(again.lessons.length, 0);
      notStrictEqual(again, read);
    },
  },

  /* ── the ledger's own write rules, driven through the store ───────────── */

  {
    name: 'rule: startRun writes the prediction and the frozen falsifier, outcome empty',
    async run(store, fx) {
      const started = await startRun(
        fx.playbook,
        { budget_cents: 250_000 },
        { ...PREDICTION },
        STARTED_AT,
        { store, runId: RUN_A, situation: { region: 'ca' } },
      );
      ok(started.ok, started.ok ? '' : started.rejection.detail);

      const read = await store.get(RUN_A);
      deepStrictEqual(read?.prediction, PREDICTION);
      strictEqual(read.outcome, null, 'the outcome slot stays empty by design');
      // Copied, not referenced: a later edit to the playbook cannot move the bar.
      strictEqual(read.falsifier?.due_at, DUE_AT);
      strictEqual(read.falsifier.min_n, 40);
    },
  },

  {
    name: 'rule: recordRunOutcome derives the verdict from the frozen hypothesis',
    async run(store, fx) {
      await startRun(fx.playbook, {}, { ...PREDICTION }, STARTED_AT, { store, runId: RUN_A });

      const scored = await recordRunOutcome(RUN_A, { metric_actual: 4, n: 50 }, MEASURED_AT, {
        store,
      });
      ok(scored.ok, scored.ok ? '' : scored.rejection.detail);

      const read = await store.get(RUN_A);
      strictEqual(read?.outcome?.classification, 'win');
      strictEqual(read.outcome.verdict, 'win');
      strictEqual(read.outcome.n, 50);
      strictEqual(read.outcome.forced, null, 'measured after the horizon is not a peek');
    },
  },

  {
    name: 'rule: an underpowered result is recorded, not refused',
    async run(store, fx) {
      await startRun(fx.playbook, {}, { ...PREDICTION }, STARTED_AT, { store, runId: RUN_A });
      await recordRunOutcome(RUN_A, { metric_actual: 4, n: 3 }, MEASURED_AT, { store });

      const read = await store.get(RUN_A);
      strictEqual(read?.outcome?.classification, 'underpowered');
      strictEqual(read.outcome.verdict, 'inconclusive');
      ok(read.outcome.confounds.includes('underpowered: n=3 < min_n=40'));
    },
  },

  {
    name: 'rule: a second outcome is refused — the ledger is not editable history',
    async run(store, fx) {
      await startRun(fx.playbook, {}, { ...PREDICTION }, STARTED_AT, { store, runId: RUN_A });
      await recordRunOutcome(RUN_A, { metric_actual: 4, n: 50 }, MEASURED_AT, { store });

      const again = await recordRunOutcome(RUN_A, { metric_actual: 9, n: 50 }, MEASURED_AT, {
        store,
      });
      ok(!again.ok);
      strictEqual(again.rejection.code, 'outcome_exists');
      strictEqual((await store.get(RUN_A))?.outcome?.metric_actual, 4, 'must not have moved');
    },
  },

  {
    name: 'rule: a correction APPENDS a row and leaves the original untouched',
    async run(store, fx) {
      await startRun(fx.playbook, {}, { ...PREDICTION }, STARTED_AT, { store, runId: RUN_A });
      await recordRunOutcome(RUN_A, { metric_actual: 4, n: 50 }, MEASURED_AT, { store });

      const corrected = await correctRun(
        RUN_A,
        { reason: 'the analytics property double-counted replies', outcome: { metric_actual: 1, n: 50 } },
        MEASURED_AT,
        { store, runId: RUN_B },
      );
      ok(corrected.ok, corrected.ok ? '' : corrected.rejection.detail);

      const original = await store.get(RUN_A);
      strictEqual(original?.outcome?.metric_actual, 4, 'the superseded row is never edited');
      strictEqual(original.supersedes, null);

      const replacement = await store.get(RUN_B);
      strictEqual(replacement?.supersedes, RUN_A);
      strictEqual(replacement.correction_reason, 'the analytics property double-counted replies');
      strictEqual(replacement.outcome?.classification, 'loss');
    },
  },
];
