/**
 * `source` (migration 001) — the collection state of every source, and the
 * reliability posterior nothing was persisting.
 *
 * THIS ONE HAS NO PORT, WHICH IS WHY IT EXISTS. Every other file in this
 * package implements an interface that already had an in-memory
 * implementation. There is no `SourceStore` anywhere in the repo, and the
 * consequence is not cosmetic:
 *
 *   `CollectorContext` (packages/collectors/src/types.ts) takes `cursor` and
 *   `etag` IN, `CollectResult` hands new ones back OUT, and nothing in between
 *   writes them down. On a schedule, every collector re-fetches from zero
 *   forever — and `notModified()`, described in that same file as "the single
 *   biggest lever on crawl budget", can never fire, because a 304 needs an
 *   etag we kept.
 *
 *   `packages/world/src/fact/reliability.ts` computes a Beta posterior and
 *   scores sources on its lower credible bound. `source.reliability_alpha` and
 *   `reliability_beta` are the columns it matches, defaults and all. Nothing
 *   ever moved them, so every source scored as never-tested forever, and
 *   `corroborationScore` combined a pile of identical priors.
 *
 * WHAT IS DELIBERATELY NOT HERE: an interface. Declaring `SourceStore` in the
 * adapter package would put the port in the one package that must never own a
 * port — the domain would then depend on the adapter, which is the dependency
 * this package exists to invert. So this file exports repository functions and
 * the two data shapes; where the interface belongs (`packages/collectors`,
 * which owns the cursor/etag contract, or `packages/world`, which owns
 * reliability — or both, split) is a decision for a serial task, and the shape
 * to lift is `SourceCollectionState` + `CollectionOutcome` below.
 *
 * THE STATE TYPE IS `Source` FROM `@tmos/contracts`, PLUS ONE FIELD. The
 * contract already describes exactly these columns, in exactly this
 * granularity, in snake_case — and contracts are locked, so a second camelCase
 * shape here would be a mapping layer nobody asked for and a drift hazard the
 * first time a column is added. The one addition is `reliability`, because
 * `sourceSchema` has no field for the posterior.
 */
import { regionSchema, sourceTierSchema, type Source } from '@tmos/contracts';
import type { CollectResult } from '@tmos/collectors';
import { db, sql, type Executor, type QueryRow } from '@tmos/db';
import { updateReliability, type BetaPosterior } from '@tmos/world';

import { NotFoundError, guard } from '../errors.js';
import { asIsoOrNull, asNumber, asText, asTextOrNull, asUnion, isUuid } from './values.js';

/** `Source` (contracts) + the Beta posterior the contract has no field for. */
export interface SourceCollectionState extends Source {
  /** `reliability_alpha` / `reliability_beta`, in the shape `@tmos/world` uses. */
  readonly reliability: BetaPosterior;
}

/**
 * WHAT HAPPENED ON ONE COLLECTION ATTEMPT — the three outcomes `CollectResult`
 * distinguishes, narrowed to what the `source` table can actually hold.
 *
 * The union is not `CollectResult` itself, deliberately. A store that accepted
 * `items`, `reason`, `detail` and `retryable` and then wrote none of them would
 * be a port that quietly drops half its argument — the exact failure the
 * README's "leaky port" note is about. `source` has no column for a failure
 * reason and should not grow one: the reason is an EVENT ("this source failed,
 * this is what it said"), it belongs in the outbox where a human can read the
 * sequence, and a single mutable column would only ever remember the last one.
 *
 * `collected` vs `not_modified` is the distinction that earns its keep. Both
 * are successes — both stamp `last_ok_at` and both clear the failure streak —
 * but a 304 must NEVER advance the cursor, because there was nothing to advance
 * past. Collapsing them is how a source silently skips a window of items.
 */
export type CollectionOutcome =
  | {
      readonly kind: 'collected';
      /** When the collection succeeded. From the caller: this package never reads the clock. */
      readonly at: string;
      /** Omitted means "unchanged" — a collector that has no cursor keeps the old one. */
      readonly cursor?: string;
      readonly etag?: string;
    }
  | { readonly kind: 'not_modified'; readonly at: string; readonly etag?: string }
  /**
   * No `at`: there is no `last_fail_at` column, and stamping `last_ok_at` on a
   * failure is how a dead source looks healthy. All this records is the streak.
   */
  | { readonly kind: 'failed' };

/**
 * `CollectResult` → `CollectionOutcome`. The only place the two vocabularies
 * meet, so a change to the collector union fails to compile here rather than
 * being silently mis-persisted.
 *
 * `reason`, `detail`, `retryable` and the item count are DROPPED on purpose —
 * see above. Append them as an event.
 */
