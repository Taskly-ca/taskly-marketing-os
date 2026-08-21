/**
 * The `FactStore` conformance suite — the definition of "substitutable".
 *
 * Every case runs against a FRESH store, so nothing here may depend on what
 * another case left behind. Two constraints shape how the assertions are
 * written, and both come from the Postgres side:
 *
 *   · ids are opaque. The memory store mints `fact_00000a`; Postgres mints a
 *     uuid. Nothing asserts on their shape, only on their identity.
 *   · row order is not asserted. The port says "insertion order"; `fact` has no
 *     insertion counter, so the adapter orders by `lower(asserted)`. Rows are
 *     compared as sets of ids.
 *
 * The last four cases drive `@tmos/world`'s own write rules — assert, correct,
 * change, retract — against the store rather than poking it directly. Those are
 * the ones that matter: they are the exact call sequence the worker makes, and
 * they are what would have caught, before a database existed, that `closeValid`
 * was impossible in Postgres.
 */
import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict';

import type { FactInput, FactRow, FactStore } from '@tmos/world';
import { assertFact, correctFact, isOpen, recordChange, retractFact } from '@tmos/world';

import { ABSENT_UUID, rejects, type ConformanceCase } from './conformance.js';

/**
 * Ids the Postgres store needs to be real rows (`fact` has three foreign keys)
 * and the memory store does not care about at all. The harness supplies them,
 * which is the entire seam between the two runs.
 */
export interface FactStoreFixtures {
  readonly entityId: string;
  /** A second entity: proves `forEntity` filters, and is the `entity` datatype's value. */
  readonly otherEntityId: string;
  readonly predicate: string;
  readonly otherPredicate: string;
  readonly sourceId: string;
}

export type FactStoreCase = ConformanceCase<FactStore, FactStoreFixtures>;

const T0 = '2026-07-01T00:00:00.000Z';
const T1 = '2026-07-15T00:00:00.000Z';
const T2 = '2026-08-01T00:00:00.000Z';
/** Strictly after T2: the instant we learn something about T0..T2, which is
 *  what makes an out-of-order arrival representable at all. */
const T3 = '2026-08-10T00:00:00.000Z';

/**
 * `confidence` is `real` in Postgres — 24 bits of mantissa, ~7 significant
 * digits — so conformance values stay short enough to survive the narrowing.
 * The precision loss itself is asserted in the live suite, where it is real.
 */
const draft = (
  fx: FactStoreFixtures,
  over: Partial<Omit<FactRow, 'factId'>> = {},
): Omit<FactRow, 'factId'> => ({
  entityId: fx.entityId,
  predicate: fx.predicate,
  value: { datatype: 'num', num: 9900 },
  valid: { from: T0, to: null },
  asserted: { from: T0, to: null },
  sourceId: fx.sourceId,
  observedAt: T0,
  confidence: 0.9,
  method: 'scrape',
  evidence: {
    url: 'https://example.test/pricing',
    snippet: 'from $99',
    extractorVersion: 'extract@3',
    promptVersion: 'prompt@7',
  },
  supersedes: null,
  status: 'active',
  ...over,
});

const input = (fx: FactStoreFixtures, over: Partial<FactInput> = {}): FactInput => ({
  entityId: fx.entityId,
  predicate: fx.predicate,
  value: { datatype: 'num', num: 9900 },
  sourceId: fx.sourceId,
  observedAt: T0,
  method: 'scrape',
  ...over,
});

const withoutId = ({ factId: _factId, ...rest }: FactRow): Omit<FactRow, 'factId'> => rest;
const ids = (rows: readonly FactRow[]): string[] => rows.map((r) => r.factId).sort();

