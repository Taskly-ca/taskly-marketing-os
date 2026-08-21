/**
 * The Postgres `EntityDirectoryPort` and the two writes under it, without
 * Postgres.
 *
 * Two of these assertions are load-bearing rather than descriptive:
 *
 *   · `attachHardKey` must NOT contain `set entity_id = excluded.entity_id`.
 *     That one clause would make crawl order decide which company owns a
 *     domain, with no score and no human — the exact auto-merge failure
 *     `identity.ts` is written to prevent.
 *   · `byNameNorm` must emit BOTH `like` and `=`. The `like` is the only
 *     operator `entity_name_trgm_idx` can serve; the `=` is what stops a `%`
 *     in a caller-supplied string widening the match to a similarity search on
 *     a name that must never be matched by similarity.
 */
import { describe, expect, it } from 'vitest';
import type { QueryRow } from '@tmos/db';
import { HARD_KEY_KINDS } from '@tmos/world';

import { AdapterError, DecodeError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  attachHardKey,
  createPostgresEntityDirectory,
  entitiesByNameNorm,
  entityByHardKey,
  entityById,
  entityIdentifiers,
  insertEntity,
  rowToEntity,
} from './entity-directory.js';

const ENTITY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const cannedRow = (over: Partial<QueryRow> = {}): QueryRow => ({
  entity_id: ENTITY,
  entity_type: 'company',
  name: 'Jiffy Home Services Inc.',
  name_norm: 'jiffy home services',
  region: 'ca',
  keys: [{ kind: 'domain', value_norm: 'jiffy.ca' }],
  ...over,
});

describe('byId', () => {
  it('projects the identifiers as jsonb, filtered to the kinds HardKey can express', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await entityById(ENTITY, ex);

    const q = ex.last();
    expect(q.text).toContain('jsonb_agg');
    expect(q.text).toContain('k.kind = any(');
    expect(q.values).toContainEqual(HARD_KEY_KINDS);
    expect(q.values).toContain(ENTITY);
  });

  it('returns null for a malformed id without issuing a statement', async () => {
    const ex = recordingExecutor();
    expect(await entityById('ent_1', ex)).toBeNull();
    expect(ex.queries).toHaveLength(0);
  });

  it('returns null when nothing holds the id', async () => {
    expect(await entityById(ENTITY, recordingExecutor([[]]))).toBeNull();
  });
});

describe('byHardKey', () => {
  it('looks the key up through the unique (kind, value_norm) index', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await entityByHardKey({ kind: 'domain', valueNorm: 'jiffy.ca' }, ex);

    const q = ex.last();
    expect(q.text).toContain('k.kind = $');
    expect(q.text).toContain('k.value_norm = $');
    expect(q.values).toContain('domain');
    expect(q.values).toContain('jiffy.ca');
  });

  it('treats two owners of one key as a broken schema, not a choice to make', async () => {
    const ex = recordingExecutor([[cannedRow(), cannedRow({ entity_id: OTHER })]]);
    await expect(
      entityByHardKey({ kind: 'domain', valueNorm: 'jiffy.ca' }, ex),
    ).rejects.toThrow(/at most one row/);
  });
});

describe('byNameNorm', () => {
  it('emits the trigram-usable like AND the exact equality', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await entitiesByNameNorm('jiffy home services', ex);

    const q = ex.last();
    expect(q.text).toContain('e.name_norm like $');
    expect(q.text).toContain('e.name_norm = $');
    expect(q.values).toContain('jiffy home services');
  });

  it('escapes LIKE metacharacters so a wildcard cannot widen the match', async () => {
    const ex = recordingExecutor([[]]);
    await entitiesByNameNorm('100% pure_co', ex);

    // The kinds filter in the projection is $1, so the two name parameters follow it.
    expect(ex.last().values.slice(1)).toEqual(['100\\% pure\\_co', '100% pure_co']);
  });
});

describe('insertEntity', () => {
  it('derives name_norm from normalizeName when it is not supplied', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await insertEntity({ entityType: 'company', name: 'Jiffy Home Services Inc.' }, ex);

    expect(ex.last().values).toContain('jiffy home services');
  });

  it('takes an explicit name_norm verbatim, and defaults region to null', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await insertEntity(
      { entityType: 'company', name: 'Jiffy', nameNorm: 'deliberately different' },
      ex,
    );

    const q = ex.last();
    expect(q.values).toContain('deliberately different');
    expect(q.values).toContain(null);
    expect(q.text).toContain('insert into entity');
    expect(q.text).not.toContain('on conflict');
    // Read from the CTE, never from `entity`: a WITH sub-statement and the main
    // query share one snapshot, so the join would find nothing and `one()`
    // would fail on a row that had in fact been inserted.
    expect(q.text).toContain('from inserted i');
    expect(q.text).not.toMatch(/from entity e/);
  });
});

