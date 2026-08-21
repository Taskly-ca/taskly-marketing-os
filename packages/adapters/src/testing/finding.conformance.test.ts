/**
 * The `FindingStore` conformance array against the IN-MEMORY store.
 *
 * Deterministic, keyless, in CI. `pg/finding-store.live.test.ts` runs the
 * identical array against Postgres, each case inside a transaction it rolls
 * back.
 *
 * The two implementations of deduplication are what this pairing is really
 * for. In memory it is a `Map` from dedupe key to id — exact, and impossible to
 * race. In Postgres it is a narrowing scan plus the same key recomputed in
 * JavaScript, under an advisory lock. Every case below is written so that both
 * must answer identically; the live file adds the cases only a real database
 * can carry.
 */
import { describe, it } from 'vitest';
import { createMemoryFindingStore } from '@tmos/reason';

import { FINDING_STORE_CONFORMANCE, makeFindingFixtures } from './finding.conformance.js';

describe('FindingStore conformance — in-memory', () => {
  for (const testCase of FINDING_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await testCase.run(createMemoryFindingStore(), makeFindingFixtures());
    });
  }
});