export function collectionOutcomeFor(result: CollectResult, at: string): CollectionOutcome {
  if (!result.ok) return { kind: 'failed' };
  if (result.notModified === true) {
    return result.etag === undefined
      ? { kind: 'not_modified', at }
      : { kind: 'not_modified', at, etag: result.etag };
  }
  return {
    kind: 'collected',
    at,
    ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
    ...(result.etag === undefined ? {} : { etag: result.etag }),
  };
}

const TIERS = sourceTierSchema.options;
const REGIONS = regionSchema.options;
const VISIBILITIES = ['internal', 'restricted'] as const;

const SOURCE_COLUMNS = sql`
  id::text as id,
  kind,
  name,
  tier,
  region,
  cursor,
  etag,
  last_ok_at,
  consecutive_failures,
  visibility,
  derives_from::text as derives_from,
  reliability_alpha,
  reliability_beta`;

export function rowToSourceState(row: QueryRow): SourceCollectionState {
  const id = asText(row.id, 'source.id');
  const at = (column: string): string => `source[${id}].${column}`;
  const region = row.region;

  return {
    id,
    kind: asText(row.kind, at('kind')),
    name: asText(row.name, at('name')),
    tier: asUnion(row.tier, TIERS, at('tier')),
    region: region === null || region === undefined ? null : asUnion(region, REGIONS, at('region')),
    cursor: asTextOrNull(row.cursor, at('cursor')),
    etag: asTextOrNull(row.etag, at('etag')),
    last_ok_at: asIsoOrNull(row.last_ok_at, at('last_ok_at')),
    consecutive_failures: asNumber(row.consecutive_failures, at('consecutive_failures')),
    visibility: asUnion(row.visibility, VISIBILITIES, at('visibility')),
    derives_from: asTextOrNull(row.derives_from, at('derives_from')),
    // `numeric` arrives as a STRING from node-postgres (float64 cannot hold
    // every numeric). `asNumber` accepts both, so a type parser someone
    // installed elsewhere in the process cannot change what this returns.
    reliability: {
      alpha: asNumber(row.reliability_alpha, at('reliability_alpha')),
      beta: asNumber(row.reliability_beta, at('reliability_beta')),
    },
  };
}

export async function sourceById(
  sourceId: string,
  ex: Executor = db(),
): Promise<SourceCollectionState | null> {
  // A malformed id is a miss, not a crash — 22P02 would turn "no such source"
  // into an exception that poisons the caller's transaction.
  if (!isUuid(sourceId)) return null;

  return guard('sourceById', async () => {
    const row = await ex.maybeOne(
      sql`select ${SOURCE_COLUMNS} from source where id = ${sourceId}::uuid`,
    );
    return row === null ? null : rowToSourceState(row);
  });
}

export interface DueSourcesOptions {
  /** `source.kind` — the collector's stable key. Omitted means every kind. */
  readonly kind?: string;
  readonly limit?: number;
  /** Skip sources whose failure streak has reached this. Omitted means none are skipped. */
  readonly maxConsecutiveFailures?: number;
}

/**
 * The scheduler's read: which sources to collect, and the state to hand each
 * collector.
 *
 * Ordered `last_ok_at nulls first`, which is the actual scheduling order rather
 * than a convenience — a source that has NEVER been collected is the one with
 * no cursor at all, and after that the stalest goes first. `id` breaks ties
 * deterministically.
 *
 * `maxConsecutiveFailures` is a filter, not a policy: the backoff curve belongs
 * to whoever schedules, and this file refuses to invent one.
 */
export async function dueSources(
  options: DueSourcesOptions = {},
  ex: Executor = db(),
): Promise<SourceCollectionState[]> {
  const kind = options.kind ?? null;
  const maxFailures = options.maxConsecutiveFailures ?? null;
  const limit =
    options.limit === undefined ? sql`` : sql`limit ${Math.max(0, Math.floor(options.limit))}`;

  return guard('dueSources', async () => {
    const rows = await ex.query(sql`
      select ${SOURCE_COLUMNS} from source
       where (${kind}::text is null or kind = ${kind})
         and (${maxFailures}::int is null or consecutive_failures < ${maxFailures}::int)
       order by last_ok_at asc nulls first, id
       ${limit}`);
    return rows.map(rowToSourceState);
  });
}

/**
 * What a collector needs from the state it was given. Three lines, and they are
 * the seam this whole file exists to close: `CollectorContext` takes exactly
 * these two fields, as `string | undefined`, while the column is `text null`.
 */
