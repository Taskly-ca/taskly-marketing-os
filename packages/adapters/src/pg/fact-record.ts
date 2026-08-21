/**
 * `FactRow` (@tmos/world) → `FactRecord` (@tmos/surface). Pure; no I/O, no clock.
 *
 * This is the mapper Part 6 records as a known gap, and it lives here for the
 * reason `index.ts` gives: `packages/surface` deliberately does not depend on
 * `packages/world`, so the only file in the repo allowed to know both
 * vocabularies is one in this package. Four of the differences between the two
 * shapes are real, and each one is a decision rather than a rename.
 *
 * 1. `value: FactValue` → `value: string`. A four-variant tagged union becomes a
 *    rendered string, and two of the variants CANNOT be rendered from the row
 *    alone: `num` needs `predicate_def.unit`, `entity` needs a name. Those
 *    arrive as `FactViewLookups` — plain ReadonlyMaps, not ports. A port would
 *    be `await`ed per row, which over a page of facts is an N+1 by
 *    construction; a map is filled by ONE batched query per kind (see
 *    `factViewKeys`) and makes every test deterministic and keyless.
 *    A number with no unit is NOT rendered as a bare number:
 *    `predicates.ts` refuses a numeric predicate with no unit precisely because
 *    "a bare number is not a fact" — `99` becomes dollars in one brief and cents
 *    in another. It renders as `9900 (unit unrecorded)` instead. Same for an
 *    entity id we could not resolve: the id is shown, marked unresolved, never
 *    dressed up as a name.
 *
 * 2. `evidence: Evidence` → `evidence: EvidenceRef | null`. Not a conversion —
 *    a DATA-SUFFICIENCY gap. Every field of `Evidence` is optional;
 *    `EvidenceRef` REQUIRES `source_url`, `span` and `observed_at`. A fact with
 *    `evidence: {}` cannot produce a valid ref at all, which is what the `|
 *    null` is for. Nothing here invents a missing field — inventing a span is
 *    the exact memory-poisoning failure (OWASP ASI06) rule 4 in AGENTS.md
 *    forbids. The one field taken from outside the evidence blob is
 *    `observed_at`, from `FactRow.observedAt`, and that is honest rather than
 *    convenient: the row's comment says it is when the SOURCE WAS FETCHED ("a
 *    page fetched today saying 'since 2024' has observedAt=today"), which is
 *    exactly what `observed_at` means on a Signal and on an `EvidenceRef` — the
 *    instant this text was seen. It is emphatically NOT `valid.from`, and
 *    `valid.from` is never used here.
 *
 * 3. `method: FactMethod` → `basis: Basis`, derived. The only other derivation
 *    in the repo (`basisFor` in `world/src/query/tools.ts`) is per ANSWER over a
 *    row set; this one is per ROW, and the two must never disagree in the
 *    direction that overclaims. `BASIS_BY_METHOD` classifies exactly as
 *    `basisFor` does, so `weakestBasis(rows.map(basisForMethod))` reproduces it;
 *    the evidence cap below can only make a row WEAKER, never stronger.
 *    `verified_metric` is structurally unreachable — it is not a value in
 *    `BASIS_BY_METHOD` — for the reason `tools.ts` states: the world model holds
 *    claims about the OUTSIDE world, never our own instrumentation. No scraped
 *    fact can reach it.
 *
 * 4. `confidence` is DROPPED, and stays dropped. `entity-page.ts` says why: a
 *    surface has no use for it that is not a lie. It is not smuggled into
 *    `basis` either — `basis` here is a function of `method` and of whether a
 *    citable ref exists, never of the number.
 *
 * `Range`, `FactStatus` and `ConflictRecord` are declared twice — once in each
 * package — and TypeScript would let a `FactRow`'s `valid` pass straight through
 * because the two are structurally identical TODAY. Nothing here relies on that:
 * ranges are rebuilt field by field and statuses go through an exhaustive
 * `Record<WorldFactStatus, ViewFactStatus>`, so the day either declaration
 * drifts, this file fails to compile instead of quietly coercing. There is no
 * `as` in this file, deliberately.
 */
import { evidenceRefSchema } from '@tmos/contracts';
import type { Basis, EvidenceRef } from '@tmos/contracts';
import { weakestBasis } from '@tmos/surface';
import type {
  ConflictRecord as ViewConflictRecord,
  FactRecord,
  FactStatus as ViewFactStatus,
  Range as ViewRange,
} from '@tmos/surface';
import { normalizePredicateName } from '@tmos/world';
import type {
  ConflictRecord as WorldConflictRecord,
  FactMethod,
  FactRow,
  FactStatus as WorldFactStatus,
  FactValue,
  PredicateDef,
  Range as WorldRange,
} from '@tmos/world';

