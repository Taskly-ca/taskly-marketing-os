/**
 * The Postgres `FindingStore`, without Postgres.
 *
 * The interesting proofs here are about DEDUPLICATION, because that is the one
 * piece of behaviour this adapter implements rather than delegates: there is no
 * unique index on the dedupe key and there cannot be one, so the correctness
 * argument is (a) the SQL fold can never hide a duplicate from the JavaScript
 * key, and (b) the lock is taken BEFORE the candidate read, so the check and
 * the insert cannot be interleaved. Both are checkable with no connection.
 *
 * (a) is asserted as a property: for every pair of claims that
 * `findingDedupeKey` considers the same, `claimFold` must agree. That is the
 * implication the SQL filter depends on, and it is the thing that would break
 * silently if `normalizeClaim` ever grew a step.
 */
import { describe, expect, it } from 'vitest';
import { withTx, type PooledClient, type QueryRow } from '@tmos/db';
import type { Finding } from '@tmos/contracts';
import { findingDedupeKey } from '@tmos/reason';

import { DecodeError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import { conformanceFinding, makeFindingFixtures } from '../testing/finding.conformance.js';
import {
  claimFold,
  findingById,
  findingChain,
  findingsBySubject,
  putFinding,
  recentFindings,
  rowToFinding,
  supersedeFinding,
} from './finding-store.js';

const FINDING = '99999999-9999-4999-8999-999999999999';
const OTHER = '88888888-8888-4888-8888-888888888888';
const T0 = '2026-07-01T00:00:00.000Z';

const fx = makeFindingFixtures();

/** Shaped the way node-postgres really answers: numeric → string, timestamptz → Date. */
const cannedFinding = (over: Partial<QueryRow> = {}): QueryRow => ({
  id: FINDING,
  claim: 'Jiffy raised list prices to $129',
  so_what: 'their entry price now sits above ours in the same postal codes',
  subject_refs: ['company:jiffy'],
  evidence: [
    {
      signal_id: null,
      fact_id: null,
      source_url: 'https://example.test/pricing',
      span: 'now $129',
      observed_at: T0,
    },
  ],
  basis: 'inferred_from_sources',
  causal_rung: 0,
  stakes: 'medium',
  region: 'ca',
  domain_score: '0.62',
  generated_by: 'agent:test@1',
  reviewed_by: null,
  superseded_by: null,
  supersede_reason: null,
  created_at: new Date(T0),
  ...over,
});

/** A pooled client that answers the transaction bookkeeping and records it. */
function fakeConnect(): { connect: () => Promise<PooledClient>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    connect: async () => ({
      async query(text: string) {
        calls.push(text);
        return { rows: [], rowCount: 0 };
      },
      release() {},
    }),
  };
}

/** Runs `body` as if the caller were already inside someone's `withTx`. */
const inFakeTx = async <T>(body: () => Promise<T>): Promise<T> => withTx(body, fakeConnect());

describe('the SQL narrowing fold', () => {
  it('is implied by the dedupe key: same key ⇒ same fold', () => {
    const claim = 'Jiffy raised list prices to $129 in the GTA';
    const variants = [
      claim,
      claim.toUpperCase(),
      `   ${claim}   `,
      claim.replace(/ /g, '   '),
      `${claim}.`,
      `${claim}!!!`,
      `${claim}?;:.`,
      `\n\t${claim}\n`,
      `  ${claim.toUpperCase().replace(/ /g, '  ')}.  `,
    ];

    const key = (c: string): string =>
      findingDedupeKey({ claim: c, evidence: cannedFinding().evidence as Finding['evidence'] });

    for (const variant of variants) {
      // The premise: these all dedupe to the same finding…
      expect(key(variant)).toBe(key(claim));
      // …so the SQL filter MUST select the row, or the duplicate is missed.
      expect(claimFold(variant)).toBe(claimFold(claim));
    }
  });

  it('over-selects rather than under-selects, which is the safe direction', () => {
    // Different claims can share a fold; the exact key then separates them.
    expect(claimFold('price: $129')).toBe(claimFold('PRICE $1.29'));
    expect(
      findingDedupeKey({
        claim: 'price: $129',
        evidence: cannedFinding().evidence as Finding['evidence'],
      }),
    ).not.toBe(
      findingDedupeKey({
        claim: 'PRICE $1.29',
        evidence: cannedFinding().evidence as Finding['evidence'],
      }),
    );
  });

  it('drops every character a locale could disagree about', () => {
    expect(claimFold('ünïcode 🎉 emoji — dash')).toBe('ncodeemojidash');
  });
});

