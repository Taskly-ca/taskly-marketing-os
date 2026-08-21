/**
 * The Postgres `BrainIndexPort`, without Postgres.
 *
 * The interesting assertions here are the NEGATIVE ones. This adapter is
 * deliberately not allowed to enforce the trust ladder — `retrieve()` does, on
 * whatever the port returns — so the tests below pin down that the SQL excludes
 * `superseded` (the one rung whose rows are absent rather than demoted, and the
 * one 008 indexes for) and excludes nothing else: a `where status <> 'draft'`
 * that crept in here would silently delete "a draft may inform phrasing" while
 * every ladder test upstream stayed green.
 *
 * Whether Postgres accepts the statements is `brain-index.live.test.ts`, and it
 * is skipping.
 */
import { describe, expect, it } from 'vitest';
import type { QueryRow } from '@tmos/db';

import { AdapterError, ConstraintError, DecodeError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import { BRAIN_EMBEDDING_DIMENSIONS } from './brain-store.js';
import { rowToBrainCandidate, searchBrainIndex } from './brain-index.js';

const PATH = 'tmos-conf/a.md';
const vector = (fill = 0.5): number[] => new Array<number>(BRAIN_EMBEDDING_DIMENSIONS).fill(fill);

const candidateRow = (over: Partial<QueryRow> = {}): QueryRow => ({
  chunk_id: 'sha-a:0',
  ordinal: 0,
  heading: 'Commission',
  text: 'The rate.',
  chunk_sha: 'c-a-0',
  path: PATH,
  title: 'A',
  type: 'spec',
  status: 'canonical',
  reviewed: '2026-08-01',
  caveats: ['GTA only.'],
  verify: ['lib/marketplace/fees.ts'],
  superseded_by: [],
  doc_sha: 'sha-a',
  distance: 0.125,
  ...over,
});

describe('what the read path filters, and what it must not', () => {
  it('excludes superseded in SQL, as a literal the partial index can match', async () => {
    const ex = recordingExecutor([[]]);
    await searchBrainIndex({ vector: vector(), limit: 5 }, ex);

    // A parameter would defeat `brain_doc_retrievable_idx ... where status <>
    // 'superseded'`: a generic plan cannot know $n is that string.
    expect(ex.last().text).toContain("where d.status <> 'superseded'");
  });

  it('never filters draft or supporting — that is the ladder’s job, not the index’s', async () => {
    const ex = recordingExecutor([[]]);
    await searchBrainIndex({ vector: vector(), limit: 5 }, ex);

    expect(ex.last().text).not.toContain('draft');
    expect(ex.last().text).not.toContain('supporting');
    expect(ex.last().text).not.toContain('canonical');
  });

  it('joins the chunk to its document and reads the date as text, not as a Date', async () => {
    const ex = recordingExecutor([[]]);
    await searchBrainIndex({ vector: vector(), limit: 5 }, ex);

    const q = ex.last();
    expect(q.text).toContain('from brain_chunk c');
    expect(q.text).toContain('join brain_doc d on d.path = c.path');
    // A `date` arrives as a Date at LOCAL midnight; toISOString() then reports
    // the previous day everywhere west of UTC.
    expect(q.text).toContain("to_char(d.reviewed, 'YYYY-MM-DD') as reviewed");
    expect(q.text).toContain('c."text"');
  });
});

describe('ranking', () => {
  it('a vector query uses <=> against a halfvec(1024) literal and skips unembedded rows', async () => {
    const ex = recordingExecutor([[]]);
    await searchBrainIndex({ vector: vector(), limit: 5 }, ex);

    const q = ex.last();
    expect(q.text).toContain('c.embedding <=> $1::halfvec(1024)');
    expect(q.text).toContain('c.embedding is not null');
    expect(String(q.values[0]).startsWith('[0.5,')).toBe(true);
    expect(q.text).not.toContain('0.5'); // the literal is a parameter, not text
  });

  it('a text query ranks with ts_rank_cd, turned into a distance', async () => {
    const ex = recordingExecutor([[]]);
    await searchBrainIndex({ text: 'what commission does Taskly charge', limit: 5 }, ex);

    const q = ex.last();
    expect(q.text).toContain('websearch_to_tsquery');
    expect(q.text).toContain('1 - ts_rank_cd(');
    expect(q.text).toContain(', 32)'); // rank/(rank+1): bounded, so 1 - rank is a distance
    expect(q.text).toContain('@@');
    // Once for the rank, once for the match: the tsquery is built twice and
    // both times as a parameter, never spliced.
    expect(q.values.slice(0, 2)).toEqual([
      'what commission does Taskly charge',
      'what commission does Taskly charge',
    ]);
  });

  it('lets the vector decide when both are supplied', async () => {
    const ex = recordingExecutor([[]]);
    await searchBrainIndex({ vector: vector(), text: 'commission', limit: 5 }, ex);

    const q = ex.last();
    expect(q.text).toContain('<=>');
    expect(q.text).not.toContain('ts_rank_cd');
    expect(q.values).not.toContain('commission');
  });

  it('refuses a query with neither, rather than answering one', async () => {
    const ex = recordingExecutor([[]]);
    await expect(searchBrainIndex({ limit: 5 }, ex)).rejects.toThrow(AdapterError);
    await expect(searchBrainIndex({ limit: 5 }, ex)).rejects.toThrow(/needs a vector or text/);
    expect(ex.queries).toHaveLength(0);
  });

  it('refuses a query vector of the wrong width before issuing anything', async () => {
    const ex = recordingExecutor([[]]);
    await expect(searchBrainIndex({ vector: [0.1, 0.2], limit: 5 }, ex)).rejects.toThrow(
      ConstraintError,
    );
    expect(ex.queries).toHaveLength(0);
  });

  it('orders by distance with a stable tiebreak, so the limit cut is deterministic', async () => {
    const ex = recordingExecutor([[]]);
    await searchBrainIndex({ vector: vector(), limit: 5 }, ex);
    expect(ex.last().text).toContain('order by distance, d.path, c.ordinal');
  });

  it('clamps the candidate budget to a non-negative integer', async () => {
    const ex = recordingExecutor([[], []]);
    await searchBrainIndex({ vector: vector(), limit: -5 }, ex);
    expect(ex.last().values.at(-1)).toBe(0);

    await searchBrainIndex({ vector: vector(), limit: 3.7 }, ex);
    expect(ex.last().values.at(-1)).toBe(3);
  });
});

describe('decoding', () => {
  it('maps a joined row onto a candidate, chunk and document metadata alike', async () => {
    const ex = recordingExecutor([[candidateRow()]]);
    const [first] = await searchBrainIndex({ vector: vector(), limit: 5 }, ex);

    expect(first).toEqual({
      chunk: {
        chunkId: 'sha-a:0',
        ordinal: 0,
        heading: 'Commission',
        text: 'The rate.',
        chunkSha: 'c-a-0',
      },
      doc: {
        path: PATH,
        title: 'A',
        type: 'spec',
        status: 'canonical',
        reviewed: '2026-08-01',
        caveats: ['GTA only.'],
        verify: ['lib/marketplace/fees.ts'],
        supersededBy: [],
        docSha: 'sha-a',
      },
      distance: 0.125,
    });
  });

  it('reads a null review date as null and an empty text[] as an empty array', () => {
    const decoded = rowToBrainCandidate(
      candidateRow({ status: 'draft', reviewed: null, caveats: null, verify: [], superseded_by: [] }),
    );
    expect(decoded.doc.reviewed).toBeNull();
    expect(decoded.doc.caveats).toEqual([]);
  });

  it('refuses a type or status the contract does not define', () => {
    expect(() => rowToBrainCandidate(candidateRow({ type: 'memo' }))).toThrow(DecodeError);
    expect(() => rowToBrainCandidate(candidateRow({ status: 'provisional' }))).toThrow(DecodeError);
  });

  it('refuses a row with no distance rather than ranking it as zero', () => {
    expect(() => rowToBrainCandidate(candidateRow({ distance: null }))).toThrow(DecodeError);
  });
});
