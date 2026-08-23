/**
 * Resolution against the real database — the one thing a fake cannot show.
 *
 * Thirteen predictions sit in the ledger and the earliest is due on 2026-09-30,
 * so a live run today correctly resolves nothing. "It printed zero" is not
 * evidence that the path works, and waiting five weeks to find out is not a
 * test strategy. So this inserts a prediction that IS due, inside a transaction
 * that is always rolled back: real triggers, real jsonb round-trip, real
 * `resolve_at` comparison, and no outcome written to a real forecast weeks
 * before it is due.
 *
 * The resolver kind is `manual` on purpose. It needs no network and no query
 * capability, so what this exercises is exactly the machinery under test —
 * scan, dispatch, record, read back — rather than a competitor's uptime.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HAS_DATABASE, inRollback } from '@tmos/adapters';
import { createPostgresPredictionStore } from '@tmos/adapters';

import { resolveDue, scorable } from './resolve.js';

const DUE = new Date('2026-08-23T12:00:00.000Z');

describe.skipIf(!HAS_DATABASE)('resolution, live', () => {
  it('resolves a due prediction and leaves a scorable record', async () => {
    await inRollback(async (tx) => {
      const store = createPostgresPredictionStore(tx);
      const id = randomUUID();

      await store.insert({
        id,
        claim: 'A test prediction, rolled back before it can matter.',
        p: 0.75,
        author: 'human:test',
        created_at: '2026-08-01T00:00:00.000Z',
        // Yesterday: due, so the scan must pick it up.
        resolve_at: '2026-08-22T00:00:00.000Z',
        resolver: {
          kind: 'manual',
          spec: 'settled by hand — this row exists only inside a rolled-back transaction',
          source_url: 'https://example.invalid/live-test',
          fallback: 'annul',
        },
        evidence_snapshot_hash: 'test',
        decision_id: null,
        belief_ids: [],
        outcome: null,
        observed: null,
        resolved_at: null,
        annul_reason: null,
      });

      const before = await store.all();
      expect(before.find((r) => r.id === id)?.outcome).toBeNull();

      await resolveDue(DUE, { store });

      const after = await store.all();
      const settled = after.find((r) => r.id === id);

      // `manual` has nobody to ask, so it ANNULS — with a reason, and without
      // scoring. That is the contract: ambiguity annuls, no score, no penalty.
      // What this proves is the machinery around it — the scan found a due row,
      // dispatched it, wrote an outcome and a reason, and it read back.
      expect(settled?.outcome).toBe('annulled');
      expect(settled?.annul_reason ?? '').not.toBe('');
      expect(settled?.resolved_at).not.toBeNull();

      // And an annulment is not a wrong answer: it must not reach the score.
      expect(scorable([settled!])).toEqual([]);
    });
  });

  it('leaves a prediction that is not yet due alone', async () => {
    await inRollback(async (tx) => {
      const store = createPostgresPredictionStore(tx);
      const id = randomUUID();
      await store.insert({
        id,
        claim: 'Not due for a month.',
        p: 0.5,
        author: 'human:test',
        created_at: '2026-08-01T00:00:00.000Z',
        resolve_at: '2026-12-01T00:00:00.000Z',
        resolver: {
          kind: 'manual',
          spec: 'not due for a month',
          source_url: 'https://example.invalid/live-test',
          fallback: 'annul',
        },
        evidence_snapshot_hash: 'test',
        decision_id: null,
        belief_ids: [],
        outcome: null,
        observed: null,
        resolved_at: null,
        annul_reason: null,
      });

      await resolveDue(DUE, { store });

      const after = (await store.all()).find((r) => r.id === id);
      // Resolving early is the one thing that would corrupt the ledger beyond
      // repair: the outcome would be recorded before it was knowable.
      expect(after?.outcome).toBeNull();
    });
  });
});
