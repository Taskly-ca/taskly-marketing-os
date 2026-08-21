/**
 * The `LabelStore` conformance suite.
 *
 * `er_label` is the ER calibration set and regression suite, so the property
 * that matters is not "a row comes back" — it is that ONE unordered pair has
 * exactly ONE verdict, in both implementations, however the caller spells the
 * pair. 006 spends a paragraph on why: a set that can disagree with itself
 * still produces a precision number, and the number decides where the
 * auto-merge threshold goes.
 *
 * Three things are deliberately NOT asserted, each because of the Postgres side:
 *
 *   · id SHAPE. The memory store mints `erl_000001`; Postgres mints a uuid.
 *     Identity is asserted (a re-label keeps its id); the shape never is.
 *   · `all()` AS AN EXACT SET. The memory store starts empty; a real `er_label`
 *     has whatever humans have labelled in it. Every case filters `all()` down
 *     to its own fixture entities — a case that asserted the whole table would
 *     pass forever in memory and fail on the first live run.
 *   · ROW ORDER. The memory store returns `Map` insertion order, the adapter
 *     `order by decided_at, id`. Nothing in `labels.ts` reads order:
 *     `calibrate` sorts its own candidates and `thresholdReport` is a fold.
 *
 * `score` values stay two significant digits: `er_label.score` is `real`, and a
 * float64 that does not survive the narrowing would fail here for a reason that
 * has nothing to do with the port.
 */
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { pairKey, type ErLabel, type ErLabelInput, type LabelStore } from '@tmos/world';

import { ABSENT_UUID, type ConformanceCase } from './conformance.js';

/**
 * `er_label.left_entity` and `right_entity` are foreign keys to `entity`, so
 * the live harness must supply rows that exist. The memory store takes any
 * string. This is the whole seam between the two runs.
 */
export interface ErLabelFixtures {
  readonly entityA: string;
  readonly entityB: string;
  /** A third entity, so "a second pair does not disturb the first" is testable. */
  readonly entityC: string;
}

export type LabelStoreCase = ConformanceCase<LabelStore, ErLabelFixtures>;

const T0 = '2026-07-01T00:00:00.000Z';
const T1 = '2026-07-15T00:00:00.000Z';

const label = (
  left: string,
  right: string,
  over: Partial<ErLabelInput> = {},
): ErLabelInput => ({
  leftEntity: left,
  rightEntity: right,
  score: 0.875,
  llmVerdict: 'match',
  llmRationale: 'same registrable domain, same city',
  humanVerdict: 'match',
  decidedBy: 'reviewer@taskly.ca',
  decidedAt: T0,
  ...over,
});

const withoutId = ({ id: _id, ...rest }: ErLabel): ErLabelInput => rest;

/** `all()` is a live table in Postgres — every assertion is scoped to fixtures. */
const mine = (rows: readonly ErLabel[], fx: ErLabelFixtures): ErLabel[] => {
  const ours = new Set([fx.entityA, fx.entityB, fx.entityC]);
  return rows.filter((r) => ours.has(r.leftEntity) && ours.has(r.rightEntity));
};

