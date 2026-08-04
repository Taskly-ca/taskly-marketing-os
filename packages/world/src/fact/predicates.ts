/**
 * Predicates are DATA, not DDL.
 *
 * `predicate_def` is the open schema AND the semantic layer: adding an attribute
 * never needs a migration or a re-ingest, and the registry is what the query
 * tools describe to themselves — which turns a silent wrong answer into a loud
 * refusal. Two consequences shape this module:
 *
 *  - An extractor meeting an unknown attribute PROPOSES it. It does not fail
 *    (losing the observation) and it does not invent a column (making the
 *    schema a transcript of whatever an LLM said this week).
 *  - Promotion to `active` requires recurrence across DISTINCT sources. A raw
 *    occurrence count promotes whatever one chatty source repeats.
 *
 * A `proposed` predicate is fully usable — the FK only needs the row to exist.
 * Promotion governs what the semantic layer ADVERTISES, not what may be stored.
 */
import { rangeContains } from './types.js';
import type { FactRow, FactValue } from './types.js';
import { sameValue } from './write.js';

export type PredicateDatatype = 'text' | 'num' | 'entity' | 'json';
export type PredicateCardinality = 'one' | 'many';
export type PredicateStatus = 'proposed' | 'active' | 'deprecated';

export interface PredicateDef {
  predicate: string;
  entityType: string;
  datatype: PredicateDatatype;
  unit: string | null;
  cardinality: PredicateCardinality;
  status: PredicateStatus;
  description: string;
  aliases: string[];
  supersededBy: string | null;
  occurrences: number;
  /**
   * Inherently subjective (a rating, a sentiment, a "best"). Two sources
   * disagreeing about one of these is an OPINION, never a factual conflict, and
   * must never be fused into one number — `conflict.ts` reads this through
   * `ConflictContext.isSubjective`, so subjectivity is metadata rather than a
   * hardcoded name list.
   *
   * NOT a `predicate_def` column today; needs
   * `subjective boolean not null default false` in a later migration.
   */
  subjective: boolean;
  /**
   * NOT a `predicate_def` column today — the table carries only `occurrences`.
   * Promotion needs distinct sources, so this needs either a
   * `predicate_occurrence(predicate, source_id)` table or a `distinct_sources`
   * column in a later migration. Held in the port until then.
   */
  distinctSources: string[];
}

/**
 * Two distinct sources is the smallest number that can rule out "one source
 * invented this field", which is the entire purpose of the gate. Three would
 * stall genuinely narrow attributes — plenty of real predicates exist on a
 * competitor's own site and in exactly one trade directory.
 */
export const PROMOTION_MIN_DISTINCT_SOURCES = 2;

/**
 * Three occurrences (with ≥2 distinct sources) filters the one-off extraction
 * artefact. Both numbers are deliberately low: a proposed predicate is never
 * lost, so a slow promotion costs little, while a promoted junk predicate
 * pollutes the semantic layer every query tool reads.
 */
export const PROMOTION_MIN_OCCURRENCES = 3;

/** One attribute must not mint three predicates through spelling drift. */
export function normalizePredicateName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export interface PredicateStore {
  get(predicate: string): Promise<PredicateDef | null>;
  byAlias(alias: string): Promise<PredicateDef | null>;
  upsert(def: PredicateDef): Promise<PredicateDef>;
  all(): Promise<PredicateDef[]>;
}

export function createMemoryPredicateStore(
  seed: readonly PredicateDef[] = [],
): PredicateStore & { size(): number } {
  const defs = new Map<string, PredicateDef>();
  const clone = (d: PredicateDef): PredicateDef => ({
    ...d,
    aliases: [...d.aliases],
    distinctSources: [...d.distinctSources],
  });
  for (const d of seed) defs.set(d.predicate, clone(d));

  return {
    async get(predicate) {
      const d = defs.get(normalizePredicateName(predicate));
      return d ? clone(d) : null;
    },
    async byAlias(alias) {
      const wanted = normalizePredicateName(alias);
      for (const d of defs.values()) {
        if (d.aliases.some((a) => normalizePredicateName(a) === wanted)) return clone(d);
      }
      return null;
    },
    async upsert(def) {
      const stored = clone({ ...def, predicate: normalizePredicateName(def.predicate) });
      defs.set(stored.predicate, stored);
      return clone(stored);
    },
    async all() {
      return [...defs.values()].map(clone);
    },
    size() {
      return defs.size;
    },
  };
}

