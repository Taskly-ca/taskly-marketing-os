/**
 * The conformance suites against the IN-MEMORY stores.
 *
 * This file is half the proof. It is deterministic, keyless and runs in CI; the
 * `*.live.test.ts` files run the identical arrays against Postgres. A case that
 * passes here and fails there is the finding — and until a `DATABASE_URL`
 * exists, a green run here means only that the assertions are self-consistent
 * and that the memory store still behaves the way the Postgres adapter was
 * written to match.
 */
import { describe, it } from 'vitest';
import {
  createMemoryFactStore,
  createMemoryPredicateStore,
  resetFactIds,
} from '@tmos/world';

import { FACT_STORE_CONFORMANCE, type FactStoreFixtures } from './fact-store.conformance.js';
import {
  PREDICATE_STORE_CONFORMANCE,
  type PredicateStoreFixtures,
} from './predicate-store.conformance.js';

/**
 * Uuid-shaped even though the memory store would take any string: the same
 * fixture values then exercise the Postgres adapter's id guards, so a case
 * cannot accidentally depend on an id shape only one store accepts.
 */
const FACT_FIXTURES: FactStoreFixtures = {
  entityId: '11111111-1111-4111-8111-111111111111',
  otherEntityId: '22222222-2222-4222-8222-222222222222',
  predicate: 'tmos_conf_fact_alpha',
  otherPredicate: 'tmos_conf_fact_beta',
  sourceId: '33333333-3333-4333-8333-333333333333',
};

const PREDICATE_FIXTURES: PredicateStoreFixtures = {
  entityType: 'company',
  sourceA: '44444444-4444-4444-8444-444444444444',
  sourceB: '55555555-5555-4555-8555-555555555555',
};

describe('FactStore conformance — in-memory', () => {
  for (const testCase of FACT_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      resetFactIds();
      await testCase.run(createMemoryFactStore(), FACT_FIXTURES);
    });
  }
});

describe('PredicateStore conformance — in-memory', () => {
  for (const testCase of PREDICATE_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await testCase.run(createMemoryPredicateStore(), PREDICATE_FIXTURES);
    });
  }
});
