/**
 * Typed tools over the world model, plus ONE guarded escape hatch.
 *
 * The design claim: an agent handed raw SQL will eventually write a query that
 * is subtly wrong — a missing `upper_inf(asserted)`, a join that double-counts a
 * copy-chained source, a window that mixes the two time axes — and then report
 * the number with total confidence. Narrow typed tools make the questions we
 * actually ask unmissable, and make the unusual ones explicit rather than
 * improvised.
 *
 * Three rules every tool here obeys:
 *
 *  1. **Refuse rather than guess.** Ambiguous input and absent wiring are
 *     failures, not empty results.
 *  2. **"No data" and "lookup failed" are DIFFERENT returns.** An unknown entity
 *     id is broken; a known entity with nothing recorded is quiet-but-fine. The
 *     same quiet-vs-broken distinction the collectors make — collapsing them is
 *     how "we have no data" gets rendered as "the value is zero".
 *  3. **Never truncate silently.** A capped result says it was capped.
 *
 * Every answer carries the `factId`s under it and a `basis` saying how much it
 * can be trusted.
 */
import { rangeContains } from '../fact/types.js';
import type {
  FactMethod,
  FactRow,
  FactStatus,
  FactStore,
  FactValue,
  Range,
} from '../fact/types.js';
import { asOfBoth, asOfValid, assertionHistory } from '../fact/query.js';
import { sameValue } from '../fact/write.js';
import { normalizeName } from '../identity.js';
import type { Basis } from '@tmos/contracts';
import type { HardKey } from '../identity.js';

/**
 * The single source of truth for what an answer rests on lives in
 * `@tmos/contracts`. Re-exported here under a local name for readability at the
 * call sites — but it is an alias, never a second copy of the union.
 */
export type QueryBasis = Basis;

export type ToolFailure =
  'not_found' | 'ambiguous' | 'invalid_input' | 'unsupported' | 'rejected' | 'executor_failed';

export interface ToolOk<T> {
  ok: true;
  data: T;
  basis: QueryBasis;
  /** The evidence under the answer. Empty only when there is genuinely none. */
  factIds: string[];
  /** True when a cap cut the result. Never silently. */
  truncated: boolean;
  /** Set when the answer is empty-but-correct, or otherwise qualified. */
  note?: string;
}
export interface ToolErr {
  ok: false;
  code: ToolFailure;
  reason: string;
}
export type ToolResult<T> = ToolOk<T> | ToolErr;

const ok = <T>(
  data: T,
  basis: QueryBasis,
  factIds: string[] = [],
  note?: string,
  truncated = false,
): ToolOk<T> => ({ ok: true, data, basis, factIds, truncated, note });

const fail = (code: ToolFailure, reason: string): ToolErr => ({ ok: false, code, reason });

/**
 * An answer inherits the weakest basis of the evidence beneath it.
 *
 * A fact typed by a human or pulled from an API is a governed read; one an LLM
 * extracted from prose is an inference, and labelling it otherwise is the exact
 * overclaim this system exists to prevent. `verified_metric` is never returned
 * here: the world model holds claims about the OUTSIDE world, not our own
 * instrumented metrics.
 */
const basisFor = (rows: FactRow[]): QueryBasis =>
  rows.some((r) => r.method === 'llm_extract') ? 'inferred_from_sources' : 'governed_query';

/* ── ports ──────────────────────────────────────────────────────────────────
 * Kept as plain-TS ports so these tools stay pure: no I/O, no clock, no
 * database. A tool whose port is absent REFUSES; it never falls back to a
 * guess, because a guessed entity id is indistinguishable from a real one.
 */

export interface EntityRecord {
  entityId: string;
  entityType: string;
  name: string;
  nameNorm: string;
  region: string | null;
  keys: HardKey[];
}

export interface EntityDirectoryPort {
  byId(entityId: string): Promise<EntityRecord | null>;
  byHardKey(key: HardKey): Promise<EntityRecord | null>;
  byNameNorm(nameNorm: string): Promise<EntityRecord[]>;
}

