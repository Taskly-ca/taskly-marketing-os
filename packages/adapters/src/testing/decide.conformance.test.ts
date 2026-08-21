/**
 * The decide conformance suites against the IN-MEMORY stores.
 *
 * This file is half the proof. It is deterministic, keyless and runs in CI;
 * `pg/decision-store.live.test.ts` and `pg/playbook-store.live.test.ts` run the
 * identical arrays against Postgres. A case that passes here and fails there is
 * the finding — and until a `DATABASE_URL` exists, a green run here means only
 * that the assertions are self-consistent and that the memory stores still
 * behave the way the Postgres adapters were written to match.
 *
 * (It does not run inside `memory-conformance.test.ts` because that file wires
 * the world-lane suites and belongs to whoever owns the barrel. Same shape,
 * separate file.)
 */
import { describe, it } from 'vitest';
import { createMemoryDecisionStore, createMemoryRunStore, type PredictionFacts } from '@tmos/decide';

import {
  conformancePlaybook,
  DECIDED_AT,
  DECISION_STORE_CONFORMANCE,
  PLAYBOOK_RUN_CONFORMANCE,
  type DecisionStoreFixtures,
  type PlaybookRunFixtures,
} from './decide.conformance.js';

/**
 * Uuid-shaped even though the memory store would take any string: the same
 * fixture values then exercise the Postgres adapter's `::uuid[]` casts and its
 * id guards, so a case cannot accidentally depend on an id shape only one store
 * accepts.
 */
const OPEN_A = '11111111-1111-4111-8111-111111111111';
const OPEN_B = '22222222-2222-4222-8222-222222222222';
const RESOLVED = '33333333-3333-4333-8333-333333333333';
const LATE = '44444444-4444-4444-8444-444444444444';
const BELIEF = '55555555-5555-4555-8555-555555555555';

/** Recorded well before the decision — the only ordering `writeDecision` accepts. */
const BEFORE = '2026-07-20T00:00:00.000Z';
/** Recorded after `DECIDED_AT`, so it cannot have informed the decision. */
const AFTER = '2026-08-01T12:00:00.000Z';

const FACTS: Readonly<Record<string, PredictionFacts>> = {
  [OPEN_A]: { exists: true, resolved: false, recordedAt: BEFORE },
  [OPEN_B]: { exists: true, resolved: false, recordedAt: BEFORE },
  [RESOLVED]: { exists: true, resolved: true, recordedAt: BEFORE },
  [LATE]: { exists: true, resolved: false, recordedAt: AFTER },
};

const DECISION_FIXTURES: DecisionStoreFixtures = {
  openPredictionIds: [OPEN_A, OPEN_B],
  resolvedPredictionId: RESOLVED,
  latePredictionId: LATE,
  beliefIds: [BELIEF],
  predictionFacts: async (id) => FACTS[id] ?? null,
};

const RUN_FIXTURES: PlaybookRunFixtures = {
  playbook: conformancePlaybook('pb_tmos_conf_digest', 3),
  otherPlaybook: conformancePlaybook('pb_tmos_conf_other', 1),
};

describe('DecisionStore conformance — in-memory', () => {
  // The fixture clock and the suite's clock have to agree, or the "recorded
  // after the decision" case would prove nothing.
  it('the late prediction really was recorded after the decision', () => {
    if (new Date(AFTER).getTime() <= new Date(DECIDED_AT).getTime()) {
      throw new Error('fixture is wrong: LATE must be recorded after DECIDED_AT');
    }
  });

  for (const testCase of DECISION_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await testCase.run(createMemoryDecisionStore(), DECISION_FIXTURES);
    });
  }
});

describe('PlaybookRunStore conformance — in-memory', () => {
  for (const testCase of PLAYBOOK_RUN_CONFORMANCE) {
    it(testCase.name, async () => {
      await testCase.run(createMemoryRunStore(), RUN_FIXTURES);
    });
  }
});
