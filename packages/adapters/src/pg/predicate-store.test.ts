/**
 * The Postgres `PredicateStore`, without Postgres.
 *
 * The assertions worth having here are about the two fields that are not
 * columns. `occurrences` must never appear in a write — 007's trigger owns it,
 * and a second writer would disagree with the trigger silently — and
 * `distinctSources` must be read from `predicate_occurrence` rather than
 * invented. Everything else is a normalization or an ordering, and both are
 * places the two stores could quietly answer different questions.
 */
import { describe, expect, it } from 'vitest';
import type { QueryRow } from '@tmos/db';
import type { PredicateDef } from '@tmos/world';

import { recordingExecutor } from '../testing/recording-executor.js';
import {
  allPredicates,
  createPostgresPredicateStore,
  predicateByAlias,
  predicateByName,
  recordPredicateOccurrence,
  upsertPredicate,
} from './predicate-store.js';

const SOURCE_A = '44444444-4444-4444-8444-444444444444';
const SOURCE_B = '55555555-5555-4555-8555-555555555555';

const cannedRow = (over: Partial<QueryRow> = {}): QueryRow => ({
  predicate: 'hourly_rate',
  entity_type: 'company',
  datatype: 'num',
  unit: 'cents_per_hour',
  cardinality: 'one',
  status: 'proposed',
  description: 'what they charge per hour',
  aliases: ['Hourly Rate'],
  superseded_by: null,
  occurrences: 1,
  subjective: false,
  distinct_sources: [SOURCE_A],
  ...over,
});

const def = (over: Partial<PredicateDef> = {}): PredicateDef => ({
  predicate: 'hourly_rate',
  entityType: 'company',
  datatype: 'num',
  unit: 'cents_per_hour',
  cardinality: 'one',
  status: 'proposed',
  description: 'what they charge per hour',
  aliases: ['Hourly Rate'],
  supersededBy: null,
  occurrences: 0,
  subjective: false,
  distinctSources: [],
  ...over,
});

describe('reads', () => {
  it('normalizes the name before it reaches the query', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await predicateByName('Hourly-Rate ', ex);

    expect(ex.last().values).toEqual(['hourly_rate']);
  });

  it('derives distinctSources from predicate_occurrence, since it is not a column', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    const found = await predicateByName('hourly_rate', ex);

    expect(ex.last().text).toContain('from predicate_occurrence po');
    expect(ex.last().text).toContain('array_agg(po.source_id::text');
    expect(found?.distinctSources).toEqual([SOURCE_A]);
  });

  it('normalizes stored aliases in SQL, matching what the memory store does in JS', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await predicateByAlias('Hourly Rate', ex);

    const q = ex.last();
    expect(q.text).toContain('unnest(pd.aliases)');
    expect(q.text).toContain('regexp_replace');
    expect(q.values).toEqual(['hourly_rate']);
  });

  it('orders by creation, the closest thing the table has to insertion order', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    await allPredicates(ex);

    expect(ex.last().text).toContain('order by pd.created_at, pd.predicate');
  });
});

describe('upsert', () => {
  it('never writes the occurrences column — 007’s trigger owns it', async () => {
    const ex = recordingExecutor([[], [], [cannedRow({ occurrences: 0, distinct_sources: [] })]]);
    await upsertPredicate(def(), ex);

    const insert = ex.queries[1];
    expect(insert?.text).toContain('insert into predicate_def');
    expect(insert?.text).toContain('on conflict (predicate) do update');
    expect(insert?.text).not.toContain('occurrences');
  });

  it('touches only predicate_def when there is no occurrence data', async () => {
    const ex = recordingExecutor([[], [], [cannedRow({ occurrences: 0, distinct_sources: [] })]]);
    await upsertPredicate(def(), ex);

    expect(ex.queries).toHaveLength(3); // read, upsert, read back
    expect(ex.queries.some((q) => q.text.includes('predicate_occurrence ('))).toBe(false);
  });

  it('writes a ledger row for a source it has not seen', async () => {
    const ex = recordingExecutor([[], [], [], [cannedRow()]]);
    await upsertPredicate(def({ occurrences: 1, distinctSources: [SOURCE_A] }), ex);

    const ledger = ex.queries[2];
    expect(ledger?.text).toContain('insert into predicate_occurrence');
    expect(ledger?.text).toContain('"count"');
    expect(ledger?.values).toEqual(['hourly_rate', SOURCE_A, 1]);
  });

  it('attributes a repeat sighting to the last known source, because the port drops which one', async () => {
    const before = cannedRow({ occurrences: 2, distinct_sources: [SOURCE_A, SOURCE_B] });
    const ex = recordingExecutor([[before], [], [], [cannedRow({ occurrences: 3 })]]);

    // What `recordOccurrence(store, p, sourceA)` produces: the total moves, the
    // distinct set does not, and the sourceId is nowhere in the argument.
    await upsertPredicate(
      def({ occurrences: 3, distinctSources: [SOURCE_A, SOURCE_B] }),
      ex,
    );

    const ledger = ex.queries[2];
    expect(ledger?.values).toEqual(['hourly_rate', SOURCE_B, 1]);
  });

  it('normalizes the predicate name it stores', async () => {
    const ex = recordingExecutor([[], [], [cannedRow()]]);
    await upsertPredicate(def({ predicate: 'Hourly Rate' }), ex);

    expect(ex.queries[1]?.values?.[0]).toBe('hourly_rate');
  });
});

describe('recordPredicateOccurrence', () => {
  it('adds to the existing count rather than replacing it', async () => {
    const ex = recordingExecutor([[]]);
    await recordPredicateOccurrence('Hourly Rate', SOURCE_A, ex);

    const q = ex.last();
    expect(q.text).toContain('on conflict (predicate, source_id) do update');
    expect(q.text).toContain('predicate_occurrence."count" + excluded."count"');
    expect(q.values).toEqual(['hourly_rate', SOURCE_A, 1]);
  });
});

describe('createPostgresPredicateStore', () => {
  it('binds the port to an executor resolved per call', async () => {
    const ex = recordingExecutor([[cannedRow()]]);
    const store = createPostgresPredicateStore(ex);

    expect((await store.get('hourly_rate'))?.predicate).toBe('hourly_rate');
    expect(ex.queries).toHaveLength(1);
  });
});