export interface ConflictRecord {
  id: string;
  entityId: string;
  predicate: string;
  validInstant: string;
  factIds: string[];
  kind: 'temporal' | 'factual' | 'opinion';
  status: 'open' | 'resolved' | 'unresolvable';
}
export interface ConflictPort {
  openFor(entityId: string): Promise<ConflictRecord[]>;
}

/** Collapses copy chains: three blogs quoting one press release are ONE voice. */
export interface SourceGraphPort {
  rootOf(sourceId: string): Promise<string>;
}

/** Cross-entity access by predicate. Separate from `FactStore` because it is a
 *  different (indexed) access pattern, and because a tool without it must
 *  refuse rather than scan every row it can reach. */
export interface PredicateIndexPort {
  withPredicate(predicate: string): Promise<FactRow[]>;
}

export interface WorldQueryDeps {
  store: FactStore;
  entities?: EntityDirectoryPort;
  conflicts?: ConflictPort;
  sources?: SourceGraphPort;
  index?: PredicateIndexPort;
}

const MAX_ROWS = 500;
const capOf = (n?: number): number => Math.max(1, Math.min(n ?? 100, MAX_ROWS));
const ms = (iso: string): number => new Date(iso).getTime();
const isInstant = (s: string): boolean => typeof s === 'string' && !Number.isNaN(ms(s));
const capNote = (n: number): string =>
  `result capped at ${n} row(s) — there are more, ask a narrower question`;

/** An unknown entity id is a BROKEN lookup and must not be answered with an
 *  empty result. Without a directory wired we cannot tell, so we do not claim to. */
async function missingEntity(deps: WorldQueryDeps, entityId: string): Promise<ToolErr | null> {
  if (!entityId.trim()) return fail('invalid_input', 'entityId is empty');
  if (!deps.entities) return null;
  const found = await deps.entities.byId(entityId);
  return found
    ? null
    : fail('not_found', `no entity with id ${entityId} — the lookup failed; this is not "no data"`);
}

const NO_DIRECTORY = 'no entity directory is wired — refusing rather than guessing at an entity id';

/* ── 1–2: entities ──────────────────────────────────────────────────────── */

export async function getEntity(
  deps: WorldQueryDeps,
  input: { entityId: string },
): Promise<ToolResult<EntityRecord>> {
  if (!deps.entities) return fail('unsupported', NO_DIRECTORY);
  if (!input.entityId.trim()) return fail('invalid_input', 'entityId is empty');
  const found = await deps.entities.byId(input.entityId);
  return found
    ? ok(found, 'governed_query')
    : fail('not_found', `no entity with id ${input.entityId}`);
}

export interface FindEntitiesInput {
  hardKey?: HardKey;
  name?: string;
  limit?: number;
}

export async function findEntities(
  deps: WorldQueryDeps,
  input: FindEntitiesInput,
): Promise<ToolResult<EntityRecord[]>> {
  if (!deps.entities) return fail('unsupported', NO_DIRECTORY);
  const { hardKey, name } = input;

  if (hardKey) {
    const hit = await deps.entities.byHardKey(hardKey);
    return ok(
      hit ? [hit] : [],
      'governed_query',
      [],
      hit
        ? undefined
        : `no entity carries ${hardKey.kind}=${hardKey.valueNorm}; the key is absent, not the lookup broken`,
    );
  }
  if (!name) {
    return fail(
      'invalid_input',
      'give a hardKey or a name — "list the entities" is not a question this tool answers',
    );
  }

  const limit = capOf(input.limit);
  const norm = normalizeName(name);
  const hits = await deps.entities.byNameNorm(norm.norm);
  // A short or protected name must never be matched by similarity: `3m` and
  // `The Gap` score high against unrelated strings, and a wrong hard match
  // auto-merges two companies with no human in the loop.
  const note = norm.exactOnly
    ? `"${name}" is exact-only (${norm.reason}) — matched on the normalized name only, never scored`
    : hits.length === 0
      ? `no entity matches the normalized name "${norm.norm}"`
      : undefined;
  return ok(hits.slice(0, limit), 'governed_query', [], note, hits.length > limit);
}

/* ── 3–4: facts ─────────────────────────────────────────────────────────── */

