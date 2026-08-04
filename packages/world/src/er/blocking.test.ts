import { describe, it, expect } from 'vitest';
import { normalizeName } from '../identity.js';
import type { NormalizedName } from '../identity.js';
import {
  AUTO_MERGE,
  AUTO_REJECT,
  BLOCK_THRESHOLD,
  bandFor,
  blockCandidates,
  buildTokenIdf,
  scorePair,
  trigramSimilarity,
  trigrams,
} from './blocking.js';
import type { ErRecord, Signal } from './blocking.js';

const rec = (id: string, raw: string, region?: string): ErRecord => ({
  id,
  name: normalizeName(raw),
  region: region ?? null,
});

const signal = (signals: readonly Signal[], name: string): Signal => {
  const hit = signals.find((s) => s.name === name);
  if (!hit) throw new Error(`no signal named ${name}`);
  return hit;
};

describe('trigrams — pg_trgm padding semantics', () => {
  it('pads each word with TWO leading and ONE trailing space', () => {
    expect([...trigrams('cat')].sort()).toEqual(['  c', ' ca', 'at ', 'cat']);
  });

  it('yields exactly L+1 trigrams for a word of length L', () => {
    for (const w of ['a', 'ab', 'abc', 'abcdefgh']) {
      expect(trigrams(w).size).toBe(w.length + 1);
    }
  });

  it('pads every word separately, so word boundaries carry evidence', () => {
    // 8 = (3+1) for "foo" + (3+1) for "bar". A single pass over "foo bar"
    // without per-word padding would produce a different set and a different
    // similarity for every multi-word name in the pool.
    expect(trigrams('foo bar').size).toBe(8);
    expect([...trigrams('foo bar')].sort()).toEqual([
      '  b',
      '  f',
      ' ba',
      ' fo',
      'ar ',
      'bar',
      'foo',
      'oo ',
    ]);
  });

  it('treats every non-alphanumeric run as a separator and folds case', () => {
    expect(trigrams('Foo-Bar')).toEqual(trigrams('foo bar'));
    expect(trigrams('foo/bar')).toEqual(trigrams('foo   bar'));
    expect(trigrams('24/7')).toEqual(trigrams('24 7'));
    expect(trigrams('').size).toBe(0);
  });
});

describe('trigramSimilarity — |intersection| / |union|', () => {
  it('is 1 for identical strings and 0 for disjoint ones', () => {
    expect(trigramSimilarity('jiffy on demand', 'jiffy on demand')).toBe(1);
    expect(trigramSimilarity('zzz', 'qqq')).toBe(0);
  });

  it('returns 0 rather than NaN when a side is empty', () => {
    // An empty name is missing data, never a perfect match.
    expect(trigramSimilarity('', '')).toBe(0);
    expect(trigramSimilarity('anything', '')).toBe(0);
  });

  it('matches the hand-computed pg_trgm value', () => {
    // "jiffy on demand" has 6+3+7 = 16 trigrams, "jiffy ondemand" has 6+9 = 15,
    // 13 are shared → 13 / (16+15-13) = 13/18.
    expect(trigramSimilarity('jiffy on demand', 'jiffy ondemand')).toBeCloseTo(13 / 18, 6);
  });
});

describe('blockCandidates — recall first', () => {
  const pool = [
    rec('p1', 'Jiffy On Demand Inc', 'toronto'),
    rec('p2', 'Jiffy OnDemand', 'toronto'),
    rec('p3', 'Jiffy Lube', 'toronto'),
    rec('p4', 'Maple Leaf Cleaning Co', 'toronto'),
  ];

  it('keeps a false candidate rather than risk an unrecoverable miss', () => {
    const target = pool[0] as ErRecord;
    const ids = blockCandidates(target, pool).map((c) => c.id);
    // "jiffy lube" scores 0.286 — under pg_trgm's default 0.3 and over ours.
    // Blocking it costs one scoring pass; missing a real variant costs the link
    // forever, because nothing downstream ever reconsiders an unblocked pair.
    expect(ids).toContain('p2');
    expect(ids).toContain('p3');
    expect(ids).not.toContain('p4');
    expect(BLOCK_THRESHOLD).toBeLessThan(0.3);
  });

  it('never returns the target itself and sorts best-first', () => {
    const target = pool[0] as ErRecord;
    const out = blockCandidates(target, pool);
    expect(out.map((c) => c.id)).not.toContain('p1');
    expect(out[0]?.id).toBe('p2');
    for (let i = 1; i < out.length; i++) {
      expect((out[i - 1] as { similarity: number }).similarity).toBeGreaterThanOrEqual(
        (out[i] as { similarity: number }).similarity,
      );
    }
  });

  it('honours an explicit threshold and limit', () => {
    const target = pool[0] as ErRecord;
    expect(blockCandidates(target, pool, { threshold: 0.3 }).map((c) => c.id)).toEqual(['p2']);
    expect(blockCandidates(target, pool, { limit: 1 })).toHaveLength(1);
  });

  it('skips pairs that may never be fuzzy-matched', () => {
    const brandPool = [rec('b1', '3M'), rec('b2', '3M Innovations'), rec('b3', '3M Company')];
    expect(blockCandidates(brandPool[0] as ErRecord, brandPool)).toEqual([]);
  });
});

