/**
 * Conformance: one set of assertions, run against BOTH implementations of a
 * port.
 *
 * The argument for it is `taskly-brain`'s own record of what went wrong here.
 * Migration 009's header: "the in-memory adapter has no trigger, so the entire
 * Part 3 suite exercised a store the Postgres one could never be." A thousand
 * green tests said the bitemporal model worked; the first contact with a real
 * database found that `closeValid` had never been possible. Tests written
 * against one implementation prove things about that implementation.
 *
 * So the cases below are DATA, not tests: a name and an async function taking a
 * store and its fixtures. `memory-conformance.test.ts` runs them against
 * `createMemoryFactStore` with no database at all; `*.live.test.ts` runs the
 * same array against Postgres inside a transaction it rolls back. When the two
 * disagree, one of them is wrong and the diff is one line of output.
 *
 * Framework-agnostic on purpose — assertions are `node:assert/strict`, so
 * nothing in `src/` imports vitest and any runner can drive these.
 */
import { AssertionError } from 'node:assert/strict';

export interface ConformanceCase<Store, Fixtures> {
  readonly name: string;
  readonly run: (store: Store, fixtures: Fixtures) => Promise<void>;
}

/**
 * Asserts that `run` rejects, and that the message matches. Both stores must
 * fail for the same reason, not merely fail — a store that throws
 * "connection terminated" would otherwise pass a test for "no such fact".
 */
export async function rejects(run: () => Promise<unknown>, match: RegExp): Promise<Error> {
  let error: unknown;
  try {
    await run();
  } catch (thrown) {
    error = thrown;
  }

  if (error === undefined) {
    throw new AssertionError({ message: `expected a rejection matching ${match}, but it resolved` });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!match.test(message)) {
    throw new AssertionError({ message: `expected ${match} — got: ${message}` });
  }
  return error as Error;
}

/** A syntactically valid uuid that nothing will ever hold. */
export const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';