export const collectorCursor = (
  state: SourceCollectionState,
): { cursor?: string; etag?: string } => ({
  ...(state.cursor === null ? {} : { cursor: state.cursor }),
  ...(state.etag === null ? {} : { etag: state.etag }),
});

/**
 * Record one collection attempt. ONE STATEMENT per outcome, so the whole update
 * is atomic without a transaction and two workers cannot interleave a
 * read-modify-write on the same source.
 *
 * `coalesce(new, existing)` is what makes "omitted means unchanged" true in
 * SQL. It also means a cursor can never be CLEARED through this path, which is
 * intentional: resetting a source to collect from zero is a deliberate act (a
 * backfill, a schema change at the source), not something a collector returning
 * no cursor should trigger by accident. There is no reset function yet; see the
 * report.
 */
export async function recordCollection(
  sourceId: string,
  outcome: CollectionOutcome,
  ex: Executor = db(),
): Promise<SourceCollectionState> {
  if (!isUuid(sourceId)) throw new NotFoundError(`recordCollection: no such source ${sourceId}`);

  const row = await guard('recordCollection', () => {
    switch (outcome.kind) {
      case 'collected':
        return ex.maybeOne(sql`
          update source set
            cursor               = coalesce(${outcome.cursor ?? null}, cursor),
            etag                 = coalesce(${outcome.etag ?? null}, etag),
            last_ok_at           = ${outcome.at}::timestamptz,
            consecutive_failures = 0
          where id = ${sourceId}::uuid
          returning ${SOURCE_COLUMNS}`);

      case 'not_modified':
        // `cursor` is absent from the SET list ENTIRELY — not coalesced, not
        // re-assigned to itself. A 304 means the source had nothing new to
        // give, so there is nothing to advance past, and the strongest way to
        // say that is a statement that cannot touch the column.
        return ex.maybeOne(sql`
          update source set
            etag                 = coalesce(${outcome.etag ?? null}, etag),
            last_ok_at           = ${outcome.at}::timestamptz,
            consecutive_failures = 0
          where id = ${sourceId}::uuid
          returning ${SOURCE_COLUMNS}`);

      case 'failed':
        // Read-modify-write in one statement: `+ 1` is evaluated by Postgres
        // against the row it just locked, so two concurrent failures count as
        // two. Neither the cursor nor `last_ok_at` is named here.
        return ex.maybeOne(sql`
          update source set
            consecutive_failures = consecutive_failures + 1
          where id = ${sourceId}::uuid
          returning ${SOURCE_COLUMNS}`);
    }
  });

  // The write path throws where the read path returns null — the same split
  // `setFactStatus` makes. A scheduler updating a source it just read has hit a
  // real problem if the row is gone, and silently returning null would hide it.
  if (row === null) throw new NotFoundError(`recordCollection: no such source ${sourceId}`);
  return rowToSourceState(row);
}

/**
 * Move the reliability posterior: `alpha += correct`, `beta += incorrect`.
 *
 * A DELTA, NOT AN ABSOLUTE. `updateReliability(prior, obs)` in `@tmos/world` is
 * pure — read the prior, add, write it back — and doing that across a round
 * trip loses every update that landed in between, which for a shared Beta
 * counter is the commonest concurrency bug there is. Adding in SQL makes each
 * observation commutative and lossless. That is also why there is no
 * `setSourceReliability(absolute)`: it would be the racy version wearing a
 * nicer name.
 *
 * The counts are still validated by `updateReliability` itself, from a zero
 * prior — the result of which IS the delta — so the guards ("must be finite",
 * "must not be negative") live in exactly one place and cannot drift.
 */
export async function recordSourceReliability(
  sourceId: string,
  observation: { correct: number; incorrect: number },
  ex: Executor = db(),
): Promise<SourceCollectionState> {
  const delta = updateReliability({ alpha: 0, beta: 0 }, observation);

  if (!isUuid(sourceId)) {
    throw new NotFoundError(`recordSourceReliability: no such source ${sourceId}`);
  }

  const row = await guard('recordSourceReliability', () =>
    ex.maybeOne(sql`
      update source set
        reliability_alpha = reliability_alpha + ${delta.alpha}::numeric,
        reliability_beta  = reliability_beta  + ${delta.beta}::numeric
      where id = ${sourceId}::uuid
      returning ${SOURCE_COLUMNS}`),
  );

  if (row === null) throw new NotFoundError(`recordSourceReliability: no such source ${sourceId}`);
  return rowToSourceState(row);
}