describe('scorePair refuses exact-only names', () => {
  it('gives a protected brand a REASON, never a similarity number', () => {
    const out = scorePair(rec('b1', '3M'), rec('b2', '3M Innovations'));
    expect(out.score).toBe(0);
    expect(out.scorable).toBe(false);
    expect(out.band).toBe('reject');
    expect(out.signals.map((s) => s.name)).toEqual(['identity']);
    expect(signal(out.signals, 'identity').detail).toContain('protected_brand');
    // The point of the refusal: no number exists for someone to threshold.
    expect(out.signals.some((s) => s.name === 'trigram')).toBe(false);
  });

  it('refuses AT&T against a near neighbour too', () => {
    const out = scorePair(rec('b1', 'AT&T'), rec('b2', 'AT&T Wireless'));
    expect(out.score).toBe(0);
    expect(out.scorable).toBe(false);
  });

  it('still merges an exact protected-name equality', () => {
    const out = scorePair(rec('b1', '3M'), rec('b2', '3M'));
    expect(out.score).toBe(1);
    expect(out.scorable).toBe(false);
    expect(signal(out.signals, 'identity').detail).toContain('exact equality');
  });

  it('refuses a too-short name', () => {
    const out = scorePair(rec('s1', 'Ace'), rec('s2', 'Acer'));
    expect(out.score).toBe(0);
    expect(signal(out.signals, 'identity').detail).toContain('too_short');
  });

  it('merges on a shared hard key without scoring anything', () => {
    const left: ErRecord = {
      ...rec('h1', 'Jiffy On Demand Inc'),
      keys: [{ kind: 'domain', valueNorm: 'jiffyondemand.com' }],
    };
    const right: ErRecord = {
      ...rec('h2', 'Completely Different Name'),
      keys: [{ kind: 'domain', valueNorm: 'jiffyondemand.com' }],
    };
    const out = scorePair(left, right);
    expect(out.score).toBe(1);
    expect(out.band).toBe('merge');
    expect(out.scorable).toBe(false);
  });
});

describe('numeric disagreement is a near-veto', () => {
  it('separates Cleaner 1 from Cleaner 2 despite a high name similarity', () => {
    const out = scorePair(rec('n1', 'Cleaner 1', 'toronto'), rec('n2', 'Cleaner 2', 'toronto'));
    expect(signal(out.signals, 'trigram').value).toBeGreaterThan(0.6);
    expect(signal(out.signals, 'numeric').contribution).toBeLessThan(-1);
    expect(out.score).toBeLessThan(AUTO_REJECT);
    expect(out.band).toBe('reject');
  });

  it('does NOT penalise a tokenisation artefact — 24/7 vs 247', () => {
    const out = scorePair(
      rec('n3', 'Toronto 24/7 Cleaning', 'toronto'),
      rec('n4', 'Toronto 247 Cleaning', 'toronto'),
    );
    const num = signal(out.signals, 'numeric');
    expect(num.contribution).toBe(0);
    expect(num.detail).toContain('digit signature');
    expect(out.score).toBeGreaterThan(AUTO_REJECT);
  });

  it('rewards agreeing numerics and softens the one-sided case', () => {
    const agree = scorePair(rec('a1', 'Cleaner 1 Toronto'), rec('a2', 'Cleaner 1 GTA'));
    expect(signal(agree.signals, 'numeric').contribution).toBeGreaterThan(0);

    const oneSided = scorePair(rec('o1', 'Cleaner Toronto'), rec('o2', 'Cleaner Toronto 2'));
    const c = signal(oneSided.signals, 'numeric').contribution;
    expect(c).toBeLessThan(0);
    expect(c).toBeGreaterThan(signal(agree.signals, 'numeric').contribution - 3);
  });
});

describe('rare tokens outweigh common ones', () => {
  const raw = [
    'Zamboni Polishing',
    'Zamboni Buffing',
    'Maple Services',
    'Birch Services',
    'Cedar Services',
    'Willow Services',
    'Aspen Services',
    'Spruce Services',
    'Alder Services',
    'Poplar Services',
  ];
  const names: NormalizedName[] = raw.map((r) => normalizeName(r));
  const idf = buildTokenIdf(names);

  it('weights a token by how rare it is in the pool', () => {
    // "services" is in 8 of 10 names; "zamboni" is in 2.
    expect(idf.idf('zamboni')).toBeGreaterThan(idf.idf('services'));
    expect(idf.docCount).toBe(10);
  });

  it('scores a shared RARE token above a shared COMMON token at equal trigram similarity', () => {
    const rarePair = scorePair(
      rec('r1', 'Zamboni Polishing', 'toronto'),
      rec('r2', 'Zamboni Buffing', 'toronto'),
      { idf },
    );
    const commonPair = scorePair(
      rec('c1', 'Maple Services', 'toronto'),
      rec('c2', 'Birch Services', 'toronto'),
      { idf },
    );
    // The two pairs have almost identical pg_trgm similarity, so trigrams alone
    // cannot tell them apart — the idf weighting is what does.
    expect(
      Math.abs(
        signal(rarePair.signals, 'trigram').value - signal(commonPair.signals, 'trigram').value,
      ),
    ).toBeLessThan(0.05);
    expect(signal(rarePair.signals, 'rare_token').value).toBeGreaterThan(
      signal(commonPair.signals, 'rare_token').value,
    );
    expect(rarePair.score).toBeGreaterThan(commonPair.score);
  });

  it('falls back to uniform weights when no pool is supplied', () => {
    const withPool = scorePair(rec('r1', 'Zamboni Polishing'), rec('r2', 'Zamboni Buffing'), {
      idf,
    });
    const without = scorePair(rec('r1', 'Zamboni Polishing'), rec('r2', 'Zamboni Buffing'));
    expect(signal(without.signals, 'rare_token').detail).toContain('n=0');
    expect(signal(withPool.signals, 'rare_token').value).not.toBe(
      signal(without.signals, 'rare_token').value,
    );
  });
});