export interface FactAnswer {
  value: FactValue | null;
  validFrom: string | null;
  observedAt: string | null;
  sourceId: string | null;
}

export async function getFact(
  deps: WorldQueryDeps,
  input: { entityId: string; predicate: string; at: string },
): Promise<ToolResult<FactAnswer>> {
  const broken = await missingEntity(deps, input.entityId);
  if (broken) return broken;
  if (!isInstant(input.at)) return fail('invalid_input', `at is not an ISO instant: ${input.at}`);

  const row = await asOfValid(deps.store, input.entityId, input.predicate, input.at);
  if (!row) {
    const recorded = (await deps.store.forPredicate(input.entityId, input.predicate)).length;
    return ok(
      { value: null, validFrom: null, observedAt: null, sourceId: null },
      'governed_query',
      [],
      recorded === 0
        ? `no fact has ever been recorded for ${input.predicate} on ${input.entityId} — an ABSENCE of data, not a failed lookup`
        : `${recorded} fact(s) exist for ${input.predicate} but none is valid at ${input.at}`,
    );
  }
  return ok(
    {
      value: row.value,
      validFrom: row.valid.from,
      observedAt: row.observedAt,
      sourceId: row.sourceId,
    },
    basisFor([row]),
    [row.factId],
  );
}

export interface HistoryEntry {
  factId: string;
  value: FactValue;
  valid: Range;
  asserted: Range;
  /** When we STOPPED believing it, or null if we still do. */
  correctedAt: string | null;
  sourceId: string;
  method: FactMethod;
  status: FactStatus;
  supersedes: string | null;
}

export async function getFactHistory(
  deps: WorldQueryDeps,
  input: { entityId: string; predicate: string; limit?: number },
): Promise<ToolResult<HistoryEntry[]>> {
  const broken = await missingEntity(deps, input.entityId);
  if (broken) return broken;

  const rows = await assertionHistory(deps.store, input.entityId, input.predicate);
  const limit = capOf(input.limit);
  const shown = rows.slice(0, limit);
  const data: HistoryEntry[] = shown.map((r) => ({
    factId: r.factId,
    value: r.value,
    valid: r.valid,
    asserted: r.asserted,
    correctedAt: r.asserted.to,
    sourceId: r.sourceId,
    method: r.method,
    status: r.status,
    supersedes: r.supersedes,
  }));
  const note =
    rows.length > limit
      ? capNote(limit)
      : rows.length === 0
        ? `nothing has ever been recorded for ${input.predicate} on ${input.entityId}`
        : undefined;
  return ok(
    data,
    basisFor(shown),
    shown.map((r) => r.factId),
    note,
    rows.length > limit,
  );
}

/* ── 5: comparison ──────────────────────────────────────────────────────── */

export async function compareEntities(
  deps: WorldQueryDeps,
  input: { entityIds: string[]; predicate: string; at: string },
): Promise<
  ToolResult<Array<{ entityId: string; value: FactValue | null; factId: string | null }>>
> {
  if (input.entityIds.length < 2) {
    return fail(
      'invalid_input',
      'compareEntities needs at least two entities — use getFact for one',
    );
  }
  if (new Set(input.entityIds).size !== input.entityIds.length) {
    return fail(
      'invalid_input',
      'duplicate entity ids — comparing an entity with itself is not a question',
    );
  }
  if (!isInstant(input.at)) return fail('invalid_input', `at is not an ISO instant: ${input.at}`);

  const rows: FactRow[] = [];
  const data = [];
  const missing: string[] = [];
  for (const entityId of input.entityIds) {
    const broken = await missingEntity(deps, entityId);
    if (broken) return broken;
    const row = await asOfValid(deps.store, entityId, input.predicate, input.at);
    if (row) rows.push(row);
    else missing.push(entityId);
    data.push({ entityId, value: row?.value ?? null, factId: row?.factId ?? null });
  }
  // Dropping the entities we know nothing about would turn a partial answer
  // into a confident one — the comparison would silently be over a subset.
  const note =
    missing.length > 0
      ? `no value at ${input.at} for: ${missing.join(', ')} — absent from the comparison, not zero`
      : undefined;
  return ok(
    data,
    basisFor(rows),
    rows.map((r) => r.factId),
    note,
  );
}

