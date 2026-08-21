/**
 * The `Outbox` conformance array against the IN-MEMORY store.
 *
 * Half the proof, and the half that runs in CI: deterministic, keyless, no
 * database. `pg/outbox.live.test.ts` runs the identical array against Postgres.
 * A case that passes here and fails there is the finding.
 *
 * Until a `DATABASE_URL` exists, a green run here means only that the
 * assertions are self-consistent and that `createMemoryOutbox` still behaves
 * the way the Postgres adapter was written to match — which is precisely the
 * trap migration 009's header describes, and the reason the live file exists in
 * the same commit as the adapter rather than after it.
 */
import { describe, it } from 'vitest';
import { createMemoryOutbox } from '@tmos/gate';

import { OUTBOX_CONFORMANCE, makeOutboxFixtures } from './outbox.conformance.js';

describe('Outbox conformance — in-memory', () => {
  for (const testCase of OUTBOX_CONFORMANCE) {
    it(testCase.name, async () => {
      await testCase.run(createMemoryOutbox(), makeOutboxFixtures());
    });
  }
});
