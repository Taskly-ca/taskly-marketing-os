/**
 * In-memory `FactStore`, for tests and for running the pipeline before a
 * database exists.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: a fake that is more permissive than the
 * database is not a test double, it is a source of false confidence. Migration
 * 009's own header is the receipt — "the in-memory adapter has no trigger, so
 * the entire Part 3 suite exercised a store the Postgres one could never be" —
 * and a thousand green tests said the bitemporal model worked while
 * `closeValid` had never once been possible against a real database.
 *
 * So every rule the schema enforces on a write this port can make is enforced
 * here, in the order and with the wording `createPostgresFactStore` uses, and
 * `packages/adapters/src/testing/fact-store.conformance.ts` runs the same cases
 * against both stores so "they agree" is checked rather than hoped.
 *
 * What is enforced, and where it comes from:
 *
 *   · a bound is closable exactly ONCE, infinite → finite    009
 *   · a lower bound never moves — closing at or before it     009 (`isempty`)
 *     opened is an EMPTY interval, and asserts nothing
 *   · both axes obey the identical discipline                 009 shares one
 *                                                             function between
 *                                                             them; so does this
 *   · a range whose upper bound precedes its lower cannot     Postgres refuses
 *     be constructed at all                                   to build it
 *
 * What CANNOT be enforced here, and is therefore still a divergence: this store
 * has no foreign keys, so an unknown `entityId`/`predicate`/`sourceId` is
 * accepted where Postgres raises. See `packages/adapters/README.md`.
 */
import type { FactRow, FactStatus, FactStore, Range } from './types.js';

const ms = (iso: string): number => new Date(iso).getTime();

/* ── the failure taxonomy ──────────────────────────────────────────────────
 *
 * These names are `@tmos/adapters`'s `errors.ts`, mirrored. They cannot be
 * imported: `@tmos/adapters` depends on `@tmos/world`, and this package reaches
 * for nothing — "no package in this repo reaches a database or a network
 * directly" is the first thing its index says.
 *
 * `name` is taken from the class actually constructed, so `error.name` is the
 * SAME STRING whichever store threw. That is what a conformance case can assert
 * about both without either package importing the other's classes.
 */

/** Base class, so `catch (e) { if (e instanceof MemoryStoreError) … }` works. */
export class MemoryStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The row is not there. Message copied from the Postgres store, verbatim. */
export class NotFoundError extends MemoryStoreError {}

/** 009: a bound that is already closed was closed again, or moved backwards. */
export class AppendOnlyError extends MemoryStoreError {}

/**
 * A range was asked to close at the instant it opened, which produces an
 * interval containing no instant at all.
 *
 * The common cause is not a bad timestamp — it is `now()` being FROZEN for the
 * whole of a Postgres transaction, so a row inserted and closed inside one
 * `withTx` gives both bounds the same value.
 */
export class EmptyRangeError extends MemoryStoreError {}

/** Anything else the database would refuse: a check, a cast, a malformed range. */
export class ConstraintError extends MemoryStoreError {}

/**
 * A range Postgres could not build in the first place.
 *
 * `tstzrange(a, b)` with `b < a` raises 22000 before any trigger runs, and an
 * unparseable bound raises 22007 on the cast. Neither was checked here, so an
 * inverted or garbage range was stored silently and every read of it afterwards
 * was a read of something the database would never have held.
 *
 * `to === from` is deliberately NOT rejected here — that is emptiness, and it
 * is `assertStorable`'s business, on the axes only.
 */
function assertConstructible(r: Range, axis: 'valid' | 'asserted', op: string): void {
  for (const [bound, iso] of [
    ['from', r.from],
    ['to', r.to],
  ] as const) {
    if (iso !== null && Number.isNaN(ms(iso))) {
      throw new ConstraintError(
        `${op}: invalid input syntax for type timestamp with time zone: ${JSON.stringify(iso)} ` +
          `(${axis}.${bound})`,
      );
    }
  }

  if (r.to !== null && ms(r.to) < ms(r.from)) {
    throw new ConstraintError(
      `${op}: range lower bound must be less than or equal to range upper bound — ` +
        `${axis} ${r.from}..${r.to}`,
    );
  }
}

/**
 * An EMPTY range on INSERT, which is the one rule here that 009 does not state.
 *
 * 009's guards are `before update` and `before delete` only, so Postgres will
 * happily accept `tstzrange(T, T)` on the way in — and then `lower()` and
 * `upper()` of an empty range are both NULL, so the adapter's own decoder
 * refuses the row it just wrote (`DecodeError: valid.from: expected a
 * timestamp, got null`) and every later read of that entity refuses it too.
 * Through the port the observable is identical to a rejection, so this store
 * rejects, up front, where the row cannot be written rather than after it can
 * never be read again.
 *
 * The real fix is a `check (not isempty(valid) and not isempty(asserted))` in a
 * new migration; `supabase/migrations/**` is a locked, serial file. Recorded in
 * this lane's report.
 */