export const FACT_STORE_CONFORMANCE: readonly FactStoreCase[] = [
  {
    name: 'insert returns the row it stored, with an id, and byId reads it back identically',
    async run(store, fx) {
      const stored = await store.insert(draft(fx));

      ok(stored.factId.length > 0, 'insert must assign an id');
      deepStrictEqual(withoutId(stored), draft(fx));

      const read = await store.byId(stored.factId);
      deepStrictEqual(read, stored);
    },
  },

  {
    name: 'round-trips all four value datatypes',
    async run(store, fx) {
      const values: FactRow['value'][] = [
        { datatype: 'text', text: 'Same-day service in the GTA' },
        { datatype: 'num', num: 12_500 },
        { datatype: 'entity', entityId: fx.otherEntityId },
        { datatype: 'json', json: { tiers: ['basic', 'pro'], seats: 3, note: null } },
      ];

      for (const value of values) {
        const stored = await store.insert(draft(fx, { value }));
        const read = await store.byId(stored.factId);
        deepStrictEqual(read?.value, value, `${value.datatype} did not round-trip`);
      }
    },
  },

  {
    name: 'an empty evidence object round-trips as an empty object',
    async run(store, fx) {
      const stored = await store.insert(draft(fx, { evidence: {} }));
      deepStrictEqual((await store.byId(stored.factId))?.evidence, {});
    },
  },

  {
    name: 'byId returns null for an id nothing holds — it does not throw',
    async run(store) {
      strictEqual(await store.byId(ABSENT_UUID), null);
    },
  },

  {
    name: 'forPredicate returns every row for the pair and nothing else',
    async run(store, fx) {
      const a = await store.insert(draft(fx));
      const b = await store.insert(draft(fx, { value: { datatype: 'num', num: 10_100 } }));
      await store.insert(draft(fx, { predicate: fx.otherPredicate }));
      await store.insert(draft(fx, { entityId: fx.otherEntityId }));

      deepStrictEqual(ids(await store.forPredicate(fx.entityId, fx.predicate)), ids([a, b]));
    },
  },

  {
    name: 'forEntity spans predicates and excludes other entities',
    async run(store, fx) {
      const a = await store.insert(draft(fx));
      const b = await store.insert(draft(fx, { predicate: fx.otherPredicate }));
      await store.insert(draft(fx, { entityId: fx.otherEntityId }));

      deepStrictEqual(ids(await store.forEntity(fx.entityId)), ids([a, b]));
    },
  },

  {
    name: 'an entity with no facts reads as empty, never as an error',
    async run(store) {
      deepStrictEqual(await store.forEntity(ABSENT_UUID), []);
      deepStrictEqual(await store.forPredicate(ABSENT_UUID, 'price_cents'), []);
    },
  },

  {
    name: 'closeAsserted closes the belief interval and leaves valid untouched',
    async run(store, fx) {
      const stored = await store.insert(draft(fx));
      await store.closeAsserted(stored.factId, T1);

      const read = await store.byId(stored.factId);
      strictEqual(read?.asserted.to, T1);
      strictEqual(read?.asserted.from, T0);
      deepStrictEqual(read?.valid, { from: T0, to: null });
    },
  },

  {
    name: 'closing an already-closed asserted interval is refused',
    async run(store, fx) {
      const stored = await store.insert(draft(fx));
      await store.closeAsserted(stored.factId, T1);

      await rejects(() => store.closeAsserted(stored.factId, T2), /already closed/);
      strictEqual((await store.byId(stored.factId))?.asserted.to, T1, 'must not have moved');
    },
  },

  {
    name: 'closeAsserted on a fact that does not exist is refused',
    async run(store) {
      await rejects(() => store.closeAsserted(ABSENT_UUID, T1), /no such fact/);
    },
  },

  {
    name: 'closeValid closes the world interval and leaves asserted untouched',
    async run(store, fx) {
      const stored = await store.insert(draft(fx));
      await store.closeValid(stored.factId, T1);

      const read = await store.byId(stored.factId);
      strictEqual(read?.valid.to, T1);
      strictEqual(read?.valid.from, T0);
      deepStrictEqual(read?.asserted, { from: T0, to: null });
    },
  },

  {
    name: 'closeValid before the instant valid opened is refused',
    async run(store, fx) {
      const stored = await store.insert(draft(fx, { valid: { from: T1, to: null } }));
      await rejects(() => store.closeValid(stored.factId, T0), /precedes valid\.from/);
      strictEqual((await store.byId(stored.factId))?.valid.to, null);
    },
  },

  {
    name: 'closeValid on a fact that does not exist is refused',
    async run(store) {
      await rejects(() => store.closeValid(ABSENT_UUID, T1), /no such fact/);
    },
  },

  /* ── 009's bound discipline, on BOTH axes ─────────────────────────────────
   *
   * These six cases are the ones the previous pass deliberately left out: they
   * would have failed the in-memory run, because the fake was more permissive
   * than the schema on every one of them. They are the point of this file. Each
   * asserts `error.name` as well as the message — the two packages cannot share
   * an error class (adapters depends on world, never the reverse) but both set
   * `name` from the class actually constructed, so the STRING is comparable and
   * "which failure" is checked rather than "some failure".
   */

  {
    name: 'closeValid on an already-closed bound is refused — infinite → finite, once',
    async run(store, fx) {
      const stored = await store.insert(draft(fx));
      await store.closeValid(stored.factId, T1);

      // The divergence that hid `recordChange`'s closed-interval bug for
      // months: the memory store used to move the end date silently, so half
      // the bitemporal write model was validated against a world where a
      // recorded end date is editable. 009 raises: "re-closing or reopening
      // rewrites recorded history; correct a wrong end by superseding the row".
      const error = await rejects(() => store.closeValid(stored.factId, T2), /already closed/);
      strictEqual(error.name, 'AppendOnlyError');
      strictEqual((await store.byId(stored.factId))?.valid.to, T1, 'must not have moved');
    },
  },

  {
    name: 'closeValid at the instant valid opened is refused — an empty interval asserts nothing',
    async run(store, fx) {
      const stored = await store.insert(draft(fx));

      const error = await rejects(() => store.closeValid(stored.factId, T0), /no instant/);
      strictEqual(error.name, 'EmptyRangeError');
      strictEqual((await store.byId(stored.factId))?.valid.to, null, 'nothing was written');
    },
  },

  {
    name: 'closeAsserted at the instant asserted opened is refused — now() is frozen per transaction',
    async run(store, fx) {
      // The single most likely way to hit this in production, and the reason it
      // is worth a case of its own rather than only the `recordChange` one
      // below: `asserted` defaults to `tstzrange(now(), null)` and `now()` does
      // not advance inside a transaction, so a row inserted and closed in one
      // withTx always lands on exactly this instant.
      const stored = await store.insert(draft(fx));

      const error = await rejects(() => store.closeAsserted(stored.factId, T0), /no instant/);
      strictEqual(error.name, 'EmptyRangeError');
      strictEqual((await store.byId(stored.factId))?.asserted.to, null, 'nothing was written');
    },
  },

  {
    name: 'closeAsserted before the instant asserted opened is refused — the mirror of closeValid',
    async run(store, fx) {
      // "We stopped believing it before we started" was storable: `closeValid`
      // had this check and `closeAsserted` had none at all. 009 applies one
      // function to both axes precisely so they cannot drift.
      const stored = await store.insert(draft(fx, { asserted: { from: T1, to: null } }));

      const error = await rejects(
        () => store.closeAsserted(stored.factId, T0),
        /precedes asserted\.from/,
      );
      strictEqual(error.name, 'AppendOnlyError');
      strictEqual((await store.byId(stored.factId))?.asserted.to, null);
    },
  },

  {
    name: 'insert refuses a range whose upper bound precedes its lower',
    async run(store, fx) {
      // Postgres cannot CONSTRUCT `tstzrange(T2, T0)` — 22000, raised before any
      // trigger runs — so 009's "would end before it starts" is the message of
      // last resort rather than the usual one. The memory store stored it.
      const error = await rejects(
        () => store.insert(draft(fx, { valid: { from: T2, to: T0 } })),
        /range lower bound must be less than or equal/,
      );
      strictEqual(error.name, 'ConstraintError');
      deepStrictEqual(await store.forEntity(fx.entityId), [], 'nothing was written');
    },
  },

  {
    name: 'insert refuses an EMPTY range — 009 guards UPDATE and DELETE, so the row would be undecodable',
    async run(store, fx) {
      // The one rule here that 009 does not state, and the one place the two
      // stores refuse for DIFFERENT reasons — hence the two-branch match.
      //
      // 009's triggers are `before update` / `before delete` only, so Postgres
      // accepts `tstzrange(T0, T0)` on the way in. It then normalizes it to
      // `empty`, and `lower(empty)` and `upper(empty)` are both null — so the
      // adapter's decoder refuses the row it just wrote ("valid.from: expected
      // a timestamp, got null") and every later read of that ENTITY refuses it
      // too, not just that row. Through the port the observable is a rejection
      // either way, so the memory store rejects up front, where nothing is
      // written at all.
      //
      // The honest fix is a `check (not isempty(valid) and not isempty(asserted))`
      // in a new migration. Until that exists, do not assert what is left on
      // disk here: memory writes nothing, Postgres writes an unreadable row.
      await rejects(
        () => store.insert(draft(fx, { valid: { from: T0, to: T0 } })),
        /contains no instant|expected a timestamp, got null/,
      );
    },
  },

  {
    name: 'setStatus retracts in place, and is refused for a fact that does not exist',
    async run(store, fx) {
      const stored = await store.insert(draft(fx));
      await store.setStatus(stored.factId, 'retracted');

      strictEqual((await store.byId(stored.factId))?.status, 'retracted');
      await rejects(() => store.setStatus(ABSENT_UUID, 'disputed'), /no such fact/);
    },
  },

  {
    name: 'the row handed back is a copy — mutating it does not reach the store',
    async run(store, fx) {
      const stored = await store.insert(draft(fx));
      stored.status = 'retracted';
      stored.valid.to = T2;

      const read = await store.byId(stored.factId);
      strictEqual(read?.status, 'active');
      strictEqual(read?.valid.to, null);
      notStrictEqual(read, stored);
    },
  },

  /* ── the domain's own write rules, driven through the store ───────────── */

  {
    name: 'rule 1: re-observing the same value does not insert a second row',
    async run(store, fx) {
      const first = await assertFact(store, input(fx), T0);
      strictEqual(first.created, true);

      const again = await assertFact(store, input(fx, { observedAt: T1 }), T1);
      strictEqual(again.created, false);
      strictEqual(again.row.factId, first.row.factId);
      strictEqual((await store.forPredicate(fx.entityId, fx.predicate)).length, 1);
    },
  },

  {
    name: 'rule 2: correcting ourselves closes asserted and copies the valid range',
    async run(store, fx) {
      const { row: original } = await assertFact(store, input(fx), T0);

      const replacement = await correctFact(
        store,
        original.factId,
        { datatype: 'num', num: 8800 },
        { sourceId: fx.sourceId, observedAt: T1, method: 'human', now: T1 },
      );

      const old = await store.byId(original.factId);
      strictEqual(old?.asserted.to, T1, 'the old belief must be closed, not deleted');
      deepStrictEqual(old?.valid, original.valid, 'a correction never touches the world axis');

      deepStrictEqual(replacement.valid, original.valid);
      strictEqual(replacement.supersedes, original.factId);
      strictEqual(isOpen(replacement.asserted), true);
    },
  },

  {
    name: 'rule 3: the world changing closes valid and opens a new row',
    async run(store, fx) {
      const { row: original } = await assertFact(store, input(fx), T0);

      const { kind, closed, row } = await recordChange(
        store,
        { ...input(fx, { value: { datatype: 'num', num: 11_000 } }), validFrom: T1 },
        T1,
      );

      strictEqual(kind, 'change', 'an open interval closing is the world moving');
      strictEqual(closed?.factId, original.factId);
      strictEqual(closed?.valid.to, T1);
      strictEqual(
        isOpen(closed.asserted),
        true,
        'we still believe the old row, about the old period',
      );
      strictEqual(row.valid.from, T1);
      strictEqual(isOpen(row.valid), true);
    },
  },

  {
    name: 'retraction keeps the row: status flips and asserted closes',
    async run(store, fx) {
      const { row } = await assertFact(store, input(fx), T0);
      await retractFact(store, row.factId, T1);

      const read = await store.byId(row.factId);
      strictEqual(read?.status, 'retracted');
      strictEqual(read?.asserted.to, T1);
    },
  },

  {
    name: 'retraction at the instant the belief opened is refused — the same frozen now()',
    async run(store, fx) {
      // `retractFact` closes `asserted` at `now`, and it is the LAST unguarded
      // caller of that: `correctFact` checks `assertBeliefClosable` before it
      // writes anything, `retractFact` does not. Assert and retract in one
      // transaction — a consolidation worker resolving a conflict it just wrote
      // is exactly that shape — and `now` is the instant the belief opened.
      const { row } = await assertFact(store, input(fx), T0);

      await rejects(() => retractFact(store, row.factId, T0), /no instant/);

      // Deliberately NOT asserted: `status`. Both stores flip it to 'retracted'
      // BEFORE the close is attempted, so both are left half-applied — the one
      // outcome `withTx` cannot undo for the caller, since @tmos/db has no
      // savepoints. That is a `packages/world/src/fact/write.ts` fix (call
      // `assertBeliefClosable` before `setStatus`, as `correctFact` does) and
      // that file is another lane. When it lands, add `status === 'active'`
      // here.
      strictEqual(
        (await store.byId(row.factId))?.asserted.to,
        null,
        'the belief must not have closed',
      );
    },
  },

  {
    name: 'rule 3 out of order: a change inside a CLOSED interval corrects asserted, never valid',
    async run(store, fx) {
      // The production sequence, exactly: a later change is recorded first, then
      // a source reports a historical one (a backfill, a slow feed). Shortening
      // the closed bound here is what 009 raises on — upper(valid) closes once,
      // infinite -> finite only — and what makes "what did we believe on date D"
      // unanswerable for this entity.
      const { row: original } = await assertFact(store, input(fx, { validFrom: T0 }), T0);
      await recordChange(
        store,
        {
          ...input(fx, { value: { datatype: 'num', num: 11_000 }, observedAt: T2 }),
          validFrom: T2,
        },
        T2,
      );

      const out = await recordChange(
        store,
        {
          ...input(fx, { value: { datatype: 'num', num: 10_500 }, observedAt: T3 }),
          validFrom: T1,
        },
        T3,
      );

      const old = await store.byId(original.factId);
      deepStrictEqual(old?.valid, { from: T0, to: T2 }, 'a closed world bound never moves');
      strictEqual(old?.asserted.to, T3, 'we were wrong, so the BELIEF closes');

      strictEqual(out.kind, 'correction');
      ok(out.prior, 'the covering interval is replaced by two rows, not one');
      deepStrictEqual(out.prior.value, { datatype: 'num', num: 9900 });
      deepStrictEqual(out.prior.valid, { from: T0, to: T1 }, 'the window it really held for');
      strictEqual(out.prior.supersedes, original.factId);
      strictEqual(isOpen(out.prior.asserted), true);

      deepStrictEqual(out.row.value, { datatype: 'num', num: 10_500 });
      deepStrictEqual(
        out.row.valid,
        { from: T1, to: T2 },
        'the new value inherits what it displaced',
      );
      strictEqual(out.row.supersedes, original.factId);
      strictEqual(isOpen(out.row.asserted), true);
    },
  },

  {
    name: 'rule 3: a change AT the instant the covering interval opened is a correction, not a split',
    async run(store, fx) {
      const { row: original } = await assertFact(store, input(fx, { validFrom: T0 }), T0);

      const out = await recordChange(
        store,
        { ...input(fx, { value: { datatype: 'num', num: 8800 }, observedAt: T1 }), validFrom: T0 },
        T1,
      );

      // The recorded value never held for a single instant, so we were wrong
      // from the start. Splitting would mint [T0, T0): an interval containing no
      // instant, which asserts nothing and which 009 refuses outright.
      const old = await store.byId(original.factId);
      deepStrictEqual(old?.valid, { from: T0, to: null }, 'a correction never touches valid');
      strictEqual(old?.asserted.to, T1);

      strictEqual(out.kind, 'correction');
      strictEqual(out.prior, null);
      deepStrictEqual(
        out.row.valid,
        { from: T0, to: null },
        'the window is copied, not recomputed',
      );
      strictEqual(out.row.supersedes, original.factId);
    },
  },

  {
    name: "rule 3: a change AT a closed interval's exclusive upper bound opens a fresh interval",
    async run(store, fx) {
      const { row: original } = await assertFact(
        store,
        input(fx, { validFrom: T0, validTo: T2 }),
        T0,
      );

      const out = await recordChange(
        store,
        {
          ...input(fx, { value: { datatype: 'num', num: 11_000 }, observedAt: T2 }),
          validFrom: T2,
        },
        T2,
      );

      // [from, to) is half-open, so nothing covers T2: nothing to close, nothing
      // to correct, and [T0, T2) is still exactly what we believe.
      strictEqual(out.kind, 'opened');
      strictEqual(out.closed, null);
      strictEqual(out.prior, null);
      strictEqual(out.row.supersedes, null);

      const old = await store.byId(original.factId);
      deepStrictEqual(old?.valid, { from: T0, to: T2 });
      strictEqual(old?.asserted.to, null);
    },
  },

  {
    name: 'rule 3: correcting a belief at the instant it opened is refused — now() is frozen per transaction',
    async run(store, fx) {
      // Postgres does not advance now() inside a transaction, so a row inserted
      // and corrected in one withTx closes asserted at the instant it opened: an
      // EMPTY range, which 009 refuses and the adapter reports as
      // EmptyRangeError. Refused above the store, so both fail identically — and
      // refused before any write, because withTx has no savepoints and a
      // correction that closed a belief without inserting its replacement is
      // worse than one that never ran.
      const { row: original } = await assertFact(
        store,
        input(fx, { validFrom: T0, validTo: T2, observedAt: T3 }),
        T3,
      );

      await rejects(
        () =>
          recordChange(
            store,
            {
              ...input(fx, { value: { datatype: 'num', num: 10_500 }, observedAt: T3 }),
              validFrom: T1,
            },
            T3,
          ),
        /no instant/,
      );

      strictEqual((await store.byId(original.factId))?.asserted.to, null, 'nothing half-applied');
      strictEqual((await store.forPredicate(fx.entityId, fx.predicate)).length, 1);
    },
  },

  {
    name: 'rule 2: a wrong END DATE is corrected on the asserted axis, by superseding',
    async run(store, fx) {
      // 009, verbatim: "a wrong end date is corrected on the ASSERTED axis —
      // close asserted and supersede — never by rewriting valid."
      const { row: original } = await assertFact(
        store,
        input(fx, { validFrom: T0, validTo: T2 }),
        T0,
      );

      const fixed = await correctFact(store, original.factId, original.value, {
        sourceId: fx.sourceId,
        observedAt: T3,
        method: 'human',
        now: T3,
        valid: { from: T0, to: T1 },
      });

      deepStrictEqual(fixed.valid, { from: T0, to: T1 });
      strictEqual(fixed.supersedes, original.factId);
      strictEqual(isOpen(fixed.asserted), true);

      const old = await store.byId(original.factId);
      deepStrictEqual(old?.valid, { from: T0, to: T2 }, 'the old window stays queryable');
      strictEqual(old?.asserted.to, T3);
    },
  },

  {
    name: 'rule 3: with two intervals covering the instant, the one a READ would surface is the one closed',
    async run(store, fx) {
      // Two sources disagreeing about one period is an unresolved FACTUAL
      // conflict, which fact_conflict adjudicates and this call may not resolve.
      // It must still be deterministic: forPredicate is insertion-ordered in
      // memory and lower(asserted)-ordered in Postgres, so "the first match"
      // was a different row in each store.
      const early = await store.insert(
        draft(fx, { asserted: { from: T0, to: null }, value: { datatype: 'num', num: 8800 } }),
      );
      const late = await store.insert(draft(fx, { asserted: { from: T1, to: null } }));

      const out = await recordChange(
        store,
        {
          ...input(fx, { value: { datatype: 'num', num: 12_000 }, observedAt: T3 }),
          validFrom: T2,
        },
        T3,
      );

      strictEqual(out.kind, 'change');
      strictEqual(
        out.closed?.factId,
        late.factId,
        'the latest belief is what the world changed from',
      );
      strictEqual(out.closed?.valid.to, T2);

      const untouched = await store.byId(early.factId);
      strictEqual(untouched?.valid.to, null, 'the other side of the disagreement is left alone');
      strictEqual(untouched?.asserted.to, null);
    },
  },
];