/* ── 6: the two axes ────────────────────────────────────────────────────── */

export type ChangeKind = 'world_change' | 'self_correction' | 'first_observation' | 'retraction';

export interface ChangeEntry {
  predicate: string;
  kind: ChangeKind;
  factId: string;
  previousFactId: string | null;
  value: FactValue;
  previousValue: FactValue | null;
  assertedAt: string;
  validFrom: string;
  why: string;
}

/**
 * What changed for an entity in a window — and, critically, WHICH AXIS moved.
 *
 * "They raised their price" and "we misread their price" produce the same
 * visible delta and mean opposite things. The world changing closes `valid`;
 * us being wrong closes `asserted`. A brief that reports our own correction as
 * a market move invents a trend out of our own error.
 */
export async function whatChanged(
  deps: WorldQueryDeps,
  input: { entityId: string; from: string; to: string; limit?: number },
): Promise<ToolResult<ChangeEntry[]>> {
  const broken = await missingEntity(deps, input.entityId);
  if (broken) return broken;
  if (!isInstant(input.from) || !isInstant(input.to)) {
    return fail('invalid_input', 'from and to must be ISO instants');
  }
  if (ms(input.to) <= ms(input.from)) {
    return fail('invalid_input', `window ends before it starts: ${input.from}..${input.to}`);
  }

  const rows = await deps.store.forEntity(input.entityId);
  const byId = new Map(rows.map((r) => [r.factId, r]));
  const inWindow = (iso: string): boolean => ms(iso) >= ms(input.from) && ms(iso) < ms(input.to);
  const out: ChangeEntry[] = [];

  for (const r of rows) {
    if (!inWindow(r.asserted.from)) continue;

    // `supersedes` is the explicit link; the two fallbacks catch rows written
    // without it, using the axes themselves rather than trusting the pointer.
    const explicit = r.supersedes ? (byId.get(r.supersedes) ?? null) : null;
    const closedBelief =
      explicit ??
      rows.find(
        (o) =>
          o.factId !== r.factId &&
          o.asserted.to === r.asserted.from &&
          rangeContains(o.valid, r.valid.from),
      ) ??
      null;
    const closedValid =
      explicit ?? rows.find((o) => o.factId !== r.factId && o.valid.to === r.valid.from) ?? null;

    let kind: ChangeKind;
    let previous: FactRow | null;
    if (closedBelief && closedBelief.valid.from === r.valid.from) {
      kind = 'self_correction';
      previous = closedBelief;
    } else if (closedValid) {
      kind = 'world_change';
      previous = closedValid;
    } else {
      kind = 'first_observation';
      previous = null;
    }

    out.push({
      predicate: r.predicate,
      kind,
      factId: r.factId,
      previousFactId: previous?.factId ?? null,
      value: r.value,
      previousValue: previous?.value ?? null,
      assertedAt: r.asserted.from,
      validFrom: r.valid.from,
      why:
        kind === 'self_correction'
          ? `we were wrong: the replacement carries the SAME valid range (${r.valid.from}) and the old row's asserted interval closed — our belief moved, the world did not`
          : kind === 'world_change'
            ? `the world moved: a new valid interval opens at ${r.valid.from} and the previous one closed there — a change in the world, not a change of mind`
            : 'first value we ever recorded for this predicate — new knowledge, not a change',
    });
  }

  // A retraction has no replacement row, so the loop above cannot see it — but
  // withdrawing a belief is one of the most important things we ever do.
  for (const r of rows) {
    if (r.status !== 'retracted' || r.asserted.to === null || !inWindow(r.asserted.to)) continue;
    out.push({
      predicate: r.predicate,
      kind: 'retraction',
      factId: r.factId,
      previousFactId: null,
      value: r.value,
      previousValue: null,
      assertedAt: r.asserted.to,
      validFrom: r.valid.from,
      why: `we withdrew this belief at ${r.asserted.to} and put nothing in its place — the row stays, so the audit trail survives`,
    });
  }

  out.sort((a, b) => ms(a.assertedAt) - ms(b.assertedAt) || (a.factId < b.factId ? -1 : 1));
  const limit = capOf(input.limit);
  const shown = out.slice(0, limit);
  return ok(
    shown,
    basisFor(rows.filter((r) => shown.some((c) => c.factId === r.factId))),
    shown.map((c) => c.factId),
    out.length > limit
      ? capNote(limit)
      : out.length === 0
        ? `nothing changed for ${input.entityId} between ${input.from} and ${input.to}`
        : undefined,
    out.length > limit,
  );
}

