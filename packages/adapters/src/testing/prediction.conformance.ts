/**
 * The `PredictionStore` conformance suite — the definition of "substitutable"
 * for the calibration ledger.
 *
 * Every case runs against a FRESH store, so nothing may depend on what another
 * case left behind. Three constraints shape the assertions, and all three come
 * from the Postgres side:
 *
 *   · ids are supplied by the harness. `prediction.id` is a uuid; the memory
 *     store takes any string. `fixtures.newId()` is the seam.
 *   · `all()` is filtered to the ids the case created. The memory store starts
 *     empty; the live `prediction` table does not have to.
 *   · row order is not asserted. The port promises none, the memory store
 *     returns insertion order, and the adapter orders by `created_at`.
 *
 * THE CASE THAT MATTERS MOST is `outcome round-trips all four states`. The
 * column is text `'0' | '1' | 'annulled'` and the field is `0 | 1 | 'annulled'
 * | null`, so a store that returned the column verbatim would pass a `!==
 * null` check, pass an `== 0` check, and report every FALSE resolution as true
 * to anything that asks `if (outcome)`. `strictEqual(outcome, 0)` is the whole
 * defence, which is why it is asserted through the port rather than on the
 * mapper alone.
 *
 * Framework-agnostic on purpose — `node:assert/strict`, so nothing in `src/`
 * imports vitest and any runner can drive these.
 */
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';

import type { PredictionRecord, PredictionStore, ResolverSpec } from '@tmos/intel';

import { rejects, type ConformanceCase } from './conformance.js';

/**
 * The only thing the two stores cannot agree on unaided. The harness mints
 * ids; both harnesses use `randomUUID`, so a case cannot accidentally depend on
 * an id shape only one store accepts.
 */
export interface PredictionStoreFixtures {
  newId(): string;
}

export type PredictionStoreCase = ConformanceCase<PredictionStore, PredictionStoreFixtures>;

const T0 = '2026-07-01T00:00:00.000Z';
const DUE = '2026-08-01T00:00:00.000Z';
const LATER = '2026-12-01T00:00:00.000Z';
const AT = new Date('2026-08-15T00:00:00.000Z');

const RESOLVER: ResolverSpec = {
  kind: 'scrape_assert',
  spec: 'count:Toronto >= 40',
  source_url: 'https://example.test/categories',
  fallback: 'annul',
};

const draft = (
  fx: PredictionStoreFixtures,
  over: Partial<PredictionRecord> = {},
): PredictionRecord => ({
  id: fx.newId(),
  claim: 'Jiffy lists more than 40 Toronto categories on 2026-11-01',
  p: 0.65,
  author: 'agent:llama-3.3-70b@v1',
  created_at: T0,
  resolve_at: DUE,
  resolver: RESOLVER,
  evidence_snapshot_hash: 'a'.repeat(64),
  decision_id: null,
  belief_ids: [],
  outcome: null,
  observed: null,
  resolved_at: null,
  annul_reason: null,
  ...over,
});

/** `all()` is a whole-table read in Postgres. Cases only ever look at their own. */
const mine = async (store: PredictionStore, ids: string[]): Promise<PredictionRecord[]> =>
  (await store.all()).filter((r) => ids.includes(r.id));

const one = async (store: PredictionStore, id: string): Promise<PredictionRecord> => {
  const [row] = await mine(store, [id]);
  ok(row !== undefined, `expected ${id} to be in the store`);
  return row;
};

