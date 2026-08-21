/**
 * `EntityDirectoryPort` (packages/world/src/query/tools.ts) on `entity` +
 * `entity_identifier` — migration 001, indexed by 005 — plus the two writes
 * that had no port at all: creating an entity, and attaching a hard key to it.
 *
 * THE AUTO-MERGE GUARANTEE IS A UNIQUE INDEX, AND THAT IS THE WHOLE DESIGN.
 * 001 calls `unique (kind, value_norm)` exactly that in a trailing comment, and
 * `identity.ts` opens with why: a registrable domain or a social handle IS the
 * entity, so two records carrying the same one are the same company and merging
 * them needs no score, no threshold and no LLM. Everything below is arranged so
 * that index cannot be worked around — most of all `attachHardKey`, which
 * REFUSES to move a key off the entity that already holds it.
 *
 * Three mapping decisions, each a place the two sides could silently disagree:
 *
 * 1. `keys` DROPS IDENTIFIERS OF AN UNKNOWN KIND. `entity_identifier.kind` is
 *    free text with no CHECK; `HardKey.kind` is a four-value union
 *    (`HARD_KEY_KINDS`, identity.ts). A row with `kind = 'ticker'` therefore
 *    cannot be represented, and the choice is between dropping it and making
 *    the whole entity unreadable because someone inserted a row nobody here
 *    anticipated. It is dropped — but the filter is in the SQL, where it is
 *    visible, and `entityIdentifiers()` below returns EVERY row including the
 *    ones this projection cannot type. Nothing is unreachable; one shape is
 *    just not a `HardKey`.
 *
 * 2. `byNameNorm` IS EXACT EQUALITY, and the trigram index is how it is
 *    reached. `entity_name_trgm_idx` is `gin (name_norm gin_trgm_ops)`, an
 *    opclass with no equality operator — a plain `=` cannot use it and
 *    sequentially scans `entity`. `LIKE` can. So the predicate is both: the
 *    `like` gives the index a way in, the `=` is the semantic guarantee, and
 *    the pattern is escaped so a `%` or `_` in a caller-supplied string cannot
 *    widen the `like` half. `normalizeName` strips both characters, so this is
 *    belt for a caller that skipped it. Exactness is not negotiable here:
 *    `findEntities` feeds this the normalized form of names that may be
 *    `exactOnly` (`3m`, `The Gap`), and a similarity match on those auto-merges
 *    two unrelated companies with no human in the loop.
 *
 * 3. `region` IS `string | null` IN THE PORT and CHECK-constrained to
 *    `ca | in | global` in 001. The union is not narrowed on read — the port
 *    says string — so a region added by a later migration reads back rather
 *    than throwing; a bad one written through here is refused by the database.
 */
import { db, sql, type Executor, type QueryRow } from '@tmos/db';
import {
  HARD_KEY_KINDS,
  normalizeName,
  type EntityDirectoryPort,
  type EntityRecord,
  type HardKey,
} from '@tmos/world';

import { AdapterError, DecodeError, guard } from '../errors.js';
import { asBoolean, asJsonObject, asNumber, asText, asTextOrNull, isUuid } from './values.js';

/**
 * `keys` is aggregated in a correlated subquery rather than a join, so an
 * entity carrying no identifier still comes back with `keys: []` — which is the
 * common case (a scraped company has a name long before it has a domain) and
 * exactly the row a join would drop.
 *
 * `jsonb` rather than two parallel `text[]`s: a pair of arrays can be returned
 * misaligned and nothing would notice, and node-postgres parses `jsonb` without
 * consulting a type parser this package does not control.
 */
const ENTITY_COLUMNS = sql`
  e.id::text as entity_id,
  e.entity_type,
  e.name,
  e.name_norm,
  e.region,
  coalesce((
    select jsonb_agg(jsonb_build_object('kind', k.kind, 'value_norm', k.value_norm)
                     order by k.kind, k.value_norm)
      from entity_identifier k
     where k.entity_id = e.id
       and k.kind = any(${HARD_KEY_KINDS}::text[])
  ), '[]'::jsonb) as keys`;

/** Deterministic, and `created_at` is the only column recording arrival order. */
const ENTITY_ORDER = sql`order by e.created_at, e.id`;

/** `\` is LIKE's default escape character, so no `ESCAPE` clause is needed. */
const likeLiteral = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

function hardKeysFromColumn(value: unknown, ctx: string): HardKey[] {
  const raw = typeof value === 'string' ? parseJson(value, ctx) : value;
  if (!Array.isArray(raw)) {
    throw new DecodeError(`${ctx}: expected a JSON array of identifiers`);
  }
  return raw.map((item, i) => {
    const at = `${ctx}[${i}]`;
    const obj = asJsonObject(item, at);
    const kind = asText(obj.kind, `${at}.kind`);
    if (!(HARD_KEY_KINDS as readonly string[]).includes(kind)) {
      // Unreachable through this projection — the SQL filters on the same list.
      // Only a hand-written caller reusing `hardKeysFromColumn` can get here.
      throw new DecodeError(`${at}.kind: ${kind} is not one of ${HARD_KEY_KINDS.join(' | ')}`);
    }
    return {
      kind: kind as HardKey['kind'],
      valueNorm: asText(obj.value_norm, `${at}.value_norm`),
    };
  });
}

