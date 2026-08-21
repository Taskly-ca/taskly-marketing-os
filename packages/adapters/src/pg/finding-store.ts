/**
 * `FindingStore` (packages/reason/src/finding/store.ts) on `finding` — migration
 * 003.
 *
 * The behavioural specification is `createMemoryFindingStore`, not this file.
 * Where the two could differ they are made to agree; where they CANNOT agree
 * the difference is named here and in the README.
 *
 * TWO THINGS MAKE THIS ADAPTER DIFFERENT FROM THE OTHERS IN THIS PACKAGE.
 *
 *   DEDUPLICATION IS APPLICATION LOGIC WITH NO INDEX BEHIND IT.
 *   `findingDedupeKey` is (normalised claim, sorted set of evidence DOCUMENTS),
 *   and the document half runs a URL canonicalisation — strip `www.`, strip the
 *   query and the fragment, strip a trailing slash — that no expression index
 *   in 003 computes and that would be a second implementation of
 *   `canonicalUrl` if it did. So the key cannot be a unique constraint, the
 *   database cannot refuse a duplicate, and this adapter has to do it itself:
 *   NARROW in SQL, DECIDE in JavaScript, and hold a lock across the gap so the
 *   check and the insert cannot be interleaved. See `findDuplicate`.
 *
 *   CORRECTIONS ARE ROWS, NOT EDITS. `supersede` is the only UPDATE in this
 *   file and it writes exactly two columns — `superseded_by` and
 *   `supersede_reason` — on a row that has neither. It never touches a claim,
 *   a score or an evidence array, because a system whose past is edited cannot
 *   be audited: the reader has no way to tell a claim that has always said 12%
 *   from one that said 23% until Tuesday.
 *
 * `mintFinding` (packages/reason/src/finding/mint.ts) is the gated constructor
 * for a `Finding`. This file deliberately does not import it and does not
 * re-run its gates: a store that re-judged what it was handed would either
 * duplicate the gate (and drift from it) or refuse to persist a `Finding` a
 * human deliberately minted. What IS re-checked is the SCHEMA — the port's
 * `invalid_finding` result requires it, and the memory store does the same.
 */
import { findingSchema, type EvidenceRef, type Finding } from '@tmos/contracts';
import {
  db,
  inTransaction,
  sql,
  withTx,
  type Executor,
  type QueryRow,
  type SqlQuery,
} from '@tmos/db';
import {
  findingDedupeKey,
  type FindingStore,
  type PutResult,
  type QueryOptions,
  type SupersedeResult,
} from '@tmos/reason';

import { DecodeError, guard } from '../errors.js';
import { asIso, asJsonObject, asNumber, asText, asTextOrNull, asUnion, isUuid } from './values.js';

/**
 * Nested into every read so the decoder only ever meets one shape. Every query
 * in this file aliases the table `f`, including the `insert … as f` and the
 * `update … as f`, so this projection works in a RETURNING clause too.
 */
const FINDING_COLUMNS = sql`
  f.id::text as id,
  f.claim,
  f.so_what,
  f.subject_refs,
  f.evidence,
  f.basis,
  f.causal_rung,
  f.stakes,
  f.region,
  f.domain_score,
  f.generated_by,
  f.reviewed_by,
  f.superseded_by::text as superseded_by,
  f.supersede_reason,
  f.created_at`;

/**
 * The memory store ranks by `created_at` descending and breaks ties by
 * INSERTION ORDER (later first). `finding` has no insertion counter and a
 * random-uuid primary key, so ties break by id here instead.
 *
 * It matters more than the equivalent note on `fact`: `created_at` is written
 * from the `Finding`, so a batch minted from one investigation can legitimately
 * share an instant, and then "newest" is decided differently by the two stores.
 * Nothing asserts on it; the conformance suite compares sets, and orders only
 * rows whose `created_at` differ.
 */
const FINDING_ORDER = sql`order by f.created_at desc, f.id desc`;