export const LABEL_STORE_CONFORMANCE: readonly LabelStoreCase[] = [
  {
    name: 'add returns the label it stored, with an id, and byPair reads it back identically',
    async run(store, fx) {
      const stored = await store.add(label(fx.entityA, fx.entityB));

      ok(stored.id.length > 0, 'add must assign an id');
      deepStrictEqual(withoutId(stored), label(fx.entityA, fx.entityB));

      deepStrictEqual(await store.byPair(fx.entityA, fx.entityB), stored);
    },
  },

  {
    name: 'the pair is UNDIRECTED — byPair finds a label whichever way round it is asked',
    async run(store, fx) {
      const stored = await store.add(label(fx.entityA, fx.entityB));
      deepStrictEqual(await store.byPair(fx.entityB, fx.entityA), stored);
      strictEqual(pairKey(fx.entityA, fx.entityB), pairKey(fx.entityB, fx.entityA));
    },
  },

  {
    name: 're-labelling a pair REPLACES the verdict and keeps the same id',
    async run(store, fx) {
      const first = await store.add(label(fx.entityA, fx.entityB, { humanVerdict: 'match' }));
      const second = await store.add(
        label(fx.entityA, fx.entityB, {
          humanVerdict: 'no_match',
          score: 0.5,
          decidedBy: 'senior@taskly.ca',
          decidedAt: T1,
          llmVerdict: null,
          llmRationale: null,
        }),
      );

      strictEqual(second.id, first.id, 'a correction is the same label, not a second one');
      strictEqual(second.humanVerdict, 'no_match');
      strictEqual(second.score, 0.5);
      strictEqual(second.decidedBy, 'senior@taskly.ca');
      strictEqual(second.decidedAt, T1);
      strictEqual(second.llmVerdict, null);

      deepStrictEqual(await store.byPair(fx.entityA, fx.entityB), second);
      strictEqual(mine(await store.all(), fx).length, 1, 'two verdicts for one pair');
    },
  },

  {
    name: 're-labelling with the arguments reversed replaces, and stores the new orientation',
    async run(store, fx) {
      const first = await store.add(label(fx.entityA, fx.entityB, { humanVerdict: 'match' }));
      const flipped = await store.add(
        label(fx.entityB, fx.entityA, { humanVerdict: 'unsure', decidedAt: T1 }),
      );

      strictEqual(flipped.id, first.id);
      strictEqual(flipped.leftEntity, fx.entityB);
      strictEqual(flipped.rightEntity, fx.entityA);
      strictEqual(flipped.humanVerdict, 'unsure');
      strictEqual(mine(await store.all(), fx).length, 1);
    },
  },

  {
    name: 'byPair returns null for a pair nothing holds — it does not throw',
    async run(store, fx) {
      strictEqual(await store.byPair(fx.entityA, fx.entityB), null);
      strictEqual(await store.byPair(fx.entityA, ABSENT_UUID), null);
    },
  },

  {
    name: 'the nullable llm columns round-trip as null',
    async run(store, fx) {
      const stored = await store.add(
        label(fx.entityA, fx.entityB, { llmVerdict: null, llmRationale: null }),
      );
      strictEqual(stored.llmVerdict, null);
      strictEqual(stored.llmRationale, null);

      const read = await store.byPair(fx.entityA, fx.entityB);
      strictEqual(read?.llmRationale, null);
    },
  },

  {
    name: 'every human verdict round-trips, including unsure',
    async run(store, fx) {
      for (const humanVerdict of ['match', 'no_match', 'unsure'] as const) {
        const stored = await store.add(label(fx.entityA, fx.entityB, { humanVerdict }));
        strictEqual(stored.humanVerdict, humanVerdict);
      }
    },
  },

  {
    name: 'a second pair is a second label — pairs do not collide',
    async run(store, fx) {
      const ab = await store.add(label(fx.entityA, fx.entityB, { humanVerdict: 'match' }));
      const ac = await store.add(label(fx.entityA, fx.entityC, { humanVerdict: 'no_match' }));

      notStrictEqual(ac.id, ab.id);
      strictEqual((await store.byPair(fx.entityA, fx.entityB))?.humanVerdict, 'match');
      strictEqual((await store.byPair(fx.entityC, fx.entityA))?.humanVerdict, 'no_match');
      strictEqual(mine(await store.all(), fx).length, 2);
    },
  },

  {
    name: 'all() returns one row per labelled pair, and each is readable by pair',
    async run(store, fx) {
      await store.add(label(fx.entityA, fx.entityB));
      await store.add(label(fx.entityB, fx.entityC, { humanVerdict: 'unsure' }));

      const rows = mine(await store.all(), fx);
      strictEqual(rows.length, 2);

      const keys = new Set(rows.map((r) => pairKey(r.leftEntity, r.rightEntity)));
      strictEqual(keys.size, 2, 'all() must never hold the same pair twice');
      ok(keys.has(pairKey(fx.entityA, fx.entityB)));
      ok(keys.has(pairKey(fx.entityB, fx.entityC)));

      for (const row of rows) {
        deepStrictEqual(await store.byPair(row.leftEntity, row.rightEntity), row);
      }
    },
  },
];