/* ── proposal + promotion ────────────────────────────────────────────────── */

export interface PredicateProposal {
  predicate: string;
  entityType: string;
  datatype: PredicateDatatype;
  unit?: string | null;
  cardinality?: PredicateCardinality;
  description: string;
  aliases?: string[];
  /** Defaults to false — claim objectivity explicitly, never by omission. */
  subjective?: boolean;
  /** Who observed it. Promotion counts DISTINCT values of this. */
  sourceId: string;
}

const withOccurrence = (def: PredicateDef, sourceId: string): PredicateDef => ({
  ...def,
  occurrences: def.occurrences + 1,
  distinctSources: def.distinctSources.includes(sourceId)
    ? [...def.distinctSources]
    : [...def.distinctSources, sourceId],
});

/**
 * An extractor meeting a new attribute lands here. Existing predicate (by name
 * or alias) ⇒ count the occurrence. Otherwise ⇒ a `proposed` row.
 */
export async function proposePredicate(
  store: PredicateStore,
  proposal: PredicateProposal,
): Promise<{ def: PredicateDef; created: boolean }> {
  const existing = await resolveAlias(store, proposal.predicate);
  if (existing) {
    return {
      def: await store.upsert(withOccurrence(existing.canonical, proposal.sourceId)),
      created: false,
    };
  }

  const def: PredicateDef = {
    predicate: normalizePredicateName(proposal.predicate),
    entityType: proposal.entityType,
    datatype: proposal.datatype,
    unit: proposal.unit ?? null,
    cardinality: proposal.cardinality ?? 'one',
    status: 'proposed',
    description: proposal.description,
    aliases: (proposal.aliases ?? []).map(normalizePredicateName),
    supersededBy: null,
    occurrences: 1,
    subjective: proposal.subjective ?? false,
    distinctSources: [proposal.sourceId],
  };
  return { def: await store.upsert(def), created: true };
}

/** Count another sighting without restating the definition. */
export async function recordOccurrence(
  store: PredicateStore,
  predicate: string,
  sourceId: string,
): Promise<PredicateDef> {
  const def = await store.get(predicate);
  if (!def) throw new Error(`recordOccurrence: unknown predicate ${predicate}`);
  return store.upsert(withOccurrence(def, sourceId));
}

export interface PromotionVerdict {
  eligible: boolean;
  reasons: string[];
}

export function evaluatePromotion(def: PredicateDef): PromotionVerdict {
  const reasons: string[] = [];
  if (def.status !== 'proposed') reasons.push(`status is ${def.status}, not proposed`);
  if (def.occurrences < PROMOTION_MIN_OCCURRENCES) {
    reasons.push(`${def.occurrences} occurrences, needs ${PROMOTION_MIN_OCCURRENCES}`);
  }
  if (def.distinctSources.length < PROMOTION_MIN_DISTINCT_SOURCES) {
    reasons.push(
      `${def.distinctSources.length} distinct source(s), needs ${PROMOTION_MIN_DISTINCT_SOURCES} — ` +
        'one source repeating itself is not recurrence',
    );
  }
  return { eligible: reasons.length === 0, reasons };
}

export async function promotePredicate(
  store: PredicateStore,
  predicate: string,
): Promise<{ promoted: boolean; def: PredicateDef; reasons: string[] }> {
  const def = await store.get(predicate);
  if (!def) throw new Error(`promotePredicate: unknown predicate ${predicate}`);
  const verdict = evaluatePromotion(def);
  if (!verdict.eligible) return { promoted: false, def, reasons: verdict.reasons };
  return { promoted: true, def: await store.upsert({ ...def, status: 'active' }), reasons: [] };
}

