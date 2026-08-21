/**
 * The adapter error taxonomy.
 *
 * A port has an in-memory implementation and a Postgres one, and the domain
 * code above them is written against the in-memory one. Substitutability is
 * therefore not "the same rows come back" — it is also "the same failures come
 * back". A raw `error: new row for relation "fact" violates foreign key
 * constraint "fact_source_id_fkey"` leaking out of `insert()` is a broken port:
 * the caller cannot catch it by type, cannot match it against what the memory
 * store throws, and cannot tell a bug from a trigger doing its job.
 *
 * So every method funnels through `guard()`, and every Postgres error becomes
 * one of the classes below with `cause` preserved. Where the memory store
 * throws for the same reason, the MESSAGE is copied verbatim from it — a test
 * written as `rejects.toThrow('closeAsserted: no such fact f_1')` has to pass
 * against both stores or the word "substitutable" is doing no work.
 *
 * These classes are deliberately generic (not fact- or predicate-specific):
 * every adapter added to this package should reuse them rather than mint its
 * own, so a caller can catch `NotFoundError` without knowing which port it came
 * from.
 */

/** Base class, so `catch (e) { if (e instanceof AdapterError) ... }` works. */
export class AdapterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // `new.target` is the subclass actually constructed, so each one names
    // itself without repeating a string that can drift from the class.
    this.name = new.target.name;
  }
}

/** The row is not there. Message copied from the memory store, verbatim. */
export class NotFoundError extends AdapterError {}

/**
 * Migration 009: a value was rewritten, a lower bound moved, or a bound that is
 * already closed was closed again. History only ever grows.
 */
export class AppendOnlyError extends AdapterError {}

/**
 * A range was asked to close at or before the instant it opened, which produces
 * an interval containing no instant at all. 009 rejects it; before 009 it was
 * stored silently and matched nothing forever, which is worse.
 *
 * The common way to hit this is not a bad timestamp — it is `now()` being
 * FROZEN for the whole of a transaction. Insert and close in one `withTx` and
 * both instants are the same instant.
 */
export class EmptyRangeError extends AdapterError {}

/** A foreign key pointed at a row that does not exist (entity, source, predicate). */
export class MissingReferenceError extends AdapterError {}

/** Anything else the database refused: check, unique, malformed input syntax. */
export class ConstraintError extends AdapterError {}

/**
 * The database holds a shape this port cannot represent — a fact with no
 * `object_*` column populated, a `status` outside the union, a timestamp that
 * is not one. Distinct from the classes above on purpose: those mean "your
 * write was refused", this one means "the row that came back is not a FactRow",
 * and only the second one implicates the schema or another writer.
 */
export class DecodeError extends AdapterError {}

/* ── postgres error translation ─────────────────────────────────────────── */

/**
 * What a `pg` error looks like from the outside. Duck-typed on purpose: this
 * package must never import `pg` (that is `@tmos/db`'s job and its alone), and
 * the driver's error class is not exported in a form worth depending on.
 */
export interface PgErrorLike {
  /** SQLSTATE. Its PRESENCE is what marks the error as one the server raised. */
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
}

export function isPgError(error: unknown): error is PgErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; message?: unknown };
  // A SQLSTATE is required, not optional. Without it every `new Error(...)` —
  // including `Executor`'s own "expected exactly one row" — would be relabelled
  // as an AdapterError and lose the class the caller was going to match on.
  return typeof e.message === 'string' && typeof e.code === 'string';
}

/** SQLSTATE codes this repo's schema can actually produce. */
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
const INVALID_TEXT_REPRESENTATION = '22P02'; // e.g. 'fact_000001' passed as a uuid
const DATA_EXCEPTION = '22000'; // e.g. range lower bound must be <= upper bound
const RAISE_EXCEPTION = 'P0001'; // every `raise exception` in 001–012

/**
 * `raise exception` carries no SQLSTATE of its own, so the only thing that
 * separates 009's append-only messages from any other plpgsql raise is the
 * text. Matching text is unpleasant; the alternative — treating every P0001 as
 * generic — throws away the one distinction the caller most needs, since
 * "already closed" is a legitimate outcome a worker retries around and
 * "constraint violated" is a bug. Anchored on the fixed halves of 009's own
 * messages, which are in a migration and therefore do not drift casually.
 */
const APPEND_ONLY_PATTERNS = [
  /append-only/i,
  /is immutable/i,
  /is already closed at/i,
  /cannot be emptied/i,
  /would end \(.*\) before it starts/i,
];

/**
 * Wraps whatever the driver threw in the right class. Anything that is already
 * an `AdapterError` passes through untouched — the diagnostic paths in the
 * stores build far better messages than a SQLSTATE can, and must not be
 * relabelled on the way out.
 */
export function translatePgError(error: unknown, op: string): unknown {
  if (error instanceof AdapterError) return error;
  if (!isPgError(error)) return error;

  const detail = error.detail ? ` (${error.detail})` : '';
  const where = error.constraint ? ` [${error.constraint}]` : '';
  const message = `${op}: ${error.message}${detail}${where}`;

  switch (error.code) {
    case FOREIGN_KEY_VIOLATION:
      return new MissingReferenceError(
        `${message} — the row it points at does not exist. The in-memory store has no ` +
          'foreign keys and accepts orphans; Postgres does not.',
        { cause: error },
      );
    case UNIQUE_VIOLATION:
    case CHECK_VIOLATION:
    case NOT_NULL_VIOLATION:
    case INVALID_TEXT_REPRESENTATION:
    case DATA_EXCEPTION:
      return new ConstraintError(message, { cause: error });
    case RAISE_EXCEPTION:
      return APPEND_ONLY_PATTERNS.some((p) => p.test(error.message))
        ? new AppendOnlyError(message, { cause: error })
        : new ConstraintError(message, { cause: error });
    default:
      return new AdapterError(message, { cause: error });
  }
}

/** Every statement in this package runs inside one of these. */
export async function guard<T>(op: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translatePgError(error, op);
  }
}
