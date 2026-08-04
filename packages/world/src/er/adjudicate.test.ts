import { describe, it, expect } from 'vitest';
import { normalizeName } from '../identity.js';
import { AUTO_MERGE, AUTO_REJECT } from './blocking.js';
import type { ErRecord } from './blocking.js';
import { MAX_CLUSTER_SIZE, adjudicate, buildRequest, validatePartition } from './adjudicate.js';
import type {
  AdjudicationRequest,
  AdjudicationResponse,
  AdjudicatorPort,
  ScoredCandidate,
} from './adjudicate.js';

const rec = (id: string, raw: string, region?: string): ErRecord => ({
  id,
  name: normalizeName(raw),
  region: region ?? null,
});

const target = rec('t', 'Jiffy On Demand', 'toronto');

const cand = (id: string, raw: string, score: number, region = 'toronto'): ScoredCandidate => ({
  record: rec(id, raw, region),
  score,
});

const portReturning = (
  res: AdjudicationResponse,
): AdjudicatorPort & { seen: AdjudicationRequest[] } => {
  const seen: AdjudicationRequest[] = [];
  return {
    seen,
    async partition(req) {
      seen.push(req);
      return res;
    },
  };
};

describe('buildRequest — the band is the whole cost control', () => {
  it('sends only the 0.75–0.95 band', () => {
    const req = buildRequest(target, [
      cand('c1', 'Jiffy OnDemand', 0.9),
      cand('c2', 'Jiffy Lube', 0.2),
      cand('c3', 'Jiffy On Demand Toronto', 0.99),
      cand('c4', 'Jiffy On-Demand', AUTO_REJECT),
      cand('c5', 'Jiffy Demand On', AUTO_MERGE),
    ]);
    expect(req.candidates.map((c) => c.id)).toEqual(['c1', 'c4']);
  });

  it('orders by DESCENDING score so truncation drops the weakest', () => {
    const many = Array.from({ length: 14 }, (_v, i) =>
      cand(
        `c${String(i).padStart(2, '0')}`,
        `Jiffy On Demand ${'x'.repeat(i + 1)}`,
        0.76 + i * 0.01,
      ),
    );
    const req = buildRequest(target, many);
    expect(req.candidates).toHaveLength(MAX_CLUSTER_SIZE);
    expect(MAX_CLUSTER_SIZE).toBe(9);
    const scores = req.candidates.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // The nine strongest survived; the weak tail was what got cut.
    expect(req.candidates[0]?.score).toBeCloseTo(0.89, 6);
    expect(req.candidates[8]?.score).toBeCloseTo(0.81, 6);
    expect(req.candidates.map((c) => c.id)).not.toContain('c00');
  });

  it('breaks score ties on id, so the payload is byte-stable', () => {
    const a = buildRequest(target, [cand('zz', 'Jiffy A', 0.8), cand('aa', 'Jiffy B', 0.8)]);
    const b = buildRequest(target, [cand('aa', 'Jiffy B', 0.8), cand('zz', 'Jiffy A', 0.8)]);
    expect(a).toEqual(b);
    expect(a.candidates.map((c) => c.id)).toEqual(['aa', 'zz']);
  });

  it('carries only the fields the decision needs', () => {
    const withKey: ScoredCandidate = {
      record: {
        ...rec('k1', 'Jiffy OnDemand', 'toronto'),
        keys: [
          { kind: 'social', valueNorm: 'instagram:jiffy' },
          { kind: 'domain', valueNorm: 'jiffy.example' },
        ],
      },
      score: 0.8,
    };
    const req = buildRequest(target, [withKey]);
    expect(Object.keys(req.candidates[0] ?? {}).sort()).toEqual([
      'hardKeys',
      'id',
      'name',
      'region',
      'score',
    ]);
    // Sorted, so two runs produce the same bytes.
    expect(req.candidates[0]?.hardKeys).toEqual(['domain:jiffy.example', 'social:instagram:jiffy']);
    expect(req.candidates[0]?.name).toBe('jiffy ondemand');
  });

  it('rounds the score so the payload is cacheable', () => {
    const req = buildRequest(target, [cand('c1', 'Jiffy OnDemand', 0.8123456789)]);
    expect(req.candidates[0]?.score).toBe(0.812);
  });

  it('never re-opens a pair identity already settled', () => {
    const shared = { kind: 'domain', valueNorm: 'jiffyondemand.com' } as const;
    const keyed: ErRecord = { ...target, keys: [shared] };
    const twin: ScoredCandidate = {
      record: { ...rec('c1', 'Jiffy OnDemand', 'toronto'), keys: [shared] },
      score: 0.8,
    };
    expect(buildRequest(keyed, [twin]).candidates).toEqual([]);

    // ...and an exact-only name that did not match exactly is a settled REJECT.
    const brand = rec('b1', '3M', 'toronto');
    expect(buildRequest(brand, [cand('b2', '3M Innovations', 0.8)]).candidates).toEqual([]);
  });

  it('excludes the target from its own candidate list', () => {
    expect(buildRequest(target, [{ record: target, score: 0.8 }]).candidates).toEqual([]);
  });
});