/* ── alias resolution ────────────────────────────────────────────────────── */

export interface AliasResolution {
  canonical: PredicateDef;
  via: 'exact' | 'alias';
  /** Every predicate visited, in order — the audit trail for a rename. */
  chain: string[];
  /** True when `supersededBy` looped; the last non-repeating def is returned. */
  cycle: boolean;
}

/**
 * A name (canonical, alias, or a deprecated predicate) → the row it means now,
 * following `supersededBy`. A rename chain that loops back on itself must not
 * hang the extractor, so the walk carries a seen-set and reports the loop.
 */
export async function resolveAlias(
  store: PredicateStore,
  name: string,
): Promise<AliasResolution | null> {
  const normalized = normalizePredicateName(name);
  let current = await store.get(normalized);
  const via: AliasResolution['via'] = current ? 'exact' : 'alias';
  if (!current) current = await store.byAlias(normalized);
  if (!current) return null;

  const chain = [current.predicate];
  const seen = new Set(chain);
  let cycle = false;

  while (current.supersededBy) {
    const next = normalizePredicateName(current.supersededBy);
    if (seen.has(next)) {
      cycle = true;
      break;
    }
    const def = await store.get(next);
    if (!def) break; // dangling pointer: keep the last real row rather than null
    seen.add(next);
    chain.push(def.predicate);
    current = def;
  }

  return { canonical: current, via, chain, cycle };
}

/* ── value validation ────────────────────────────────────────────────────── */

export type ValidationCode =
  'datatype_mismatch' | 'missing_unit' | 'cardinality_conflict' | 'deprecated_predicate';

export interface ValidationProblem {
  code: ValidationCode;
  message: string;
  /** For a cardinality conflict: the rows it collides with. */
  factIds?: string[];
}

export interface ValidationResult {
  ok: boolean;
  problems: ValidationProblem[];
  warnings: ValidationProblem[];
}

/**
 * Datatype, unit and cardinality — the three ways a value stores looking fine
 * and reads wrong later.
 *
 * The unit rule is about the DEFINITION, not the value: a numeric predicate
 * with no unit is how `99` becomes dollars in one brief and cents in another.
 *
 * A `one` predicate that already holds a different live value at the same
 * instant is a CONFLICT, not an overwrite — overwriting is how a real change or
 * a source disagreement vanishes with nobody deciding anything. Hand the pair
 * to `classifyConflict`.
 */
export function validateValue(
  def: PredicateDef,
  value: FactValue,
  opts: { existing?: readonly FactRow[]; at?: string } = {},
): ValidationResult {
  const problems: ValidationProblem[] = [];
  const warnings: ValidationProblem[] = [];

  if (value.datatype !== def.datatype) {
    problems.push({
      code: 'datatype_mismatch',
      message: `${def.predicate} is declared ${def.datatype}, got ${value.datatype}`,
    });
  }

  if (def.datatype === 'num' && !def.unit) {
    problems.push({
      code: 'missing_unit',
      message: `${def.predicate} is numeric with no unit — a bare number is not a fact`,
    });
  }

  if (def.status === 'deprecated') {
    warnings.push({
      code: 'deprecated_predicate',
      message: def.supersededBy
        ? `${def.predicate} is deprecated; superseded by ${def.supersededBy}`
        : `${def.predicate} is deprecated`,
    });
  }

  if (def.cardinality === 'one' && opts.existing && opts.at) {
    const at = opts.at;
    const collides = opts.existing.filter(
      (r) =>
        r.status === 'active' &&
        r.asserted.to === null &&
        r.predicate === def.predicate &&
        rangeContains(r.valid, at) &&
        !sameValue(r.value, value),
    );
    if (collides.length > 0) {
      problems.push({
        code: 'cardinality_conflict',
        message: `${def.predicate} is cardinality 'one' and already holds a different value at ${at} — resolve the conflict, do not overwrite`,
        factIds: collides.map((r) => r.factId).sort(),
      });
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}
