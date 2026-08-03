import type { ResolverSpec } from '@tmos/contracts';

/**
 * Resolvers turn a prediction into a machine-checkable outcome.
 *
 * The rule that makes the whole calibration loop honest: **a resolver must
 * dry-run at write time**. If it cannot execute today against past data and
 * return a value, the prediction is not machine-scoreable and the write is
 * rejected. That is what separates
 *
 *   "will Jiffy gain traction"                                    ← rejected
 *   "will Jiffy's Toronto category count exceed 40 on 2026-11-01" ← accepted
 *
 * Ambiguity ANNULS. It never guesses — a guessed resolution silently corrupts
 * the track record, which is the one asset this system is built to accumulate.
 */

/** Single source of truth: the shape lives in @tmos/contracts and is re-exported
 *  here so callers of this package never hand-write it a second time. */
export type { ResolverSpec };
export type ResolverKind = ResolverSpec['kind'];

/** Outcome of executing a resolver. `annulled` carries no score and no penalty. */
export type ResolverOutcome =
  | { outcome: 1; observed: unknown }
  | { outcome: 0; observed: unknown }
  | { outcome: 'annulled'; reason: string; observed?: unknown };

export interface ResolverContext {
  /** Everything I/O lives behind these, so every resolver is unit-testable
   *  without a network or a database. */
  query?: (sql: string) => Promise<ReadonlyArray<Record<string, unknown>>>;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
  now?: () => Date;
}

export interface Resolver {
  readonly kind: ResolverKind;
  /** Validate the spec is well-formed. Cheap, no I/O. */
  parse(spec: ResolverSpec): { ok: true } | { ok: false; error: string };
  /** Execute for real. */
  run(spec: ResolverSpec, ctx: ResolverContext): Promise<ResolverOutcome>;
}

/** Comparators shared by the http_json and scrape_assert resolvers. */
export const COMPARATORS = ['>', '>=', '<', '<=', '==', '!=', 'contains'] as const;
export type Comparator = (typeof COMPARATORS)[number];

export function isComparator(v: string): v is Comparator {
  return (COMPARATORS as readonly string[]).includes(v);
}

export function compare(left: unknown, op: Comparator, right: string): boolean {
  if (op === 'contains') return String(left).includes(right);
  if (op === '==') return String(left) === right;
  if (op === '!=') return String(left) !== right;

  const l = Number(left);
  const r = Number(right);
  if (Number.isNaN(l) || Number.isNaN(r)) {
    throw new Error(`non-numeric comparison: ${String(left)} ${op} ${right}`);
  }
  switch (op) {
    case '>':
      return l > r;
    case '>=':
      return l >= r;
    case '<':
      return l < r;
    case '<=':
      return l <= r;
  }
}

/**
 * Parse the shared `<lhs> <op> <rhs>` spec form used by two resolver kinds.
 *
 * Splits on the FIRST comparator token rather than on the first whitespace, so
 * the target may legitimately contain spaces (`count:Growth|Performance
 * Marketing >= 1`). An earlier version anchored on whitespace and rejected
 * three of the twenty seed questions with a misleading "unknown comparator"
 * error — the constraint was the parser's, not the spec author's.
 */
export function parseAssertion(
  spec: string,
): { ok: true; lhs: string; op: Comparator; rhs: string } | { ok: false; error: string } {
  const tokens = spec.trim().split(/\s+/);
  const opIndex = tokens.findIndex((t) => isComparator(t));

  if (opIndex === -1) {
    return {
      ok: false,
      error: `no comparator found in "${spec}" (expected one of ${COMPARATORS.join(', ')})`,
    };
  }
  if (opIndex === 0) return { ok: false, error: `missing target before "${tokens[0]}"` };
  if (opIndex === tokens.length - 1) {
    return { ok: false, error: `missing value after "${tokens[opIndex]}"` };
  }

  return {
    ok: true,
    lhs: tokens.slice(0, opIndex).join(' '),
    op: tokens[opIndex] as Comparator,
    rhs: tokens.slice(opIndex + 1).join(' '),
  };
}
