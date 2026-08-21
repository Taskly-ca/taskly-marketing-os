/**
 * The Brain conformance suites against the IN-MEMORY implementations.
 *
 * Half the proof, and the half that runs in CI: deterministic, keyless, no
 * database. `pg/brain-store.live.test.ts` and `pg/brain-index.live.test.ts` run
 * the identical arrays against Postgres inside a rolled-back transaction. A case
 * that passes here and fails there is the finding.
 *
 * Until a `DATABASE_URL` exists, a green run here means only that the assertions
 * are self-consistent and that the memory store still behaves the way the
 * Postgres adapter was written to match.
 */
import { describe, it } from 'vitest';
import { createMemoryBrainStore } from '@tmos/brain';

import {
  BRAIN_FIXTURES,
  BRAIN_INDEX_CONFORMANCE,
  BRAIN_STORE_CONFORMANCE,
  createMemoryBrainIndex,
  type BrainIndexSeam,
} from './brain.conformance.js';

/** The read port has no upstream in-memory implementation; the reference lives
 *  in the conformance module and is documented there as written alongside the
 *  adapter rather than before it. */
const memorySeam = (): BrainIndexSeam => {
  const store = createMemoryBrainStore();
  return { store, index: createMemoryBrainIndex(store) };
};

describe('BrainStorePort conformance — in-memory', () => {
  for (const testCase of BRAIN_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await testCase.run(createMemoryBrainStore(), BRAIN_FIXTURES);
    });
  }
});

describe('BrainIndexPort conformance — in-memory', () => {
  for (const testCase of BRAIN_INDEX_CONFORMANCE) {
    it(testCase.name, async () => {
      await testCase.run(memorySeam(), BRAIN_FIXTURES);
    });
  }
});