const BASES = [
  'verified_metric',
  'governed_query',
  'inferred_from_sources',
  'exploratory_unverified',
] as const;
const STAKES = ['low', 'medium', 'high'] as const;
const REGIONS = ['ca', 'in', 'global'] as const;

/** 003: `causal_rung int check (causal_rung between 0 and 4)`. */
function asCausalRung(value: unknown, column: string): Finding['causal_rung'] {
  const n = asNumber(value, column);
  if (n === 0 || n === 1 || n === 2 || n === 3 || n === 4) return n;
  throw new DecodeError(`${column}: ${n} is not a causal rung (0–4)`);
}

/**
 * `evidence` is `jsonb not null check (jsonb_array_length(evidence) >= 1)`. It
 * is decoded element by element rather than cast, for the same reason
 * `pg/values.ts` exists: the driver's type parsers are global mutable state,
 * and "the row that came back is not a Finding" is a different failure from
 * "your write was refused" and must not be silently coerced into one.
 *
 * `observed_at` inside the array is read as TEXT, not as a timestamp: it lives
 * in a jsonb document, so the string round-trips verbatim, and normalising it
 * through `Date` would hand back a different string from the one the caller
 * stored.
 */
function asEvidence(value: unknown, column: string): EvidenceRef[] {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(raw)) {
    throw new DecodeError(`${column}: expected a JSON array of evidence refs`);
  }
  return raw.map((element, i) => {
    const ref = asJsonObject(element, `${column}[${i}]`);
    return {
      signal_id: asTextOrNull(ref.signal_id, `${column}[${i}].signal_id`),
      fact_id: asTextOrNull(ref.fact_id, `${column}[${i}].fact_id`),
      source_url: asText(ref.source_url, `${column}[${i}].source_url`),
      span: asText(ref.span, `${column}[${i}].span`),
      observed_at: asText(ref.observed_at, `${column}[${i}].observed_at`),
    };
  });
}

function asSubjectRefs(value: unknown, column: string): string[] {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return [...value];
  throw new DecodeError(`${column}: expected text[]`);
}

export function rowToFinding(row: QueryRow): Finding {
  const id = asText(row.id, 'finding.id');
  const at = (column: string): string => `finding[${id}].${column}`;

  return {
    id,
    claim: asText(row.claim, at('claim')),
    so_what: asText(row.so_what, at('so_what')),
    subject_refs: asSubjectRefs(row.subject_refs, at('subject_refs')),
    evidence: asEvidence(row.evidence, at('evidence')),
    basis: asUnion(row.basis, BASES, at('basis')),
    causal_rung: asCausalRung(row.causal_rung, at('causal_rung')),
    stakes: asUnion(row.stakes, STAKES, at('stakes')),
    region: asUnion(row.region, REGIONS, at('region')),
    // `numeric` arrives as a string. `check (domain_score between 0 and 1)`
    // means the value is small, so nothing is lost passing through float64.
    domain_score: asNumber(row.domain_score, at('domain_score')),
    generated_by: asText(row.generated_by, at('generated_by')),
    reviewed_by: asTextOrNull(row.reviewed_by, at('reviewed_by')),
    superseded_by: asTextOrNull(row.superseded_by, at('superseded_by')),
    supersede_reason: asTextOrNull(row.supersede_reason, at('supersede_reason')),
    created_at: asIso(row.created_at, at('created_at')),
  };
}

/* ── deduplication ───────────────────────────────────────────────────────── */