/* ── 7: Q3 ──────────────────────────────────────────────────────────────── */

export interface PastBelief {
  predicate: string;
  value: FactValue;
  factId: string;
  /** True if we have since changed our mind about this same instant. Judging a
   *  past decision against what we learned afterwards is hindsight bias with a
   *  database behind it, so the tool says when that gap exists. */
  correctedSince: boolean;
}

export async function whatWeBelievedAt(
  deps: WorldQueryDeps,
  input: { entityId: string; assertedAt: string; validAt?: string },
): Promise<ToolResult<PastBelief[]>> {
  const broken = await missingEntity(deps, input.entityId);
  if (broken) return broken;
  const validAt = input.validAt ?? input.assertedAt;
  if (!isInstant(input.assertedAt) || !isInstant(validAt)) {
    return fail('invalid_input', 'assertedAt and validAt must be ISO instants');
  }

  const rows = await deps.store.forEntity(input.entityId);
  const predicates = [...new Set(rows.map((r) => r.predicate))].sort();
  const data: PastBelief[] = [];
  const used: FactRow[] = [];
  for (const predicate of predicates) {
    const then = await asOfBoth(deps.store, input.entityId, predicate, validAt, input.assertedAt);
    if (!then) continue;
    const now = await asOfValid(deps.store, input.entityId, predicate, validAt);
    used.push(then);
    data.push({
      predicate,
      value: then.value,
      factId: then.factId,
      correctedSince: now !== null && now.factId !== then.factId,
    });
  }
  return ok(
    data,
    basisFor(used),
    used.map((r) => r.factId),
    data.length === 0
      ? `no facts were believed about ${input.entityId} at ${input.assertedAt}`
      : undefined,
  );
}

/* ── 8–10: cross-entity, provenance, conflicts ──────────────────────────── */

export interface EntitiesMatchingInput {
  predicate: string;
  at: string;
  equals?: FactValue;
  min?: number;
  max?: number;
  limit?: number;
}

export async function entitiesMatching(
  deps: WorldQueryDeps,
  input: EntitiesMatchingInput,
): Promise<ToolResult<Array<{ entityId: string; value: FactValue; factId: string }>>> {
  if (!deps.index) {
    return fail('unsupported', 'no predicate index is wired — refusing to scan the whole store');
  }
  const ranged = input.min !== undefined || input.max !== undefined;
  if (!input.equals && !ranged) {
    return fail(
      'invalid_input',
      'give equals, min or max — an unfiltered predicate sweep is a different and much more expensive question',
    );
  }
  if (input.equals && ranged) {
    return fail('invalid_input', 'equals and a numeric range are mutually exclusive');
  }
  if (!isInstant(input.at)) return fail('invalid_input', `at is not an ISO instant: ${input.at}`);

  const live = (await deps.index.withPredicate(input.predicate)).filter(
    (r) => r.status === 'active' && r.asserted.to === null && rangeContains(r.valid, input.at),
  );
  let skipped = 0;
  const hits = live.filter((r) => {
    if (input.equals) return sameValue(r.value, input.equals);
    if (r.value.datatype !== 'num') {
      skipped++;
      return false;
    }
    if (input.min !== undefined && r.value.num < input.min) return false;
    return !(input.max !== undefined && r.value.num > input.max);
  });

  const limit = capOf(input.limit);
  const shown = hits.slice(0, limit);
  const notes = [
    hits.length > limit ? capNote(limit) : null,
    skipped > 0 ? `${skipped} non-numeric value(s) skipped by the range filter` : null,
    hits.length === 0 ? `no entity matches ${input.predicate} at ${input.at}` : null,
  ].filter((n): n is string => n !== null);

  return ok(
    shown.map((r) => ({ entityId: r.entityId, value: r.value, factId: r.factId })),
    basisFor(shown),
    shown.map((r) => r.factId),
    notes.length > 0 ? notes.join('; ') : undefined,
    hits.length > limit,
  );
}