function parseJson(value: string, ctx: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new DecodeError(`${ctx}: not JSON`, { cause: error });
  }
}

export function rowToEntity(row: QueryRow): EntityRecord {
  const entityId = asText(row.entity_id, 'entity.id');
  const at = (column: string): string => `entity[${entityId}].${column}`;

  return {
    entityId,
    entityType: asText(row.entity_type, at('entity_type')),
    name: asText(row.name, at('name')),
    nameNorm: asText(row.name_norm, at('name_norm')),
    region: asTextOrNull(row.region, at('region')),
    keys: hardKeysFromColumn(row.keys, at('keys')),
  };
}

/* ── reads: the port ────────────────────────────────────────────────────── */

export async function entityById(
  entityId: string,
  ex: Executor = db(),
): Promise<EntityRecord | null> {
  if (!isUuid(entityId)) return null;

  return guard('byId', async () => {
    const row = await ex.maybeOne(
      sql`select ${ENTITY_COLUMNS} from entity e where e.id = ${entityId}::uuid`,
    );
    return row === null ? null : rowToEntity(row);
  });
}

/**
 * `maybeOne`, not `query` — `unique (kind, value_norm)` makes two rows
 * impossible, so a second one is a broken schema and the executor saying so is
 * better than this function picking one.
 */
export async function entityByHardKey(
  key: HardKey,
  ex: Executor = db(),
): Promise<EntityRecord | null> {
  return guard('byHardKey', async () => {
    const row = await ex.maybeOne(sql`
      select ${ENTITY_COLUMNS} from entity e
       where e.id = (
         select k.entity_id from entity_identifier k
          where k.kind = ${key.kind} and k.value_norm = ${key.valueNorm}
       )`);
    return row === null ? null : rowToEntity(row);
  });
}

/** See decision 2 in the file header for why this is `like` AND `=`. */
export async function entitiesByNameNorm(
  nameNorm: string,
  ex: Executor = db(),
): Promise<EntityRecord[]> {
  return guard('byNameNorm', async () => {
    const rows = await ex.query(sql`
      select ${ENTITY_COLUMNS} from entity e
       where e.name_norm like ${likeLiteral(nameNorm)}
         and e.name_norm = ${nameNorm}
       ${ENTITY_ORDER}`);
    return rows.map(rowToEntity);
  });
}

/* ── writes: entity creation and hard-key attachment ────────────────────── */

export interface EntityInput {
  readonly entityType: string;
  readonly name: string;
  /** Defaults to `normalizeName(name).norm` — the one implementation of it. */
  readonly nameNorm?: string;
  /** 001: `ca | in | global`, or null. */
  readonly region?: string | null;
}

/**
 * Creates an entity. Deliberately NOT an upsert: `entity` has no natural key
 * (two real companies can share a normalized name, which is the entire reason
 * `er_label` exists), so "insert or update on conflict" has no conflict target
 * that means anything. Resolve identity FIRST — `entityByHardKey`, then the
 * scored path — and only then create.
 *
 * The projection is built from the CTE and NOT from `entity`, which is the one
 * trap in this file. Every sub-statement of a `WITH` runs against the same
 * snapshot as the main query, so `select … from entity e join inserted i` would
 * not see the row it had just inserted: `one()` would report "expected exactly
 * one row, got 0" and the entity would exist anyway. `keys` is therefore a
 * literal `[]` rather than the usual aggregate — provably correct, since
 * `entity_identifier` references `entity(id)` and a row that did not exist a
 * statement ago cannot be referenced by one.
 */
export async function insertEntity(input: EntityInput, ex: Executor = db()): Promise<EntityRecord> {
  const nameNorm = input.nameNorm ?? normalizeName(input.name).norm;

  return guard('insertEntity', async () =>
    rowToEntity(
      await ex.one(sql`
        with inserted as (
          insert into entity (entity_type, name, name_norm, region)
          values (${input.entityType}, ${input.name}, ${nameNorm}, ${input.region ?? null})
          returning id, entity_type, name, name_norm, region
        )
        select i.id::text as entity_id, i.entity_type, i.name, i.name_norm, i.region,
               '[]'::jsonb as keys
          from inserted i`),
    ),
  );
}

export interface HardKeyAttachment {
  /** Who owns the key NOW. Not necessarily the entity you asked for. */
  readonly entityId: string;
  /** True only when this call created the row. */
  readonly attached: boolean;
  /**
   * Set when the key was already held by a DIFFERENT entity. That is 001's
   * auto-merge signal, arriving as data instead of an exception: the two
   * entities are the same company and one of them has to be merged away.
   */
  readonly ownedBy: string | null;
}