function assertStorable(r: Range, axis: 'valid' | 'asserted', op: string): void {
  assertConstructible(r, axis, op);
  if (r.to !== null && ms(r.to) === ms(r.from)) {
    throw new ConstraintError(
      `${op}: ${axis} ${r.from}..${r.to} contains no instant — an interval that contains no ` +
        'instant asserts nothing. Postgres accepts it on INSERT (009 guards UPDATE and DELETE ' +
        'only) and then cannot decode the row back: lower() and upper() of an empty range are ' +
        'both null.',
    );
  }
}

let counter = 0;
/** Deterministic ids: a test that prints a fact id should be reproducible. */
const nextId = (): string => `fact_${(++counter).toString(36).padStart(6, '0')}`;

export function resetFactIds(): void {
  counter = 0;
}

export function createMemoryFactStore(): FactStore & { all(): FactRow[] } {
  const rows = new Map<string, FactRow>();

  const clone = (r: FactRow): FactRow => ({
    ...r,
    value: { ...r.value },
    valid: { ...r.valid },
    asserted: { ...r.asserted },
    evidence: { ...r.evidence },
  });

  /**
   * Both closers, sharing one implementation so the two axes cannot drift —
   * the same argument 009 makes for sharing `fact_range_append_only` between
   * them, and the same shape the Postgres adapter's `closeBound` has.
   *
   * The four failures are checked in the order the adapter diagnoses them
   * (missing row · already closed · empty · backwards), because the adapter's
   * WHERE clause fails all of them together and its second read decides which
   * one to report. A different order here would mean the same call reporting a
   * different reason in each store.
   */
  const closeBound = (axis: 'valid' | 'asserted', op: string, factId: string, at: string): void => {
    const row = rows.get(factId);
    if (!row) throw new NotFoundError(`${op}: no such fact ${factId}`);

    if (Number.isNaN(ms(at))) {
      throw new ConstraintError(
        `${op}: invalid input syntax for type timestamp with time zone: ${JSON.stringify(at)}`,
      );
    }

    const bounds = row[axis];

    // 009: `upper(fact.<axis>)` may be closed exactly once. Re-closing it moves
    // an end date that is itself a recorded value — falsification, not
    // correction — and it is the divergence that hid `recordChange`'s
    // closed-interval bug for months, because this store used to just overwrite.
    if (bounds.to !== null) {
      throw new AppendOnlyError(
        `${op}: ${factId} already closed at ${bounds.to}` +
          (axis === 'valid'
            ? ' — migration 009 permits infinite → finite once and nothing else; correct a ' +
              'wrong end date on the asserted axis, by superseding the row'
            : ''),
      );
    }

    if (ms(at) === ms(bounds.from)) {
      throw new EmptyRangeError(
        `${op}: ${at} is the instant ${axis} opened, so closing there stores an interval ` +
          'containing no instant, which migration 009 rejects. If this is unexpected: now() is ' +
          'FROZEN for a whole transaction, so asserting and then closing a fact inside one ' +
          'withTx() gives both bounds the same timestamp. Take the instant from the caller, ' +
          'or close in a later transaction.',
      );
    }

    // Symmetric on both axes, which it was not: `closeValid` checked this and
    // `closeAsserted` had no check at all, so "we stopped believing it before
    // we started" was storable.
    if (ms(at) < ms(bounds.from)) {
      throw new AppendOnlyError(`${op}: ${at} precedes ${axis}.from ${bounds.from}`);
    }

    row[axis] = { ...bounds, to: at };
  };

  return {
    async insert(row) {
      assertStorable(row.valid, 'valid', 'insert');
      assertStorable(row.asserted, 'asserted', 'insert');

      const stored: FactRow = { ...clone(row as FactRow), factId: nextId() };
      rows.set(stored.factId, stored);
      return clone(stored);
    },

    async byId(factId) {
      const r = rows.get(factId);
      return r ? clone(r) : null;
    },

    async forPredicate(entityId, predicate) {
      return [...rows.values()]
        .filter((r) => r.entityId === entityId && r.predicate === predicate)
        .map(clone);
    },

    async forEntity(entityId) {
      return [...rows.values()].filter((r) => r.entityId === entityId).map(clone);
    },

    async closeAsserted(factId, at) {
      closeBound('asserted', 'closeAsserted', factId, at);
    },

    async closeValid(factId, at) {
      closeBound('valid', 'closeValid', factId, at);
    },

    async setStatus(factId, status: FactStatus) {
      const r = rows.get(factId);
      if (!r) throw new NotFoundError(`setStatus: no such fact ${factId}`);
      r.status = status;
    },

    all() {
      return [...rows.values()].map(clone);
    },
  };
}
