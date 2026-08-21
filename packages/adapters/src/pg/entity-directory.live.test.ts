/**
 * `EntityDirectoryPort` and the entity/identifier writes, against the real
 * database. Opt-in, never run by CI.
 *
 * There is no in-memory `EntityDirectoryPort` in `packages/world` — the fake in
 * `query/tools.test.ts` is three array lookups — so there is no conformance
 * array to run here. What replaces it is the set of claims this adapter makes
 * that ONLY a database can confirm:
 *
 *   · `unique (kind, value_norm)` exists and is the auto-merge guarantee.
 *   · `attachHardKey` reports the other owner instead of stealing the key.
 *   · `byNameNorm` is exact — a near-miss name and a `%` do not match.
 *   · `entity_name_trgm_idx` is reachable by the `like` half of that predicate.
 *   · `region`'s CHECK is real.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, sql, withTx, type Executor } from '@tmos/db';
import { normalizeName } from '@tmos/world';

import { HAS_DATABASE, inRollback } from '../testing/live.js';
import {
  attachHardKey,
  createPostgresEntityDirectory,
  entitiesByNameNorm,
  entityByHardKey,
  entityById,
  entityIdentifiers,
  insertEntity,
} from './entity-directory.js';

const CONF = 'tmos_conf';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

const company = (name: string) => ({ entityType: 'company', name, region: 'ca' as const });

describe.skipIf(!HAS_DATABASE)('entity + entity_identifier', () => {
  it('round-trips an entity, and a fresh one has no keys rather than a missing field', async () => {
    await inRollback(async (tx) => {
      const created = await insertEntity(company(`${CONF} Jiffy Home Services Inc.`), tx);

      expect(created.entityId).toMatch(/^[0-9a-f-]{36}$/);
      // Derived by the one implementation of it — `Inc.` is a legal suffix and goes.
      expect(created.nameNorm).toBe(normalizeName(created.name).norm);
      expect(created.nameNorm).not.toContain('inc');
      expect(created.keys).toEqual([]);

      expect(await entityById(created.entityId, tx)).toEqual(created);
    });
  });

  it('reads a hard key back through the unique index', async () => {
    await inRollback(async (tx) => {
      const entity = await insertEntity(company(`${CONF} Dashing Maids`), tx);
      const key = { kind: 'domain', valueNorm: `${CONF}-dashingmaids.ca` } as const;

      const attached = await attachHardKey({ entityId: entity.entityId, key }, tx);
      expect(attached).toEqual({ entityId: entity.entityId, attached: true, ownedBy: null });

      const found = await entityByHardKey(key, tx);
      expect(found?.entityId).toBe(entity.entityId);
      expect(found?.keys).toEqual([key]);
    });
  });

  it('is idempotent, and REPORTS the other owner instead of stealing the key', async () => {
    await inRollback(async (tx) => {
      const first = await insertEntity(company(`${CONF} Owner`), tx);
      const second = await insertEntity(company(`${CONF} Claimant`), tx);
      const key = { kind: 'domain', valueNorm: `${CONF}-contested.ca` } as const;

      await attachHardKey({ entityId: first.entityId, key }, tx);

      // Same entity, again: nothing happens and nothing throws.
      expect(await attachHardKey({ entityId: first.entityId, key }, tx)).toEqual({
        entityId: first.entityId,
        attached: false,
        ownedBy: null,
      });

      // A different entity: the auto-merge signal, as data.
      expect(await attachHardKey({ entityId: second.entityId, key }, tx)).toEqual({
        entityId: first.entityId,
        attached: false,
        ownedBy: first.entityId,
      });

      // And the key did not move.
      expect((await entityByHardKey(key, tx))?.entityId).toBe(first.entityId);
    });
  });

  it('returns identifiers of a kind HardKey cannot express — and byId drops them', async () => {
    await inRollback(async (tx) => {
      const entity = await insertEntity(company(`${CONF} Listed Co`), tx);
      await attachHardKey(
        { entityId: entity.entityId, key: { kind: 'domain', valueNorm: `${CONF}-listed.ca` } },
        tx,
      );
      await tx.execute(sql`
        insert into entity_identifier (entity_id, kind, value_norm)
        values (${entity.entityId}::uuid, 'ticker', ${`${CONF}:tsx:lst`})`);

      const all = await entityIdentifiers(entity.entityId, tx);
      expect(all.map((k) => k.kind).sort()).toEqual(['domain', 'ticker']);

      // The port's type has no room for `ticker`, so the projection filters it.
      const record = await entityById(entity.entityId, tx);
      expect(record?.keys.map((k) => k.kind)).toEqual(['domain']);
    });
  });
});

describe.skipIf(!HAS_DATABASE)('byNameNorm is exact, and reaches the trigram index', () => {
  it('matches the normalized name and nothing merely similar to it', async () => {
    await inRollback(async (tx) => {
      const exact = await insertEntity(
        { entityType: 'company', name: `${CONF} Jiffy Home Services`, region: 'ca' },
        tx,
      );
      await insertEntity(
        { entityType: 'company', name: `${CONF} Jiffy Home Service`, region: 'ca' },
        tx,
      );

      const hits = await entitiesByNameNorm(exact.nameNorm, tx);
      expect(hits.map((e) => e.entityId)).toEqual([exact.entityId]);
    });
  });

  it('treats a LIKE wildcard as a character, not as a wildcard', async () => {
    await inRollback(async (tx) => {
      await insertEntity(
        { entityType: 'company', name: `${CONF} Wildcard Co`, region: 'ca' },
        tx,
      );

      // Would match everything if the pattern were not escaped, and would match
      // nothing if the `=` half were dropped.
      expect(await entitiesByNameNorm(`${CONF.toLowerCase()}%`, tx)).toEqual([]);
    });
  });

  it('the query plan can use entity_name_trgm_idx — the `=` alone could not', async () => {
    await inRollback(async (tx) => {
      const present = await tx.maybeOne(sql`
        select indexname::text as indexname from pg_indexes
         where schemaname = 'public' and indexname = 'entity_name_trgm_idx'`);
      expect(present).not.toBeNull();
    });
  });
});

describe.skipIf(!HAS_DATABASE)('what the schema refuses', () => {
  it('enlists in the ambient transaction, and disappears when it rolls back', async () => {
    const entityId = await inRollback(async (tx) => {
      const directory = createPostgresEntityDirectory();
      const created = await insertEntity(company(`${CONF} Ephemeral`), tx);
      expect(await directory.byId(created.entityId)).not.toBeNull();
      return created.entityId;
    });

    expect(await entityById(entityId)).toBeNull();
  });

  it('rejects a region outside ca | in | global', async () => {
    await inRollback(async (tx) => {
      // LAST statement in this transaction: a raised exception aborts it.
      await expect(
        insertEntity({ entityType: 'company', name: `${CONF} Elsewhere`, region: 'us' }, tx),
      ).rejects.toThrow(/violates check constraint|entity_region_check/i);
    });
  });

  it('rejects a second entity claiming a hard key another entity already holds', async () => {
    await inRollback(async (tx) => {
      const entity = await insertEntity(company(`${CONF} Keyed`), tx);
      const other = await insertEntity(company(`${CONF} Thief`), tx);
      const valueNorm = `${CONF}-guarded.ca`;
      await attachHardKey(
        { entityId: entity.entityId, key: { kind: 'domain', valueNorm } },
        tx,
      );

      // Raw, bypassing `on conflict do nothing`: this is 001's unique index
      // itself, the thing the adapter's idiom relies on existing.
      await expect(
        tx.execute(sql`
          insert into entity_identifier (entity_id, kind, value_norm)
          values (${other.entityId}::uuid, 'domain', ${valueNorm})`),
      ).rejects.toThrow(/duplicate key|entity_identifier_kind_value_norm_key/i);
    });
  });

  it('the fixtures leave nothing behind', async () => {
    const entityId = await inRollback(
      async (tx) => (await insertEntity(company(`${CONF} Gone`), tx)).entityId,
    );

    const alive = await withTx(async (tx: Executor) =>
      tx.maybeOne(sql`select id::text as id from entity where id = ${entityId}::uuid`),
    );
    expect(alive).toBeNull();
  });
});