export interface Coverage {
  facts: number;
  sources: Array<{ sourceId: string; facts: number }>;
  distinctSources: number;
  /** Null when copy chains cannot be resolved — see the note. */
  independentSources: number | null;
}

export async function sourceCoverage(
  deps: WorldQueryDeps,
  input: { entityId: string },
): Promise<ToolResult<Coverage>> {
  const broken = await missingEntity(deps, input.entityId);
  if (broken) return broken;

  const rows = (await deps.store.forEntity(input.entityId)).filter(
    (r) => r.status === 'active' && r.asserted.to === null,
  );
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.sourceId, (counts.get(r.sourceId) ?? 0) + 1);
  const sources = [...counts]
    .map(([sourceId, facts]) => ({ sourceId, facts }))
    .sort((a, b) => b.facts - a.facts || (a.sourceId < b.sourceId ? -1 : 1));

  let independentSources: number | null = null;
  if (deps.sources) {
    const roots = new Set<string>();
    for (const s of sources) roots.add(await deps.sources.rootOf(s.sourceId));
    independentSources = roots.size;
  }

  const note =
    rows.length === 0
      ? `no facts recorded for ${input.entityId} — no coverage, not a failed lookup`
      : independentSources === null
        ? `no source graph wired: ${counts.size} distinct source id(s) is an UPPER BOUND on independence, because sources that copy each other are counted separately`
        : undefined;

  return ok(
    { facts: rows.length, sources, distinctSources: counts.size, independentSources },
    basisFor(rows),
    rows.map((r) => r.factId),
    note,
  );
}

export async function conflictsOpen(
  deps: WorldQueryDeps,
  input: { entityId: string },
): Promise<ToolResult<ConflictRecord[]>> {
  if (!deps.conflicts) {
    return fail('unsupported', 'no conflict store is wired — refusing to imply there are none');
  }
  const broken = await missingEntity(deps, input.entityId);
  if (broken) return broken;

  const list = await deps.conflicts.openFor(input.entityId);
  return ok(
    list,
    'governed_query',
    list.flatMap((c) => c.factIds),
    list.length === 0 ? `no open conflicts recorded for ${input.entityId}` : undefined,
  );
}

/* ── the guarded escape hatch ───────────────────────────────────────────────
 *
 * HONESTY, because it matters more than the code below: keyword blocklisting is
 * a defence-in-depth layer, NOT a security boundary. A determined attacker with
 * string control will eventually get past a regex — that is the history of
 * every blocklist ever written. The real boundary is a database role with only
 * SELECT grants, no write grants anywhere, a `statement_timeout` set ON THE
 * ROLE, and RLS still in force. These guards exist to turn honest mistakes into
 * loud refusals, and to make a malicious attempt noisy. They do not make an
 * unrestricted connection safe, and nothing here should be read as saying so.
 */

export interface QueryExecutorPort {
  run(req: { sql: string; maxRows: number; statementTimeoutMs: number }): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount: number;
  }>;
}

export interface AnalyticalQueryInput {
  sql: string;
  maxRows?: number;
  statementTimeoutMs?: number;
}

export interface AnalyticalQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  sql: string;
}

export const ANALYTICAL_MAX_ROWS = 5000;
export const ANALYTICAL_MAX_TIMEOUT_MS = 30_000;
const ANALYTICAL_MAX_SQL_CHARS = 4000;

/** Word-boundary matched, so `created_at` and `offset` are untouched. The list
 *  is wider than DDL/DML on purpose: `do`, `call` and `execute` all reach
 *  arbitrary code, and `pg_read_file`/`lo_import` reach the filesystem. */
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|merge|call|do|execute|prepare|vacuum|reindex|refresh|listen|notify|set|reset|dblink|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_sleep|lo_import|lo_export)\b/i;