/**
 * THE NARROWING FOLD: lowercase, then drop everything that is not `[a-z0-9]`.
 *
 * It is NOT the dedupe key and must never be used as one. It exists to pull a
 * handful of candidate rows out of Postgres so that `findingDedupeKey` — the
 * real key, in JavaScript, unmodified — can decide between them. That split is
 * what keeps `canonicalUrl` and `normalizeClaim` single implementations: the
 * SQL half never has to know what a tracking parameter is.
 *
 * WHY THIS PARTICULAR FOLD. It is implied by the real key, provably: the key's
 * claim half is `lower → collapse whitespace → trim → strip trailing
 * [.!?;:]`, and every character those steps touch is whitespace or punctuation,
 * all of which this fold deletes outright. So
 * `fold(x) = strip_non_alnum(normalizeClaim(x))` — meaning two claims with the
 * SAME dedupe key always have the same fold, and the SQL filter can never hide
 * a duplicate from the JavaScript check. The reverse does not hold, which is
 * the right direction to be wrong in: it over-selects, and the exact key throws
 * the extras away.
 *
 * The one residual risk is `lower()`: Postgres's is locale-dependent and
 * JavaScript's is Unicode's. It cannot matter for ASCII, and any character
 * whose case has no ASCII form is deleted by both. It CAN matter for the few
 * non-ASCII characters that lowercase INTO ASCII (U+212A KELVIN SIGN → 'k',
 * U+0130 → 'i'), where a C-locale database would keep the original and delete
 * it. `finding-store.live.test.ts` runs both implementations over exactly those
 * inputs; the pattern, and the justification for a second implementation at
 * all, is `normalizePredicateNameSql`'s.
 */
export const claimFold = (claim: string): string => claim.toLowerCase().replace(/[^a-z0-9]/g, '');

/** `claimFold`, in SQL. The argument arrives as a nested `SqlQuery` because a
 *  placeholder can carry a value but never a column reference. */
export const claimFoldSql = (expr: SqlQuery): SqlQuery =>
  sql`regexp_replace(lower(${expr}), '[^a-z0-9]', '', 'g')`;

/**
 * The candidates, decided.
 *
 * Deliberately NOT limited: `supersede` bypasses deduplication on purpose, so a
 * long correction chain accumulates rows that share a claim, and a `limit` here
 * would eventually return "not a duplicate" for something that is one. The scan
 * is a sequential one — 003 indexes `(created_at desc) where superseded_by is
 * null` and nothing else — which is fine at the size this table is and is the
 * first thing to give an expression index if it ever is not.
 *
 * Superseded rows ARE searched. The memory store's key map is never pruned, so
 * a claim whose only sighting has since been corrected still counts as seen,
 * and re-skimming the article that produced it must not mint it again.
 */
async function findDuplicate(finding: Finding, key: string, ex: Executor): Promise<Finding | null> {
  const rows = await guard('put', () =>
    ex.query(sql`
      select ${FINDING_COLUMNS} from finding f
       where ${claimFoldSql(sql`f.claim`)} = ${claimFold(finding.claim)}
       ${FINDING_ORDER}`),
  );

  for (const row of rows) {
    const candidate = rowToFinding(row);
    if (findingDedupeKey(candidate) === key) return candidate;
  }
  return null;
}

/**
 * `put`, inside a transaction, holding a lock on the dedupe key.
 *
 * THE RACE THIS CLOSES: two workers skim the same article at the same time,
 * both compute the same key, both find no duplicate, and both insert. There is
 * no unique index to catch the second one, so the table ends up with two rows
 * that are the same finding — and the digest shows the reader the same thing
 * twice, which is precisely the attention damage the dedupe key exists to
 * prevent.
 *
 * `pg_advisory_xact_lock` over the hash of the key serialises exactly those two
 * workers and nobody else: a different key hashes elsewhere and never waits. It
 * is transaction-scoped, so it is released by COMMIT or ROLLBACK and there is
 * no unlock to forget. A 64-bit hash collision costs two unrelated writers a
 * few milliseconds of queueing and nothing else.
 *
 * Its cost is honest and worth stating: the lock is held until the caller's
 * transaction ends, not until the insert returns. Inside a long `withTx` that
 * is a long time to hold it, and the answer is to put the finding at the end of
 * that transaction. It also only binds writers that come through THIS function:
 * a second writer inserting into `finding` directly can still duplicate.
 */