describe('attachHardKey', () => {
  it('never repoints an existing key at the newest writer', async () => {
    const ex = recordingExecutor([[{ entity_id: ENTITY, inserted: true }]]);
    await attachHardKey({ entityId: ENTITY, key: { kind: 'domain', valueNorm: 'jiffy.ca' } }, ex);

    const { text } = ex.last();
    expect(text).toContain('on conflict (kind, value_norm) do nothing');
    expect(text).not.toContain('excluded.entity_id');
  });

  it('reports a fresh attachment', async () => {
    const ex = recordingExecutor([[{ entity_id: ENTITY, inserted: true }]]);
    const result = await attachHardKey(
      { entityId: ENTITY, key: { kind: 'domain', valueNorm: 'jiffy.ca' } },
      ex,
    );

    expect(result).toEqual({ entityId: ENTITY, attached: true, ownedBy: null });
  });

  it('is idempotent when this entity already holds the key', async () => {
    const ex = recordingExecutor([[{ entity_id: ENTITY, inserted: false }]]);
    const result = await attachHardKey(
      { entityId: ENTITY, key: { kind: 'domain', valueNorm: 'jiffy.ca' } },
      ex,
    );

    expect(result).toEqual({ entityId: ENTITY, attached: false, ownedBy: null });
  });

  it('hands back the OTHER owner — 001s auto-merge signal, as data not an exception', async () => {
    const ex = recordingExecutor([[{ entity_id: OTHER, inserted: false }]]);
    const result = await attachHardKey(
      { entityId: ENTITY, key: { kind: 'domain', valueNorm: 'jiffy.ca' } },
      ex,
    );

    expect(result).toEqual({ entityId: OTHER, attached: false, ownedBy: OTHER });
  });

  it('refuses to invent an owner when a concurrent transaction claimed the key', async () => {
    const ex = recordingExecutor([[{ entity_id: null, inserted: false }]]);
    await expect(
      attachHardKey({ entityId: ENTITY, key: { kind: 'domain', valueNorm: 'jiffy.ca' } }, ex),
    ).rejects.toThrow(/concurrent transaction/);
  });

  it('refuses a non-uuid entity id before issuing a statement', async () => {
    const ex = recordingExecutor();
    await expect(
      attachHardKey({ entityId: 'ent_1', key: { kind: 'domain', valueNorm: 'x' } }, ex),
    ).rejects.toBeInstanceOf(AdapterError);
    expect(ex.queries).toHaveLength(0);
  });

  it('defaults confidence to 1.0 — a hard key is not a guess', async () => {
    const ex = recordingExecutor([[{ entity_id: ENTITY, inserted: true }]]);
    await attachHardKey({ entityId: ENTITY, key: { kind: 'social', valueNorm: 'x:jiffy' } }, ex);

    expect(ex.last().values).toContain(1.0);
  });
});

describe('entityIdentifiers', () => {
  it('returns kinds HardKey cannot express, which the port projection drops', async () => {
    const ex = recordingExecutor([
      [
        {
          id: OTHER,
          entity_id: ENTITY,
          kind: 'ticker',
          value_norm: 'tsx:jfy',
          source_id: null,
          confidence: 1,
        },
      ],
    ]);
    const rows = await entityIdentifiers(ENTITY, ex);

    expect(ex.last().text).not.toContain('any(');
    expect(rows[0]?.kind).toBe('ticker');
    expect(rows[0]?.sourceId).toBeNull();
  });

  it('returns an empty list for a malformed id without issuing a statement', async () => {
    const ex = recordingExecutor();
    expect(await entityIdentifiers('ent_1', ex)).toEqual([]);
    expect(ex.queries).toHaveLength(0);
  });
});

describe('decoding', () => {
  it('decodes keys from a jsonb array and from its serialised form alike', () => {
    const fromObject = rowToEntity(cannedRow());
    const fromText = rowToEntity(
      cannedRow({ keys: JSON.stringify([{ kind: 'domain', value_norm: 'jiffy.ca' }]) }),
    );

    expect(fromObject.keys).toEqual([{ kind: 'domain', valueNorm: 'jiffy.ca' }]);
    expect(fromText.keys).toEqual(fromObject.keys);
  });

  it('decodes an entity with no identifiers as keys: []', () => {
    expect(rowToEntity(cannedRow({ keys: [] })).keys).toEqual([]);
  });

  it('keeps a null region null rather than inventing one', () => {
    expect(rowToEntity(cannedRow({ region: null })).region).toBeNull();
  });

  it('refuses a keys column that is not an array', () => {
    expect(() => rowToEntity(cannedRow({ keys: { kind: 'domain' } }))).toThrow(DecodeError);
  });

  it('refuses an identifier kind HardKey cannot represent rather than dropping it silently', () => {
    expect(() =>
      rowToEntity(cannedRow({ keys: [{ kind: 'ticker', value_norm: 'tsx:jfy' }] })),
    ).toThrow(/not one of domain \| social \| bundle_id \| linkedin_id/);
  });
});

describe('createPostgresEntityDirectory', () => {
  it('binds the three reads to the executor it was given', async () => {
    const ex = recordingExecutor([[cannedRow()], [cannedRow()], [cannedRow()]]);
    const directory = createPostgresEntityDirectory(ex);

    await directory.byId(ENTITY);
    await directory.byHardKey({ kind: 'domain', valueNorm: 'jiffy.ca' });
    await directory.byNameNorm('jiffy home services');

    expect(ex.queries).toHaveLength(3);
  });
});