/* ── what the caller must supply ────────────────────────────────────────── */

/**
 * Everything a `FactRow` does not carry but a rendered fact needs. Maps, not
 * ports: one batched lookup per kind, filled before mapping, so no row here can
 * issue a query.
 */
export interface FactViewLookups {
  /** predicate name → its definition. Only `unit` is read, and it is read for
   *  every `num` value; `PredicateDef` itself is accepted so a caller can pass
   *  what `PredicateStore.all()` already gave it. */
  readonly predicates: ReadonlyMap<string, Pick<PredicateDef, 'unit'>>;
  /** entity id → display name, for `datatype: 'entity'` values. */
  readonly entityNames: ReadonlyMap<string, string>;
  /** source id → `source.name` (migration 001). `FactRow` carries only
   *  `sourceId` and no port returns the name with it, so it is batched too. */
  readonly sourceNames: ReadonlyMap<string, string>;
}

/** The keys a page of facts needs looked up. Collect once, query three times,
 *  then map — the whole reason this mapper takes maps instead of a port. */
export interface FactViewKeys {
  readonly predicates: readonly string[];
  readonly entityIds: readonly string[];
  readonly sourceIds: readonly string[];
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

export function factViewKeys(rows: readonly FactRow[]): FactViewKeys {
  const predicates: string[] = [];
  const entityIds: string[] = [];
  const sourceIds: string[] = [];
  for (const row of rows) {
    predicates.push(row.predicate);
    sourceIds.push(row.sourceId);
    if (row.value.datatype === 'entity') entityIds.push(row.value.entityId);
  }
  return {
    predicates: sorted(predicates),
    entityIds: sorted(entityIds),
    sourceIds: sorted(sourceIds),
  };
}

/* ── value → display string ─────────────────────────────────────────────── */

/** Shown instead of a bare number. `predicates.ts` refuses a numeric predicate
 *  with no unit; a renderer that prints the number anyway re-opens the hole. */
export const UNIT_UNRECORDED = '(unit unrecorded)';

/** Shown after an entity id the lookup did not resolve. An unresolved id is a
 *  BROKEN lookup, not "no data" — `tools.ts` makes the same distinction. */
export const ENTITY_UNRESOLVED = '(entity name not on record)';

/** Locale-independent on purpose: `toLocaleString` would render a different
 *  string on a different ICU build, and `entity-page.ts` decides "the value
 *  changed" by comparing these strings. No rounding — the value is the value. */
const numberText = (num: number): string => String(num);

/** Object keys sorted at every depth, so the same document always renders the
 *  same string: `jsonb` does not preserve key order, and an ordering difference
 *  between two reads of one value would surface as a fabricated world change. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalJson((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** `predicate` is passed separately because only the fact row knows which
 *  predicate a value belongs to, and the unit lives on the predicate. */
export function renderFactValue(
  value: FactValue,
  predicate: string,
  lookups: FactViewLookups,
): string {
  switch (value.datatype) {
    case 'text':
      return value.text;
    case 'num': {
      // Tried raw first, then normalized: `PredicateStore.get` normalizes on the
      // way in, so a map keyed either way resolves.
      const def =
        lookups.predicates.get(predicate) ??
        lookups.predicates.get(normalizePredicateName(predicate));
      const unit = def?.unit ?? null;
      return `${numberText(value.num)} ${unit === null || unit === '' ? UNIT_UNRECORDED : unit}`;
    }
    case 'entity': {
      const name = lookups.entityNames.get(value.entityId);
      return name === undefined || name.trim() === ''
        ? `${value.entityId} ${ENTITY_UNRESOLVED}`
        : name;
    }
    case 'json':
      return JSON.stringify(canonicalJson(value.json));
  }
}

/* ── evidence → EvidenceRef | null ──────────────────────────────────────── */

/** An `EvidenceRef` is a pointer to a document a reader can open and check. A
 *  `javascript:` or `data:` URL is not one, and rendering it as a link is a
 *  hole; `z.url()` alone would accept both. */
function isFetchableUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Same instant, canonical spelling. `z.iso.datetime()` rejects `+00:00`, and
 *  losing a fact's whole citation over a timezone spelling is not a decision
 *  anyone would take on purpose. This is a re-spelling, never a substitution. */
const canonicalInstant = (iso: string): string | null => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** The contract's own uuid rule, reused rather than re-expressed as a second
 *  regex. A memory-store id like `fact_1` is not a uuid, so the back-pointer is
 *  null — which is what `fact_id` being nullable is for. It is never forced. */
const uuidOrNull = (id: string): string | null =>
  evidenceRefSchema.shape.fact_id.safeParse(id).success ? id : null;

/**
 * A ref, or null when the evidence cannot honestly produce one.
 *
 * Null whenever `url` is missing or is not a fetchable document, or `snippet` is
 * missing or blank — those two are `source_url` and `span`, both required, and
 * neither can be derived from anything else on the row. The result is validated
 * against `evidenceRefSchema` rather than trusted: this function builds an
 * object literal, and an object literal that merely looks right is how an
 * invalid ref reaches a reader.
 */
export function toEvidenceRef(row: FactRow): EvidenceRef | null {
  const { url, snippet } = row.evidence;
  if (typeof url !== 'string' || !isFetchableUrl(url)) return null;
  if (typeof snippet !== 'string' || snippet.trim() === '') return null;

  const observedAt = canonicalInstant(row.observedAt);
  if (observedAt === null) return null;

  const parsed = evidenceRefSchema.safeParse({
    signal_id: null,
    fact_id: uuidOrNull(row.factId),
    source_url: url,
    span: snippet,
    observed_at: observedAt,
  });
  return parsed.success ? parsed.data : null;
}

/* ── method → basis ─────────────────────────────────────────────────────── */

/**
 * Per row, and never stronger than the method earns.
 *
 * `llm_extract` is a model reading prose: an inference, cited but not measured.
 * `scrape` is a deterministic extraction from a cited page and `api`/`human` are
 * typed reads — governed, re-runnable, checkable. `verified_metric` appears
 * nowhere: it means "measured by our own instrumentation", and this table maps
 * claims about the outside world.
 */
const BASIS_BY_METHOD: Record<FactMethod, Basis> = {
  llm_extract: 'inferred_from_sources',
  scrape: 'governed_query',
  api: 'governed_query',
  human: 'governed_query',
};

export const basisForMethod = (method: FactMethod): Basis => BASIS_BY_METHOD[method];

/** The two methods whose value was READ OUT OF A DOCUMENT. Their claim to be
 *  checkable rests on the citation; the other two rest on the source row. */
const READS_A_DOCUMENT: ReadonlySet<FactMethod> = new Set<FactMethod>(['llm_extract', 'scrape']);

/**
 * The method's basis, capped when nothing citable came with it.
 *
 * A `scrape` with no recoverable ref would otherwise render "Governed query ·
 * safe to act on" with nothing a reader can open — `renderedBasis` only degrades
 * the label for `inferred_from_sources`, so the overclaim would survive all the
 * way to the page. Capping (through `weakestBasis`, so it can only weaken) turns
 * it into "Inferred — no independent source", which is what it is. `api` and
 * `human` are untouched: their provenance is the source row, not a span.
 */
export function basisForFact(row: FactRow, evidence: EvidenceRef | null): Basis {
  const fromMethod = basisForMethod(row.method);
  if (evidence !== null || !READS_A_DOCUMENT.has(row.method)) return fromMethod;
  return weakestBasis([fromMethod, 'inferred_from_sources']);
}

/* ── the two vocabularies, reconciled by hand ───────────────────────────── */

/** Exhaustive on the world side, checked against the view side. A new status in
 *  either package breaks the build here rather than passing through. */
const STATUS: Record<WorldFactStatus, ViewFactStatus> = {
  active: 'active',
  retracted: 'retracted',
  disputed: 'disputed',
};

/** Rebuilt, not passed through: two identical declarations are still two, and a
 *  fresh object also stops a view mutating the row it came from. */
const toViewRange = (r: WorldRange): ViewRange => ({ from: r.from, to: r.to });

/* ── the mapper ─────────────────────────────────────────────────────────── */

export function toFactRecord(row: FactRow, lookups: FactViewLookups): FactRecord {
  const evidence = toEvidenceRef(row);
  return {
    factId: row.factId,
    predicate: row.predicate,
    value: renderFactValue(row.value, row.predicate, lookups),
    valid: toViewRange(row.valid),
    asserted: toViewRange(row.asserted),
    sourceId: row.sourceId,
    sourceName: lookups.sourceNames.get(row.sourceId) ?? null,
    evidence,
    observedAt: row.observedAt,
    status: STATUS[row.status],
    basis: basisForFact(row, evidence),
    supersedes: row.supersedes,
  };
}

export const toFactRecords = (rows: readonly FactRow[], lookups: FactViewLookups): FactRecord[] =>
  rows.map((row) => toFactRecord(row, lookups));

/**
 * The other shape declared in both packages. The view drops `entityId` — the
 * page is already scoped to one entity — and `factIds` is copied rather than
 * shared, for the same reason ranges are rebuilt.
 */
export function toConflictRecord(conflict: WorldConflictRecord): ViewConflictRecord {
  return {
    id: conflict.id,
    predicate: conflict.predicate,
    kind: conflict.kind,
    status: conflict.status,
    validInstant: conflict.validInstant,
    factIds: [...conflict.factIds],
  };
}
