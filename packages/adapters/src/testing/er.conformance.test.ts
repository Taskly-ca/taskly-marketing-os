/**
 * The `LabelStore` conformance suite against the IN-MEMORY store.
 *
 * Half the proof, and the half that runs in CI: deterministic, keyless, no
 * database. `pg/er-labels.live.test.ts` runs the identical array against
 * Postgres inside a rolled-back transaction. A case that passes here and fails
 * there is the finding — 006 exists because `er_label` had no uniqueness
 * constraint at all, which no in-memory test could ever have noticed.
 */
import { describe, it } from 'vitest';
import { createMemoryLabelStore, resetLabelIds } from '@tmos/world';

import { LABEL_STORE_CONFORMANCE, type ErLabelFixtures } from './er.conformance.js';

/**
 * Uuid-shaped even though the memory store would take any string: the same
 * fixture values then exercise the Postgres adapter's id guards, so a case
 * cannot accidentally depend on an id shape only one store accepts.
 */
const FIXTURES: ErLabelFixtures = {
  entityA: '11111111-1111-4111-8111-111111111111',
  entityB: '22222222-2222-4222-8222-222222222222',
  entityC: '66666666-6666-4666-8666-666666666666',
};

describe('LabelStore conformance — in-memory', () => {
  for (const testCase of LABEL_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      resetLabelIds();
      await testCase.run(createMemoryLabelStore(), FIXTURES);
    });
  }
});