export type GuardVerdict =
  | { ok: true; sql: string; maxRows: number; statementTimeoutMs: number }
  | { ok: false; reason: string };

/** Pure, so the guards can be tested without an executor anywhere near them. */
export function inspectAnalyticalQuery(input: AnalyticalQueryInput): GuardVerdict {
  const raw = input.sql.trim();
  if (!raw) return { ok: false, reason: 'empty query' };
  if (raw.length > ANALYTICAL_MAX_SQL_CHARS) {
    return { ok: false, reason: `query exceeds ${ANALYTICAL_MAX_SQL_CHARS} characters` };
  }
  if (raw.includes('--') || raw.includes('/*') || raw.includes('*/')) {
    return {
      ok: false,
      reason:
        'comment sequences are rejected — they are the standard way to smuggle a second intent past a keyword check',
    };
  }

  const body = raw.endsWith(';') ? raw.slice(0, -1).trim() : raw;
  if (body.includes(';')) {
    return { ok: false, reason: 'multiple statements — exactly one read-only statement may run' };
  }
  if (!/^(select|with)\b/i.test(body)) {
    return { ok: false, reason: 'only a single SELECT or WITH … SELECT is allowed' };
  }
  const forbidden = FORBIDDEN.exec(body);
  if (forbidden) {
    return { ok: false, reason: `forbidden keyword "${forbidden[0]}" — this tool is read-only` };
  }

  const maxRows = input.maxRows ?? 1000;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > ANALYTICAL_MAX_ROWS) {
    return { ok: false, reason: `maxRows must be an integer in 1..${ANALYTICAL_MAX_ROWS}` };
  }
  if (!/\blimit\b/i.test(body)) {
    return {
      ok: false,
      reason: 'a LIMIT is required — an unbounded ad-hoc query is how one typo becomes an outage',
    };
  }
  const limit = /\blimit\s+(\d+)\b/i.exec(body);
  if (!limit) {
    return { ok: false, reason: 'LIMIT must be a literal integer, not a parameter or expression' };
  }
  const declared = Number(limit[1] ?? '');
  if (declared > maxRows) {
    return { ok: false, reason: `LIMIT ${declared} exceeds the ${maxRows}-row cap for this tool` };
  }

  const statementTimeoutMs = input.statementTimeoutMs ?? 5000;
  if (
    !Number.isInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1 ||
    statementTimeoutMs > ANALYTICAL_MAX_TIMEOUT_MS
  ) {
    return {
      ok: false,
      reason: `statementTimeoutMs must be an integer in 1..${ANALYTICAL_MAX_TIMEOUT_MS}`,
    };
  }
  return { ok: true, sql: body, maxRows, statementTimeoutMs };
}

/**
 * The escape hatch. Always `exploratory_unverified` — an ad-hoc result is NOT a
 * governed metric, and labelling it so is the entire point of the tool: it
 * stops downstream prose from presenting a one-off query as a measured number.
 */
export async function runAnalyticalQuery(
  executor: QueryExecutorPort,
  input: AnalyticalQueryInput,
): Promise<ToolResult<AnalyticalQueryResult>> {
  const verdict = inspectAnalyticalQuery(input);
  if (!verdict.ok) return fail('rejected', verdict.reason);

  try {
    const res = await executor.run({
      sql: verdict.sql,
      maxRows: verdict.maxRows,
      statementTimeoutMs: verdict.statementTimeoutMs,
    });
    const truncated = res.rowCount >= verdict.maxRows;
    return ok(
      { rows: res.rows, rowCount: res.rowCount, sql: verdict.sql },
      'exploratory_unverified',
      [],
      truncated
        ? `result hit the ${verdict.maxRows}-row cap and may be incomplete; ad-hoc result — not a governed metric`
        : 'ad-hoc result — not a governed metric; do not present it as one',
      truncated,
    );
  } catch (e) {
    return fail(
      'executor_failed',
      `the read-only executor refused or failed the query: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