describe('put', () => {
  it('locks the dedupe key BEFORE it looks for a duplicate, then inserts', async () => {
    const ex = recordingExecutor([[], [], [cannedFinding()]]);
    const finding = conformanceFinding(fx);

    const result = await inFakeTx(() => putFinding(finding, ex));

    expect(result.ok).toBe(true);
    expect(ex.queries).toHaveLength(3);
    // The order IS the race protection: a candidate read taken before the lock
    // would let two workers both see "no duplicate" and both insert.
    expect(ex.queries[0]?.text).toContain('pg_advisory_xact_lock');
    expect(ex.queries[0]?.values).toEqual([findingDedupeKey(finding)]);
    expect(ex.queries[1]?.text).toContain("regexp_replace(lower(f.claim), '[^a-z0-9]', '', 'g')");
    expect(ex.queries[1]?.values).toEqual([claimFold(finding.claim)]);
    expect(ex.queries[2]?.text).toContain('insert into finding as f');
    expect(ex.queries[2]?.text).toContain('on conflict (id) do nothing');
  });

  it('sends every value as a parameter and never as text', async () => {
    const ex = recordingExecutor([[], [], [cannedFinding()]]);
    const finding = conformanceFinding(fx);
    await inFakeTx(() => putFinding(finding, ex));

    const insert = ex.last();
    expect(insert.text).not.toContain(finding.claim);
    expect(insert.values).toContain(finding.claim);
    expect(insert.values).toContain(JSON.stringify(finding.evidence));
    expect(insert.values).toContainEqual(finding.subject_refs);
  });

  it('returns the ORIGINAL when a candidate has the same key, and does not insert', async () => {
    const existing = cannedFinding();
    const ex = recordingExecutor([[], [existing]]);

    // Same claim and same document as the canned row, different id and score.
    const result = await inFakeTx(() =>
      putFinding(
        conformanceFinding(fx, {
          id: OTHER,
          claim: existing.claim as string,
          evidence: rowToFinding(existing).evidence,
          domain_score: 0.9,
        }),
        ex,
      ),
    );

    expect(result).toEqual({ ok: true, stored: false, duplicateOf: rowToFinding(existing) });
    expect(ex.queries).toHaveLength(2);
    expect(ex.queries.some((q) => q.text.includes('insert into'))).toBe(false);
  });

  it('stores when a candidate shares the fold but not the key', async () => {
    // Same claim, DIFFERENT document: a second independent sighting, which is
    // what corroboration is made of and must never be collapsed.
    const existing = cannedFinding();
    const ex = recordingExecutor([[], [existing], [cannedFinding({ id: OTHER })]]);

    const result = await inFakeTx(() =>
      putFinding(
        conformanceFinding(fx, {
          id: OTHER,
          claim: existing.claim as string,
          evidence: [
            {
              signal_id: null,
              fact_id: null,
              source_url: 'https://elsewhere.test/report',
              span: 'now $129',
              observed_at: T0,
            },
          ],
        }),
        ex,
      ),
    );

    expect(result.ok && result.stored).toBe(true);
    expect(ex.queries).toHaveLength(3);
  });

  it('reports duplicate_id rather than letting the primary key raise', async () => {
    // `on conflict (id) do nothing` returns no row. A raised 23505 would abort
    // the caller's whole transaction over what is a RESULT in this port.
    const ex = recordingExecutor([[], [], []]);
    const result = await inFakeTx(() => putFinding(conformanceFinding(fx, { id: FINDING }), ex));

    expect(result).toEqual({
      ok: false,
      reason: 'duplicate_id',
      detail: `finding ${FINDING} already stored`,
    });
  });

  it('refuses an invalid finding without opening a transaction or taking a lock', async () => {
    const ex = recordingExecutor();
    // No `inFakeTx`: reaching `withTx` at all would need a database, so this
    // resolving proves the schema check happens first.
    const result = await putFinding(conformanceFinding(fx, { evidence: [] }), ex);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid_finding');
    expect(ex.queries).toEqual([]);
  });
});