describe('adjudicate — happy paths', () => {
  it('merges the group the target lands in', async () => {
    const port = portReturning({
      groups: [{ ids: ['t', 'c1'] }, { ids: ['c2'] }],
      rationale: 'c1 is a spacing variant; c2 is a different trade',
    });
    const out = await adjudicate(
      target,
      [cand('c1', 'Jiffy OnDemand', 0.9), cand('c2', 'Jiffy Lube Toronto', 0.8)],
      port,
    );
    expect(out).toEqual({
      decision: 'merge',
      targetId: 't',
      mergeWith: ['c1'],
      rationale: 'c1 is a spacing variant; c2 is a different trade',
    });
    expect(port.seen).toHaveLength(1);
  });

  it('reports no_match when the target is alone', async () => {
    const port = portReturning({ groups: [{ ids: ['t'] }, { ids: ['c1'] }] });
    const out = await adjudicate(target, [cand('c1', 'Jiffy Lube Toronto', 0.8)], port);
    expect(out.decision).toBe('no_match');
  });

  it('skips without calling the port when nothing is in the band', async () => {
    const port = portReturning({ groups: [] });
    const out = await adjudicate(target, [cand('c1', 'Jiffy Lube', 0.2)], port);
    expect(out.decision).toBe('skip');
    expect(port.seen).toHaveLength(0);
  });

  it('makes exactly ONE call for a nine-candidate cluster, not N pairwise calls', async () => {
    const port = portReturning({ groups: [{ ids: ['t'] }] });
    const many = Array.from({ length: 9 }, (_v, i) => cand(`c${i}`, `Jiffy Variant ${i}`, 0.8));
    await adjudicate(target, many, port);
    expect(port.seen).toHaveLength(1);
    expect(port.seen[0]?.candidates).toHaveLength(9);
  });

  it('truncates the rationale rather than storing whatever comes back', async () => {
    const port = portReturning({ groups: [{ ids: ['t', 'c1'] }], rationale: 'x'.repeat(5000) });
    const out = await adjudicate(target, [cand('c1', 'Jiffy OnDemand', 0.9)], port);
    expect(out.decision === 'merge' && out.rationale.length).toBe(500);
  });
});

describe('adjudicate ABSTAINS on every malformed partition', () => {
  const one = [cand('c1', 'Jiffy OnDemand', 0.9), cand('c2', 'Jiffy Lube Toronto', 0.8)];
  const run = async (res: unknown): Promise<string> => {
    const port: AdjudicatorPort = {
      async partition() {
        return res as AdjudicationResponse;
      },
    };
    const out = await adjudicate(target, one, port);
    return out.decision === 'abstain' ? out.reason : `NOT ABSTAINED: ${out.decision}`;
  };

  it('abstains when there is no groups array', async () => {
    expect(await run(null)).toMatch(/no groups array/);
    expect(await run({})).toMatch(/no groups array/);
    expect(await run({ groups: 'everything' })).toMatch(/no groups array/);
  });

  it('abstains on a group that is not a list of ids', async () => {
    expect(await run({ groups: [{ ids: 'c1' }] })).toMatch(/no ids array/);
    expect(await run({ groups: [null] })).toMatch(/no ids array/);
    expect(await run({ groups: [{ ids: [] }] })).toMatch(/empty/);
  });

  it('abstains on an id it was never given (hallucinated entity)', async () => {
    expect(await run({ groups: [{ ids: ['t', 'c1', 'c99'] }, { ids: ['c2'] }] })).toMatch(
      /unknown id "c99"/,
    );
    expect(await run({ groups: [{ ids: ['t', 42] }, { ids: ['c1'] }, { ids: ['c2'] }] })).toMatch(
      /unknown id "42"/,
    );
  });

  it('abstains on overlapping groups — a partition cannot share members', async () => {
    expect(await run({ groups: [{ ids: ['t', 'c1'] }, { ids: ['c1', 'c2'] }] })).toMatch(
      /"c1" appears in more than one group/,
    );
    expect(await run({ groups: [{ ids: ['t', 'c1', 'c1'] }, { ids: ['c2'] }] })).toMatch(
      /more than one group/,
    );
  });

  it('abstains when a candidate was silently dropped', async () => {
    // Omission is the dangerous one: it looks like a clean answer.
    expect(await run({ groups: [{ ids: ['t', 'c1'] }] })).toMatch(/"c2" was omitted/);
  });

  it('abstains when the target itself is missing', async () => {
    expect(await run({ groups: [{ ids: ['c1'] }, { ids: ['c2'] }] })).toMatch(/"t" was omitted/);
  });

  it('abstains when the port throws — a timeout is not evidence', async () => {
    const port: AdjudicatorPort = {
      async partition() {
        throw new Error('upstream 503');
      },
    };
    const out = await adjudicate(target, one, port);
    expect(out).toEqual({ decision: 'abstain', reason: 'adjudicator failed: upstream 503' });
  });

  it('never turns a malformed answer into a merge', async () => {
    for (const bad of [
      null,
      {},
      { groups: [{ ids: ['t', 'c1'] }] },
      { groups: [{ ids: ['t', 'c1'] }, { ids: ['c1', 'c2'] }] },
      { groups: [{ ids: ['t', 'ghost'] }, { ids: ['c1'] }, { ids: ['c2'] }] },
    ]) {
      expect(await run(bad)).not.toMatch(/NOT ABSTAINED/);
    }
  });
});

describe('validatePartition is usable on its own', () => {
  it('accepts a well-formed partition', () => {
    const req = buildRequest(target, [cand('c1', 'Jiffy OnDemand', 0.9)]);
    const out = validatePartition(req, { groups: [{ ids: ['t', 'c1'] }] });
    expect(out).toEqual({ decision: 'merge', targetId: 't', mergeWith: ['c1'], rationale: '' });
  });

  it('sorts mergeWith so the outcome is stable', () => {
    const req = buildRequest(target, [
      cand('c1', 'Jiffy OnDemand', 0.9),
      cand('c2', 'Jiffy On Demand GTA', 0.85),
    ]);
    const out = validatePartition(req, { groups: [{ ids: ['c2', 't', 'c1'] }] });
    expect(out.decision === 'merge' && out.mergeWith).toEqual(['c1', 'c2']);
  });
});