export interface HardKeyInput {
  readonly entityId: string;
  readonly key: HardKey;
  /** Which observation produced the key. Null is allowed; the FK is nullable. */
  readonly sourceId?: string | null;
  /** 001 defaults it to 1.0 — a hard key is not a guess. */
  readonly confidence?: number;
}

/**
 * Attaches a hard key, and NEVER STEALS ONE.
 *
 * The tempting spelling is `on conflict (kind, value_norm) do update set
 * entity_id = excluded.entity_id`, and it is wrong in the specific way this
 * whole subsystem exists to prevent: it silently repoints the key at the newest
 * writer, so the identity of a company is decided by crawl order, with no
 * score, no threshold and no human. `do update set entity_id =
 * entity_identifier.entity_id` is a deliberate no-op whose only job is to make
 * `returning` fire on the conflicting row, so the CURRENT owner comes back and
 * the caller learns it has a merge to do.
 *
 * Written as a CTE rather than that no-op update so the conflicting row is not
 * locked and its xmax not bumped by a read.
 */
export async function attachHardKey(
  input: HardKeyInput,
  ex: Executor = db(),
): Promise<HardKeyAttachment> {
  const { entityId, key } = input;
  if (!isUuid(entityId)) {
    throw new AdapterError(
      `attachHardKey: entityId ${JSON.stringify(entityId)} is not a uuid — ` +
        'entity_identifier.entity_id references entity(id).',
    );
  }

  const row = await guard('attachHardKey', () =>
    ex.one(sql`
      with attempt as (
        insert into entity_identifier (entity_id, kind, value_norm, source_id, confidence)
        values (
          ${entityId}::uuid, ${key.kind}, ${key.valueNorm},
          ${input.sourceId ?? null}::uuid, ${input.confidence ?? 1.0}
        )
        on conflict (kind, value_norm) do nothing
        returning entity_id
      )
      select
        coalesce(
          (select a.entity_id from attempt a),
          (select k.entity_id from entity_identifier k
            where k.kind = ${key.kind} and k.value_norm = ${key.valueNorm})
        )::text as entity_id,
        exists (select 1 from attempt) as inserted`),
  );

  const owner = asTextOrNull(row.entity_id, 'entity_identifier.entity_id');
  if (owner === null) {
    // `do nothing` suppressed the insert, and the row that caused the conflict
    // is not visible to this snapshot: another transaction inserted it and has
    // not committed. Reported rather than answered — there is no true owner yet.
    throw new AdapterError(
      `attachHardKey: ${key.kind}=${key.valueNorm} was claimed by a concurrent transaction that ` +
        'has not committed. Retry; the winner is whichever commits first.',
    );
  }

  const inserted = asBoolean(row.inserted, 'attachHardKey.inserted');
  return {
    entityId: owner,
    attached: inserted,
    ownedBy: !inserted && owner !== entityId ? owner : null,
  };
}

export interface EntityIdentifierRow {
  readonly id: string;
  readonly entityId: string;
  /** Free text in the schema — NOT narrowed to `HardKeyKind`. See header note 1. */
  readonly kind: string;
  readonly valueNorm: string;
  readonly sourceId: string | null;
  readonly confidence: number;
}

/**
 * Every identifier on an entity, including kinds `HardKey` cannot express. The
 * escape hatch for header note 1, and the read behind a merge — moving keys
 * between entities has to see all of them, not the typed subset.
 */
export async function entityIdentifiers(
  entityId: string,
  ex: Executor = db(),
): Promise<EntityIdentifierRow[]> {
  if (!isUuid(entityId)) return [];

  return guard('entityIdentifiers', async () => {
    const rows = await ex.query(sql`
      select k.id::text as id, k.entity_id::text as entity_id, k.kind, k.value_norm,
             k.source_id::text as source_id, k.confidence
        from entity_identifier k
       where k.entity_id = ${entityId}::uuid
       order by k.kind, k.value_norm`);

    return rows.map((row) => {
      const id = asText(row.id, 'entity_identifier.id');
      const at = (column: string): string => `entity_identifier[${id}].${column}`;
      return {
        id,
        entityId: asText(row.entity_id, at('entity_id')),
        kind: asText(row.kind, at('kind')),
        valueNorm: asText(row.value_norm, at('value_norm')),
        sourceId: asTextOrNull(row.source_id, at('source_id')),
        confidence: asNumber(row.confidence, at('confidence')),
      };
    });
  });
}

/** See `createPostgresFactStore` — `executor` is resolved per call, never captured. */
export function createPostgresEntityDirectory(executor?: Executor): EntityDirectoryPort {
  const ex = (): Executor => executor ?? db();

  return {
    byId: (entityId) => entityById(entityId, ex()),
    byHardKey: (key) => entityByHardKey(key, ex()),
    byNameNorm: (nameNorm) => entitiesByNameNorm(nameNorm, ex()),
  };
}