describe('supersede', () => {
  it('refuses a blank reason and a malformed id before any statement', async () => {
    const ex = recordingExecutor();
    const replacement = conformanceFinding(fx);

    const noReason = await supersedeFinding(FINDING, replacement, '   ', ex);
    expect(noReason.ok === false && noReason.reason).toBe('missing_reason');

    const malformed = await supersedeFinding('finding_1', replacement, 'because', ex);
    expect(malformed.ok === false && malformed.reason).toBe('not_found');

    expect(ex.queries).toEqual([]);
  });

  it('reports not_found, already_superseded and self_supersede in the memory store’s order', async () => {
    const missing = recordingExecutor([[]]);
    const gone = await inFakeTx(() =>
      supersedeFinding(FINDING, conformanceFinding(fx), 'because', missing),
    );
    expect(gone.ok === false && gone.reason).toBe('not_found');

    const closed = recordingExecutor([[cannedFinding({ superseded_by: OTHER })]]);
    const twice = await inFakeTx(() =>
      supersedeFinding(FINDING, conformanceFinding(fx), 'because', closed),
    );
    expect(twice.ok === false && twice.reason).toBe('already_superseded');
    expect(closed.queries).toHaveLength(1);

    const open = recordingExecutor([[cannedFinding()]]);
    const itself = await inFakeTx(() =>
      supersedeFinding(FINDING, rowToFinding(cannedFinding()), 'because', open),
    );
    expect(itself.ok === false && itself.reason).toBe('self_supersede');
  });

  it('inserts the replacement first, then closes the original in one guarded update', async () => {
    const original = cannedFinding();
    const replacement = cannedFinding({ id: OTHER, claim: 'Jiffy raised list prices to $139' });
    const ex = recordingExecutor([
      [original], // byId
      [replacement], // insert … returning
      [cannedFinding({ superseded_by: OTHER, supersede_reason: 'misread the table' })], // update
    ]);

    const result = await inFakeTx(() =>
      supersedeFinding(FINDING, rowToFinding(replacement), 'misread the table', ex),
    );

    expect(result.ok).toBe(true);
    expect(ex.queries).toHaveLength(3);
    // No lock, no candidate search: a correction that only rewrites `so_what`
    // shares the original's key and deduplication would swallow it.
    expect(ex.queries.some((q) => q.text.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(ex.queries[1]?.text).toContain('insert into finding as f');
    expect(ex.queries[2]?.text).toContain('update finding as f');
    // The precondition is in the WHERE clause, so a concurrent supersession
    // returns zero rows instead of raising and poisoning the transaction.
    expect(ex.queries[2]?.text).toContain('f.superseded_by is null');
    // …and the update writes exactly two columns. A correction is never an edit.
    expect(ex.queries[2]?.text).toMatch(/set\s+superseded_by\s*=/);
    expect(ex.queries[2]?.text).not.toMatch(/set[\s\S]*\bclaim\s*=/);
  });

  it('reports a concurrent supersession as already_superseded, not as a lost update', async () => {
    const ex = recordingExecutor([[cannedFinding()], [cannedFinding({ id: OTHER })], []]);
    const result = await inFakeTx(() =>
      supersedeFinding(FINDING, conformanceFinding(fx, { id: OTHER }), 'because', ex),
    );
    expect(result.ok === false && result.reason).toBe('already_superseded');
  });
});

describe('reads', () => {
  it('is live-only by default and includes the past only when asked', async () => {
    const live = recordingExecutor([[]]);
    await findingsBySubject('company:jiffy', undefined, live);
    expect(live.last().text).toContain('f.superseded_by is null');

    const all = recordingExecutor([[]]);
    await findingsBySubject('company:jiffy', { includeSuperseded: true }, all);
    expect(all.last().text).not.toContain('f.superseded_by is null');
  });

  it('matches a subject inside the text[] rather than in JavaScript', async () => {
    const ex = recordingExecutor([[]]);
    await findingsBySubject('company:jiffy', undefined, ex);
    expect(ex.last().text).toContain('= any(f.subject_refs)');
    expect(ex.last().values).toContain('company:jiffy');
  });

  it('guards recent’s limit the way the memory store does', async () => {
    const ex = recordingExecutor([[], [], []]);
    expect(await recentFindings(0, undefined, ex)).toEqual([]);
    expect(await recentFindings(-1, undefined, ex)).toEqual([]);
    expect(await recentFindings(Number.NaN, undefined, ex)).toEqual([]);
    expect(ex.queries).toEqual([]);

    await recentFindings(2.7, undefined, ex);
    expect(ex.last().values).toEqual([2]);
  });

  it('treats a malformed id as a miss for byId and chain', async () => {
    const ex = recordingExecutor();
    expect(await findingById('finding_1', ex)).toBeNull();
    expect(await findingChain('finding_1', ex)).toEqual([]);
    expect(ex.queries).toEqual([]);
  });

  it('walks the chain in one recursive query, guarded against a cycle', async () => {
    const ex = recordingExecutor([[cannedFinding()]]);
    await findingChain(FINDING, ex);

    const q = ex.last();
    expect(q.text).toContain('with recursive walk');
    expect(q.text).toContain('f.id <> all(w.path)');
    expect(q.text).toContain('w.depth <');
    expect(q.text).toContain('order by w.depth');
  });
});

describe('decoding', () => {
  it('maps a driver row onto a Finding', () => {
    expect(rowToFinding(cannedFinding())).toEqual({
      id: FINDING,
      claim: 'Jiffy raised list prices to $129',
      so_what: 'their entry price now sits above ours in the same postal codes',
      subject_refs: ['company:jiffy'],
      evidence: [
        {
          signal_id: null,
          fact_id: null,
          source_url: 'https://example.test/pricing',
          span: 'now $129',
          observed_at: T0,
        },
      ],
      basis: 'inferred_from_sources',
      causal_rung: 0,
      stakes: 'medium',
      region: 'ca',
      domain_score: 0.62,
      generated_by: 'agent:test@1',
      reviewed_by: null,
      superseded_by: null,
      supersede_reason: null,
      created_at: T0,
    });
  });

  it('reads evidence back from a raw jsonb string too', () => {
    const row = cannedFinding({ evidence: JSON.stringify(cannedFinding().evidence) });
    expect(rowToFinding(row).evidence).toHaveLength(1);
  });

  it('refuses a row whose shape is not a Finding', () => {
    expect(() => rowToFinding(cannedFinding({ evidence: { url: 'x' } }))).toThrow(DecodeError);
    expect(() => rowToFinding(cannedFinding({ causal_rung: 7 }))).toThrow(DecodeError);
    expect(() => rowToFinding(cannedFinding({ basis: 'vibes' }))).toThrow(DecodeError);
    expect(() => rowToFinding(cannedFinding({ subject_refs: 'company:jiffy' }))).toThrow(
      DecodeError,
    );
  });
});
