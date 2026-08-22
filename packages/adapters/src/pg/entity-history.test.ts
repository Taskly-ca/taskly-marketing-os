/**
 * The history port, without Postgres.
 *
 * What is worth pinning here is not the SQL — it is the three answers, because
 * each one routes T2 somewhere different and two of them mint a Finding:
 * `entityKnown: false` → `new_entity`, `current: null` → `changed_value`, and
 * `current: { value: null }` → refused as `unsupported_value`. A bug that
 * collapses the third into the second does not fail loudly; it publishes "we
 * now hold a value where we previously held none" about a competitor. So each
 * is driven separately, and the malformed ref is driven too — that one must
 * throw rather than quietly become "an entity we have never seen".
 */
import { describe, expect, it } from 'vitest';
import type { QueryRow } from '@tmos/db';

import { recordingExecutor } from '../testing/recording-executor.js';
import {
  createPostgresEntityHistory,
  parseSubjectRef,
  toObservedValue,
} from './entity-history.js';

const ENTITY = '11111111-1111-4111-8111-111111111111';
const SOURCE = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-08-23T00:00:00.000Z';

const entityRow = (): QueryRow => ({
  entity_id: ENTITY,
  entity_type: 'company',
  name: 'TaskRabbit',
  name_norm: 'taskrabbit',
  region: 'ca',
  keys: '[]',
});

const factRow = (over: Partial<QueryRow> = {}): QueryRow => ({
  fact_id: '33333333-3333-4333-8333-333333333333',
  entity_id: ENTITY,
  predicate: 'service_categories_count',
  object_text: null,
  object_num: 42,
  object_entity: null,
  object_json: null,
  has_json: false,
  valid_from: new Date('2026-08-01T00:00:00.000Z'),
  valid_to: null,
  asserted_from: new Date('2026-08-01T00:00:00.000Z'),
  asserted_to: null,
  source_id: SOURCE,
  observed_at: new Date('2026-08-01T00:00:00.000Z'),
  confidence: 0.9,
  method: 'llm_extract',
  evidence: null,
  supersedes: null,
  status: 'active',
  ...over,
});

const history = (responses: readonly (readonly QueryRow[])[]) => {
  const ex = recordingExecutor(responses);
  return { ex, port: createPostgresEntityHistory({ executor: ex, now: () => NOW }) };
};

describe('parseSubjectRef', () => {
  it('reads `type:id`', () => {
    expect(parseSubjectRef('company:taskrabbit.ca')).toEqual({
      type: 'company',
      id: 'taskrabbit.ca',
    });
  });

  it('throws on a ref that is not `type:id` rather than calling it unknown', () => {
    expect(() => parseSubjectRef('TaskRabbit')).toThrow(/not `type:id`/);
    expect(() => parseSubjectRef('company:')).toThrow(/not `type:id`/);
  });
});

describe('toObservedValue', () => {
  it('converts the two variants T2 can diff', () => {
    expect(toObservedValue({ datatype: 'num', num: 7 })).toEqual({ kind: 'num', num: 7 });
    expect(toObservedValue({ datatype: 'text', text: 'yes' })).toEqual({ kind: 'text', text: 'yes' });
  });

  it('returns null for the two it cannot, rather than stringifying them', () => {
    expect(toObservedValue({ datatype: 'entity', entityId: ENTITY })).toBeNull();
    expect(toObservedValue({ datatype: 'json', json: { a: 1 } })).toBeNull();
  });
});

describe('createPostgresEntityHistory', () => {
  it('resolves a company ref by its domain hard key, not by name', async () => {
    const { ex, port } = history([[entityRow()], [factRow()]]);
    await port.lookup('company:TaskRabbit.ca', 'service_categories_count');

    expect(ex.queries[0]?.text).toMatch(/where k\.kind = \$\d+ and k\.value_norm = \$\d+/);
    // Lower-cased on the way in: `value_norm` is normalised by definition, and a
    // ref carrying the domain as it appeared on a page must still match.
    expect(ex.queries[0]?.values).toContain('taskrabbit.ca');
    expect(ex.queries[0]?.values).toContain('domain');
  });

  it('resolves `entity:<uuid>` against the primary key', async () => {
    const { ex, port } = history([[entityRow()], [factRow()]]);
    await port.lookup(`entity:${ENTITY}`, 'service_categories_count');

    // The uuid goes straight to the primary key. `entity_identifier` still
    // appears in the projection — the hard keys are selected for every entity —
    // so the assertion is about the WHERE, which is where the identity is decided.
    expect(ex.queries[0]?.text).toMatch(/where e\.id = \$\d+::uuid/);
    expect(ex.queries[0]?.values).toContain(ENTITY);
  });

  it('reports an entity we do not hold as unknown, and asks for no facts', async () => {
    const { ex, port } = history([[]]);
    const got = await port.lookup('company:never-seen.com', 'lowest_advertised_price');

    expect(got).toEqual({ entityKnown: false, current: null });
    expect(ex.queries).toHaveLength(1);
  });

  it('separates "known, hold nothing" from "unknown"', async () => {
    const { port } = history([[entityRow()], []]);
    const got = await port.lookup('company:taskrabbit.ca', 'offers_snow_removal');

    expect(got).toEqual({ entityKnown: true, current: null });
  });

  it('returns the current value with the instant it was observed', async () => {
    const { port } = history([[entityRow()], [factRow()]]);
    const got = await port.lookup('company:taskrabbit.ca', 'service_categories_count');

    expect(got.entityKnown).toBe(true);
    expect(got.current?.value).toEqual({ kind: 'num', num: 42 });
    expect(got.current?.observedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('says "held but incomparable" for a json-valued fact — never "hold none"', async () => {
    const { port } = history([
      [entityRow()],
      [factRow({ object_num: null, object_json: { cities: ['Toronto'] }, has_json: true })],
    ]);
    const got = await port.lookup('company:taskrabbit.ca', 'coverage');

    expect(got.entityKnown).toBe(true);
    expect(got.current).not.toBeNull();
    expect(got.current?.value).toBeNull();
  });

  it('ignores a retracted row — a fact we no longer believe is not our current belief', async () => {
    const { port } = history([[entityRow()], [factRow({ status: 'retracted' })]]);
    const got = await port.lookup('company:taskrabbit.ca', 'service_categories_count');

    expect(got).toEqual({ entityKnown: true, current: null });
  });

  it('ignores a fact whose valid range closed before the instant asked about', async () => {
    const { port } = history([
      [entityRow()],
      [factRow({ valid_to: new Date('2026-08-10T00:00:00.000Z') })],
    ]);
    const got = await port.lookup('company:taskrabbit.ca', 'service_categories_count');

    expect(got).toEqual({ entityKnown: true, current: null });
  });

  it('throws on a malformed ref before touching the database', async () => {
    const { ex, port } = history([]);
    await expect(port.lookup('taskrabbit', 'x')).rejects.toThrow(/not `type:id`/);
    expect(ex.queries).toHaveLength(0);
  });
});