async function putInTransaction(finding: Finding, ex: Executor): Promise<PutResult> {
  const key = findingDedupeKey(finding);

  await guard('put', () =>
    ex.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}::text, 0::bigint))`),
  );

  const duplicate = await findDuplicate(finding, key, ex);
  // `duplicate.id === finding.id` is the same row coming back, not a duplicate
  // of it — the memory store falls through to the insert here too, and gets
  // `duplicate_id` from the primary key.
  if (duplicate !== null && duplicate.id !== finding.id) {
    return { ok: true, stored: false, duplicateOf: duplicate };
  }

  const row = await guard('put', () =>
    ex.maybeOne(sql`
      insert into finding as f (
        id, claim, so_what, subject_refs, evidence, basis, causal_rung, stakes,
        region, domain_score, generated_by, reviewed_by, superseded_by,
        supersede_reason, created_at
      ) values (
        ${finding.id}::uuid,
        ${finding.claim},
        ${finding.so_what},
        ${finding.subject_refs}::text[],
        ${JSON.stringify(finding.evidence)}::jsonb,
        ${finding.basis},
        ${finding.causal_rung},
        ${finding.stakes},
        ${finding.region},
        ${finding.domain_score}::numeric,
        ${finding.generated_by},
        ${finding.reviewed_by},
        ${finding.superseded_by}::uuid,
        ${finding.supersede_reason},
        ${finding.created_at}::timestamptz
      )
      on conflict (id) do nothing
      returning ${FINDING_COLUMNS}`),
  );

  // `on conflict … do nothing` rather than letting the primary key raise: a
  // raised 23505 would abort the caller's whole transaction, and "this id is
  // already stored" is a RESULT in this port, not a failure of the batch.
  if (row === null) {
    return { ok: false, reason: 'duplicate_id', detail: `finding ${finding.id} already stored` };
  }
  return { ok: true, stored: true, finding: rowToFinding(row) };
}

export async function putFinding(finding: Finding, ex: Executor = db()): Promise<PutResult> {
  // Before any statement: an invalid finding must not open a transaction, take
  // a lock, or reach a CHECK constraint that would abort one.
  const parsed = findingSchema.safeParse(finding);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_finding', detail: parsed.error.message };
  }

  // See `appendEvent`: `inTransaction()`, not the shape of `ex`, decides —
  // the only way to hold a transaction executor here is inside `withTx`, which
  // sets the ambient store for that whole async context.
  if (inTransaction()) return putInTransaction(finding, ex);
  return withTx((tx) => putInTransaction(finding, tx));
}

export async function findingById(id: string, ex: Executor = db()): Promise<Finding | null> {
  if (!isUuid(id)) return null;

  return guard('byId', async () => {
    const row = await ex.maybeOne(
      sql`select ${FINDING_COLUMNS} from finding f where f.id = ${id}::uuid`,
    );
    return row === null ? null : rowToFinding(row);
  });
}

/* ── supersession ────────────────────────────────────────────────────────── */

/**
 * Close `id`, link it to `replacement`, and say why.
 *
 * THE ORDER OF THE CHECKS IS THE CONTRACT, not an implementation detail: it is
 * copied from the memory store so that a caller who hits two problems at once
 * is told about the same one by both stores. Reason, then existence, then
 * already-closed, then self-supersession, then the replacement's own validity.
 *
 * Every precondition is checked with a SELECT or in JavaScript, and the last
 * one is guarded in the WHERE clause of the UPDATE — so a violation returns
 * zero rows instead of raising. That matters here for the same reason it
 * matters in `fact-store`: `withTx` has no savepoints, and a raised exception
 * would take the caller's whole batch with it.
 *
 * The replacement is inserted BEFORE the link is written, which is also the
 * only order the foreign key allows (`superseded_by references finding(id)`).
 */
async function supersedeInTransaction(
  id: string,
  replacement: Finding,
  reason: string,
  ex: Executor,
): Promise<SupersedeResult> {
  const original = await findingById(id, ex);
  if (original === null) return { ok: false, reason: 'not_found', detail: `no finding ${id}` };

  if (original.superseded_by !== null) {
    return {
      ok: false,
      reason: 'already_superseded',
      detail: `${id} was already closed by ${original.superseded_by}; correct the tip instead`,
    };
  }
  if (replacement.id === id) {
    return { ok: false, reason: 'self_supersede', detail: `${id} cannot replace itself` };
  }

  const parsed = findingSchema.safeParse(replacement);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_finding', detail: parsed.error.message };
  }

  // DELIBERATELY BYPASSES DEDUPLICATION — no lock, no candidate search. A
  // correction that only rewrites `so_what` shares the original's key, and
  // deduplication would swallow the very write the caller is making on purpose.
  // The memory store says the same thing in the same place.
  const inserted = await guard('supersede', () =>
    ex.maybeOne(sql`
      insert into finding as f (
        id, claim, so_what, subject_refs, evidence, basis, causal_rung, stakes,
        region, domain_score, generated_by, reviewed_by, superseded_by,
        supersede_reason, created_at
      ) values (
        ${replacement.id}::uuid,
        ${replacement.claim},
        ${replacement.so_what},
        ${replacement.subject_refs}::text[],
        ${JSON.stringify(replacement.evidence)}::jsonb,
        ${replacement.basis},
        ${replacement.causal_rung},
        ${replacement.stakes},
        ${replacement.region},
        ${replacement.domain_score}::numeric,
        ${replacement.generated_by},
        ${replacement.reviewed_by},
        ${replacement.superseded_by}::uuid,
        ${replacement.supersede_reason},
        ${replacement.created_at}::timestamptz
      )
      on conflict (id) do nothing
      returning ${FINDING_COLUMNS}`),
  );

  if (inserted === null) {
    return {
      ok: false,
      reason: 'duplicate_id',
      detail: `finding ${replacement.id} already stored`,
    };
  }

  const closed = await guard('supersede', () =>
    ex.maybeOne(sql`
      update finding as f
         set superseded_by    = ${replacement.id}::uuid,
             supersede_reason = ${reason}
       where f.id = ${id}::uuid
         and f.superseded_by is null
      returning ${FINDING_COLUMNS}`),
  );

  if (closed === null) {
    // The row was open when we read it and is not now: another transaction
    // committed a supersession in between. Reported as what it is rather than
    // as a lost update.
    return {
      ok: false,
      reason: 'already_superseded',
      detail: `${id} was superseded concurrently; correct the tip instead`,
    };
  }

  return { ok: true, original: rowToFinding(closed), replacement: rowToFinding(inserted) };
}

export async function supersedeFinding(
  id: string,
  replacement: Finding,
  reason: string,
  ex: Executor = db(),
): Promise<SupersedeResult> {
  if (reason.trim().length === 0) {
    return {
      ok: false,
      reason: 'missing_reason',
      detail: 'a correction with no stated cause cannot repair trust',
    };
  }
  // A malformed id cannot be a row; asking Postgres would raise 22P02 instead
  // of answering `not_found`.
  if (!isUuid(id)) return { ok: false, reason: 'not_found', detail: `no finding ${id}` };

  if (inTransaction()) return supersedeInTransaction(id, replacement, reason, ex);
  return withTx((tx) => supersedeInTransaction(id, replacement, reason, tx));
}

/* ── reads ───────────────────────────────────────────────────────────────── */

/**
 * `includeSuperseded` defaults to OFF, which is `finding_live_idx on
 * (created_at desc) where superseded_by is null` — the index exists because a
 * reader asking "what do we think about Jiffy" wants the live answer.
 */
const liveClause = (options?: QueryOptions): SqlQuery =>
  options?.includeSuperseded === true ? sql`true` : sql`f.superseded_by is null`;

export async function findingsBySubject(
  subjectRef: string,
  options?: QueryOptions,
  ex: Executor = db(),
): Promise<Finding[]> {
  return guard('bySubject', async () => {
    const rows = await ex.query(sql`
      select ${FINDING_COLUMNS} from finding f
       where ${liveClause(options)}
         and ${subjectRef} = any(f.subject_refs)
       ${FINDING_ORDER}`);
    return rows.map(rowToFinding);
  });
}

export async function findingsByStakes(
  stakes: Finding['stakes'],
  options?: QueryOptions,
  ex: Executor = db(),
): Promise<Finding[]> {
  return guard('byStakes', async () => {
    const rows = await ex.query(sql`
      select ${FINDING_COLUMNS} from finding f
       where ${liveClause(options)}
         and f.stakes = ${stakes}
       ${FINDING_ORDER}`);
    return rows.map(rowToFinding);
  });
}

export async function recentFindings(
  limit: number,
  options?: QueryOptions,
  ex: Executor = db(),
): Promise<Finding[]> {
  // Same guard as the memory store: a non-finite or non-positive limit is an
  // empty result, never `limit -1` for Postgres to reject.
  if (!Number.isFinite(limit) || limit <= 0) return [];

  return guard('recent', async () => {
    const rows = await ex.query(sql`
      select ${FINDING_COLUMNS} from finding f
       where ${liveClause(options)}
       ${FINDING_ORDER}
       limit ${Math.floor(limit)}`);
    return rows.map(rowToFinding);
  });
}

export async function unsupersededFindings(ex: Executor = db()): Promise<Finding[]> {
  return guard('unsuperseded', async () => {
    const rows = await ex.query(sql`
      select ${FINDING_COLUMNS} from finding f
       where f.superseded_by is null
       ${FINDING_ORDER}`);
    return rows.map(rowToFinding);
  });
}

/**
 * A chain longer than this is not a correction history, it is a loop the cycle
 * guard did not catch or a bug upstream. The memory store has no cap (its
 * `seen` set is the only bound), so a chain this long is one place the two
 * would differ — at a length no honest correction history reaches.
 */
const MAX_CHAIN_DEPTH = 1000;

/**
 * `id` → … → the live tip, walked in the database.
 *
 * A recursive CTE rather than N round trips, with TWO independent terminators.
 * `f.id <> all(w.path)` is the real one: the path accumulates every id already
 * visited, so a cycle (A superseded by B, B later pointed back at A by a direct
 * writer — the application refuses self-supersession but nothing refuses a
 * longer loop) stops at the first repeat instead of spinning the server. The
 * depth cap is the backstop, and it is what makes this safe against a cycle the
 * path check somehow misses.
 *
 * `order by depth` reproduces the memory store's walk exactly: the row asked
 * for first, then each successor.
 */
export async function findingChain(id: string, ex: Executor = db()): Promise<Finding[]> {
  if (!isUuid(id)) return [];

  return guard('chain', async () => {
    const rows = await ex.query(sql`
      with recursive walk as (
        select id, superseded_by, 1 as depth, array[id] as path
          from finding
         where id = ${id}::uuid
        union all
        select f.id, f.superseded_by, w.depth + 1, w.path || f.id
          from walk w
          join finding f on f.id = w.superseded_by
         where f.id <> all(w.path)
           and w.depth < ${MAX_CHAIN_DEPTH}
      )
      select ${FINDING_COLUMNS}
        from walk w
        join finding f on f.id = w.id
       order by w.depth`);
    return rows.map(rowToFinding);
  });
}

/** See `createPostgresFactStore` — `executor` is resolved per call, never captured. */
export function createPostgresFindingStore(executor?: Executor): FindingStore {
  const ex = (): Executor => executor ?? db();

  return {
    put: (finding) => putFinding(finding, ex()),
    byId: (id) => findingById(id, ex()),
    supersede: (id, replacement, reason) => supersedeFinding(id, replacement, reason, ex()),
    bySubject: (subjectRef, options) => findingsBySubject(subjectRef, options, ex()),
    byStakes: (stakes, options) => findingsByStakes(stakes, options, ex()),
    recent: (limit, options) => recentFindings(limit, options, ex()),
    unsuperseded: () => unsupersededFindings(ex()),
    chain: (id) => findingChain(id, ex()),
  };
}