describe('region', () => {
  it('is evidence for when it agrees, against when it disagrees, and mute when unknown', () => {
    const same = scorePair(
      rec('g1', 'Handy Home Repair', 'toronto'),
      rec('g2', 'Handy Home Repairs', 'toronto'),
    );
    const diff = scorePair(
      rec('g1', 'Handy Home Repair', 'toronto'),
      rec('g2', 'Handy Home Repairs', 'vancouver'),
    );
    const unknown = scorePair(rec('g1', 'Handy Home Repair'), rec('g2', 'Handy Home Repairs'));
    expect(signal(same.signals, 'region').contribution).toBeGreaterThan(0);
    expect(signal(diff.signals, 'region').contribution).toBeLessThan(0);
    expect(signal(unknown.signals, 'region').contribution).toBe(0);
    expect(same.score).toBeGreaterThan(unknown.score);
    expect(unknown.score).toBeGreaterThan(diff.score);
  });
});

describe('bands', () => {
  it('splits reject / adjudicate / merge at the documented edges', () => {
    expect(bandFor(0)).toBe('reject');
    expect(bandFor(AUTO_REJECT - 1e-9)).toBe('reject');
    expect(bandFor(AUTO_REJECT)).toBe('adjudicate');
    expect(bandFor(AUTO_MERGE - 1e-9)).toBe('adjudicate');
    expect(bandFor(AUTO_MERGE)).toBe('merge');
    expect(bandFor(1)).toBe('merge');
  });
});

describe('realistic GTA home-services pool', () => {
  const pool = [
    rec('t1', 'Jiffy On Demand Inc', 'toronto'),
    rec('t2', 'Jiffy OnDemand', 'toronto'),
    rec('t3', 'Jiffy Lube', 'toronto'),
    rec('t4', 'Toronto Handyman', 'toronto'),
    rec('t5', 'TO Handyman', 'toronto'),
    rec('t6', '3M', 'toronto'),
    rec('t7', '3M Innovations', 'toronto'),
    rec('t8', 'Maple Leaf Cleaning Co', 'toronto'),
    rec('t9', 'Toronto Plumbing', 'toronto'),
  ];
  const idf = buildTokenIdf(pool.map((r) => r.name));
  const byId = (id: string): ErRecord => {
    const hit = pool.find((r) => r.id === id);
    if (!hit) throw new Error(id);
    return hit;
  };
  const score = (a: string, b: string): number => scorePair(byId(a), byId(b), { idf }).score;

  it('separates the true variant from the shared-common-token distractor', () => {
    // "Jiffy" is in three of the nine names. A shared common token must not
    // carry a pair on its own — the character-level evidence has to.
    expect(score('t1', 't2')).toBeGreaterThanOrEqual(AUTO_REJECT);
    expect(score('t1', 't3')).toBeLessThan(AUTO_REJECT);
    expect(score('t1', 't2')).toBeGreaterThan(score('t1', 't3') + 0.5);
  });

  it('blocks the abbreviation pair and scores it into review, not into a merge', () => {
    const ids = blockCandidates(byId('t4'), pool).map((c) => c.id);
    expect(ids).toContain('t5');
    const s = score('t4', 't5');
    expect(s).toBeGreaterThanOrEqual(AUTO_REJECT);
    expect(s).toBeLessThan(AUTO_MERGE);
    expect(bandFor(s)).toBe('adjudicate');
  });

  it('rejects the same-city different-trade pair', () => {
    expect(score('t4', 't9')).toBeLessThan(AUTO_REJECT);
  });

  it('never scores the protected brand against its look-alike', () => {
    const out = scorePair(byId('t6'), byId('t7'), { idf });
    expect(out.scorable).toBe(false);
    expect(out.score).toBe(0);
    expect(blockCandidates(byId('t6'), pool)).toEqual([]);
  });

  it('leaves the unrelated cleaner out of every candidate set', () => {
    for (const target of ['t1', 't4', 't9']) {
      expect(blockCandidates(byId(target), pool).map((c) => c.id)).not.toContain('t8');
    }
  });
});
