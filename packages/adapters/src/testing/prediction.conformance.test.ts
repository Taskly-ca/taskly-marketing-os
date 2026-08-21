/**
 * The `PredictionStore` conformance suite against the IN-MEMORY store.
 *
 * This is half the proof; `pg/prediction-store.live.test.ts` runs the identical
 * array against Postgres, each case inside a transaction that is rolled back. A
 * case that passes here and fails there is the finding. Until a `DATABASE_URL`
 * exists, green here means only that the assertions are self-consistent and
 * that the memory store still behaves the way the adapter was written to match.
 *
 * `newId` is the whole seam: `prediction.id` is a uuid and the memory store
 * takes any string, so both harnesses mint uuids and no case can depend on an
 * id shape only one store accepts.
 */
import { randomUUID } from 'node:crypto';
import { describe, it } from 'vitest';

import { createMemoryStore } from '@tmos/intel';

import {
  PREDICTION_STORE_CONFORMANCE,
  type PredictionStoreFixtures,
} from './prediction.conformance.js';

const FIXTURES: PredictionStoreFixtures = { newId: () => randomUUID() };

describe('PredictionStore conformance — in-memory', () => {
  for (const testCase of PREDICTION_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await testCase.run(createMemoryStore(), FIXTURES);
    });
  }
});
