/**
 * The bitemporal fact contract.
 *
 * Two time axes, and confusing them is the single most damaging error in this
 * class of system:
 *
 *   valid    — when the fact was TRUE IN THE WORLD
 *   asserted — when WE BELIEVED IT
 *
 * A competitor raising their price on Aug 1 and us *noticing* on Aug 4 are two
 * different timestamps, and a system with one axis has to discard one of them.
 * Discarding `asserted` makes every past decision unauditable ("why did we act
 * on a stale price?"). Discarding `valid` makes retroactive correction
 * impossible — which is exactly the limitation of SCD Type 2.
 *
 * This is also why classical event sourcing is the wrong tool here: "what did
 * we believe on date D" is a bitemporal READ, not a state reconstruction.
 */

/** Postgres `tstzrange` semantics: `[from, to)` — inclusive lower, exclusive
 *  upper. `to: null` is an open upper bound, i.e. still in force. */
export interface Range {
  from: string;
  to: string | null;
}

export type FactStatus = 'active' | 'retracted' | 'disputed';
export type FactMethod = 'llm_extract' | 'scrape' | 'api' | 'human';

/** Exactly one of the object_* columns is populated, per `predicate_def.datatype`. */
export type FactValue =
  | { datatype: 'text'; text: string }
  | { datatype: 'num'; num: number }
  | { datatype: 'entity'; entityId: string }
  | { datatype: 'json'; json: Record<string, unknown> };

export interface Evidence {
  url?: string;
  snippet?: string;
  hash?: string;
  /** Versioned so an improved extractor can RE-RUN and correct — a new asserted
   *  interval — rather than overwrite what the old one produced. */
  extractorVersion?: string;
  promptVersion?: string;
}

export interface FactRow {
  factId: string;
  entityId: string;
  predicate: string;
  value: FactValue;
  valid: Range;
  asserted: Range;
  sourceId: string;
  /** Distinct from `valid.from`: it tells a stale scrape apart from a real
   *  change. A page fetched today saying "since 2024" has observedAt=today. */
  observedAt: string;
  confidence: number;
  method: FactMethod;
  evidence: Evidence;
  supersedes: string | null;
  status: FactStatus;
}

/** What a caller supplies; the store assigns ids and the asserted range. */
export interface FactInput {
  entityId: string;
  predicate: string;
  value: FactValue;
  /** When it became true in the world. Defaults to `observedAt` when a source
   *  gives no in-world date — with the honest consequence that we cannot tell
   *  "changed today" from "we looked today". */
  validFrom?: string;
  validTo?: string | null;
  sourceId: string;
  observedAt: string;
  confidence?: number;
  method: FactMethod;
  evidence?: Evidence;
}

/**
 * The persistence port. Kept narrow deliberately: every method maps to one
 * statement, so the Postgres adapter is mechanical and the in-memory adapter is
 * a faithful stand-in rather than a simulation with its own behaviour.
 */
export interface FactStore {
  insert(row: Omit<FactRow, 'factId'>): Promise<FactRow>;
  byId(factId: string): Promise<FactRow | null>;
  /** Every row for the pair, in insertion order. Filtering is the caller's job
   *  so the temporal predicates live in ONE place (query.ts) rather than being
   *  reimplemented per adapter. */
  forPredicate(entityId: string, predicate: string): Promise<FactRow[]>;
  forEntity(entityId: string): Promise<FactRow[]>;
  /** Closes an open upper bound. The append-only trigger permits this: it
   *  mutates a bound, never a value. */
  closeAsserted(factId: string, at: string): Promise<void>;
  closeValid(factId: string, at: string): Promise<void>;
  setStatus(factId: string, status: FactStatus): Promise<void>;
}

/* ── range helpers — `[from, to)` throughout ────────────────────────────── */

const t = (iso: string): number => new Date(iso).getTime();

export function rangeContains(r: Range, instant: string): boolean {
  const at = t(instant);
  if (Number.isNaN(at)) return false;
  if (at < t(r.from)) return false;
  return r.to === null || at < t(r.to);
}

export const isOpen = (r: Range): boolean => r.to === null;

export function rangesOverlap(a: Range, b: Range): boolean {
  const aEnd = a.to === null ? Infinity : t(a.to);
  const bEnd = b.to === null ? Infinity : t(b.to);
  return t(a.from) < bEnd && t(b.from) < aEnd;
}

/** Guards a caller from writing a range that ends before it starts. */
export function assertValidRange(r: Range): void {
  if (Number.isNaN(t(r.from))) throw new RangeError(`range.from is not a date: ${r.from}`);
  if (r.to !== null) {
    if (Number.isNaN(t(r.to))) throw new RangeError(`range.to is not a date: ${r.to}`);
    if (t(r.to) < t(r.from))
      throw new RangeError(`range ends before it starts: ${r.from}..${r.to}`);
  }
}