export const PREDICTION_STORE_CONFORMANCE: readonly PredictionStoreCase[] = [
  {
    name: 'insert stores every field, and all() reads them back identically',
    async run(store, fx) {
      const row = draft(fx, {
        decision_id: 'DEC-2026-004',
        belief_ids: [fx.newId(), fx.newId()],
        p: 0.42,
      });
      await store.insert(row);

      deepStrictEqual(await one(store, row.id), row);
    },
  },

  {
    name: 'a duplicate id is refused, and the first row survives',
    async run(store, fx) {
      const row = draft(fx);
      await store.insert(row);

      await rejects(
        () => store.insert(draft(fx, { id: row.id, claim: 'a different claim entirely' })),
        /duplicate prediction id/,
      );
      strictEqual((await one(store, row.id)).claim, row.claim);
    },
  },

  {
    name: 'outcome round-trips all four states — 0 and 1 are NUMBERS, never "0"/"1"',
    async run(store, fx) {
      const unresolved = draft(fx);
      const yes = draft(fx);
      const no = draft(fx);
      const annulled = draft(fx);
      for (const row of [unresolved, yes, no, annulled]) await store.insert(row);

      await store.resolve(yes.id, { outcome: 1, observed: 41, resolvedAt: AT.toISOString() });
      await store.resolve(no.id, { outcome: 0, observed: 12, resolvedAt: AT.toISOString() });
      await store.resolve(annulled.id, {
        outcome: 'annulled',
        observed: null,
        resolvedAt: AT.toISOString(),
        annulReason: 'source moved the page',
      });

      strictEqual((await one(store, unresolved.id)).outcome, null);
      strictEqual((await one(store, yes.id)).outcome, 1);

      // The whole point. `'0'` would pass `!== null`, pass `== 0`, and read as
      // TRUE under `if (outcome)` — a false resolution scored as a hit.
      const falsified = (await one(store, no.id)).outcome;
      strictEqual(falsified, 0);
      strictEqual(typeof falsified, 'number');
      ok(!falsified, 'a prediction that resolved FALSE must be falsy');

      strictEqual((await one(store, annulled.id)).outcome, 'annulled');
    },
  },

  {
    name: 'resolve records the observation, the instant and the annulment reason',
    async run(store, fx) {
      const row = draft(fx);
      await store.insert(row);
      await store.resolve(row.id, {
        outcome: 'annulled',
        observed: { count: 39, note: null },
        resolvedAt: AT.toISOString(),
        annulReason: 'pattern did not match: count:Toronto',
      });

      const read = await one(store, row.id);
      deepStrictEqual(read.observed, { count: 39, note: null });
      strictEqual(read.resolved_at, AT.toISOString());
      strictEqual(read.annul_reason, 'pattern did not match: count:Toronto');
    },
  },

  {
    name: 'resolve is idempotent — a second resolution never overwrites the first',
    async run(store, fx) {
      const row = draft(fx);
      await store.insert(row);
      await store.resolve(row.id, { outcome: 1, observed: 41, resolvedAt: AT.toISOString() });

      // No throw, and no change. A ledger a second run can rewrite is not one.
      await store.resolve(row.id, {
        outcome: 0,
        observed: 0,
        resolvedAt: '2026-09-01T00:00:00.000Z',
      });

      const read = await one(store, row.id);
      strictEqual(read.outcome, 1);
      strictEqual(read.observed, 41);
      strictEqual(read.resolved_at, AT.toISOString());
    },
  },

  {
    name: 'resolving a prediction that does not exist is refused',
    async run(store, fx) {
      await rejects(
        () =>
          store.resolve(fx.newId(), {
            outcome: 1,
            observed: null,
            resolvedAt: AT.toISOString(),
          }),
        /unknown prediction/,
      );
    },
  },

  {
    name: 'due returns what is unresolved and ripe, and nothing else',
    async run(store, fx) {
      const ripe = draft(fx);
      const notYet = draft(fx, { resolve_at: LATER });
      const alreadyDone = draft(fx);
      for (const row of [ripe, notYet, alreadyDone]) await store.insert(row);
      await store.resolve(alreadyDone.id, {
        outcome: 1,
        observed: null,
        resolvedAt: AT.toISOString(),
      });

      const ids = (await store.due(AT)).map((r) => r.id);
      ok(ids.includes(ripe.id), 'a ripe, unresolved prediction is due');
      ok(!ids.includes(notYet.id), 'a prediction resolving in December is not due in August');
      ok(!ids.includes(alreadyDone.id), 'a resolved prediction is never due again');
    },
  },

  {
    name: 'a prediction resolved FALSE is not due — the truthiness trap, at the query',
    async run(store, fx) {
      const row = draft(fx);
      await store.insert(row);
      await store.resolve(row.id, { outcome: 0, observed: 3, resolvedAt: AT.toISOString() });

      // `where outcome is null` in SQL; `r.outcome === null` in memory. A store
      // that filtered on falsiness would hand this row back every week forever.
      const ids = (await store.due(AT)).map((r) => r.id);
      ok(!ids.includes(row.id), 'resolved-to-0 is resolved');
    },
  },

  {
    name: 'due includes a prediction due at exactly this instant',
    async run(store, fx) {
      const row = draft(fx, { resolve_at: AT.toISOString() });
      await store.insert(row);

      const ids = (await store.due(AT)).map((r) => r.id);
      ok(ids.includes(row.id), 'the boundary is inclusive: resolve_at <= now');
    },
  },

  {
    name: 'the row handed back is a copy — mutating it does not reach the store',
    async run(store, fx) {
      const row = draft(fx);
      await store.insert(row);

      const read = await one(store, row.id);
      read.outcome = 1;
      read.claim = 'rewritten';

      const again = await one(store, row.id);
      strictEqual(again.outcome, null);
      strictEqual(again.claim, row.claim);
      notStrictEqual(again, read);
    },
  },

  {
    name: 'an already-resolved prediction can be inserted as one — seeds and backfills',
    async run(store, fx) {
      const row = draft(fx, {
        outcome: 0,
        observed: { count: 12 },
        resolved_at: AT.toISOString(),
        annul_reason: null,
      });
      await store.insert(row);

      const read = await one(store, row.id);
      strictEqual(read.outcome, 0);
      strictEqual(read.resolved_at, AT.toISOString());
      ok(!(await store.due(AT)).some((r) => r.id === row.id));
    },
  },
];
