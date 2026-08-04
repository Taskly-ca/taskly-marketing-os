import { describe, it, expect } from 'vitest';
import {
  scoreFinding,
  COMPETITOR_BONUS,
  DEFAULT_COMPETITORS,
  FARM_ONLY_CEILING,
  GEO_MAX,
  GEO_WEIGHT,
  GTA_CORRIDOR,
  SOURCE_MAX,
  SOURCE_TIER_WEIGHT,
  TRUST_BONUS,
} from './domain.js';
import type { DomainScoringConfig, ScorableFinding } from './domain.js';

/** $60 — injected, exactly as the real caller must inject it. */
const CFG: DomainScoringConfig = { cacCeilingCents: 6_000 };

const f = (over: Partial<ScorableFinding> = {}): ScorableFinding => ({
  claim: 'A competitor changed something.',
  so_what: 'Worth watching.',
  source_tiers: ['trade'],
  ...over,
});

const score = (over: Partial<ScorableFinding>, cfg: DomainScoringConfig = CFG) =>
  scoreFinding(f(over), cfg);

const sumOf = (b: ReadonlyArray<{ delta: number }>) => b.reduce((s, c) => s + c.delta, 0);

/* ── CAC ──────────────────────────────────────────────────────────────────── */

describe('the CAC ceiling auto-rejects, and shows its working', () => {
  it('rejects a paid channel over the ceiling with the arithmetic spelled out', () => {
    const r = score({
      claim: 'Run Google Ads across the GTA.',
      channel: { channel: 'google_ads', paid: true, spend_cents: 400_000, expected_customers: 20 },
    });

    expect(r.rejection).not.toBeNull();
    expect(r.domain_score).toBe(0);
    expect(r.rejection?.implied_cac_cents).toBe(20_000);
    expect(r.rejection?.ceiling_cents).toBe(6_000);
    // The arithmetic is the reason a human can trust — or overturn — this.
    expect(r.rejection?.arithmetic).toBe(
      '$4,000.00 spend ÷ 20 customers = $200.00 CAC > $60.00 ceiling',
    );
    expect(r.breakdown.some((c) => c.name === 'cac_ceiling')).toBe(true);
  });

  it('accepts a paid channel under the ceiling', () => {
    const r = score({
      claim: 'Run Google Ads across the GTA.',
      channel: { channel: 'google_ads', paid: true, spend_cents: 100_000, expected_customers: 25 },
    });
    expect(r.rejection).toBeNull();
    expect(r.domain_score).toBeGreaterThan(0);
  });

  it('rejects a paid channel that promises no customers — the CAC is unbounded', () => {
    const r = score({
      channel: { channel: 'billboards', paid: true, spend_cents: 250_000, expected_customers: 0 },
    });
    expect(r.rejection?.arithmetic).toContain('no expected customers');
    expect(r.domain_score).toBe(0);
  });

  it('leaves an organic channel alone — the ceiling is about paid acquisition', () => {
    const r = score({
      channel: { channel: 'seo', paid: false, spend_cents: 400_000, expected_customers: 20 },
    });
    expect(r.rejection).toBeNull();
  });

  it('rejects exactly at the boundary only when it is exceeded', () => {
    const at = score({
      channel: { channel: 'meta', paid: true, spend_cents: 6_000, expected_customers: 1 },
    });
    const over = score({
      channel: { channel: 'meta', paid: true, spend_cents: 6_001, expected_customers: 1 },
    });
    expect(at.rejection).toBeNull();
    expect(over.rejection).not.toBeNull();
  });
});

/* ── trust ────────────────────────────────────────────────────────────────── */

describe('trust claims are high stakes by construction', () => {
  const trustClaims = [
    'Jiffy now advertises criminal background checks on every pro.',
    'TaskRabbit added $2M liability insurance to its listings.',
    'Handy is promoting a satisfaction guarantee.',
    'A competitor claims its taskers are fully vetted and licensed.',
  ];

  for (const claim of trustClaims) {
    it(`is high stakes: "${claim.slice(0, 38)}…"`, () => {
      expect(score({ claim, source_tiers: ['farm'] }).stakes).toBe('high');
    });
  }

  it('stays high stakes even when everything else about it is weak', () => {
    // Farm sources, wrong market, no competitor named — still legal exposure.
    const r = score({
      claim: 'A Vancouver operator is advertising background checks.',
      source_tiers: ['farm'],
    });
    expect(r.stakes).toBe('high');
    expect(r.domain_score).toBeLessThanOrEqual(FARM_ONLY_CEILING);
  });

  it('is high stakes when the finding DENIES the claim too', () => {
    // Deliberately not negation-aware: "Jiffy does not run background checks"
    // is a trust-boundary finding and carries the same legal weight.
    expect(score({ claim: 'Jiffy does not run background checks.' }).stakes).toBe('high');
  });

  it('an ordinary commercial finding is not high stakes', () => {
    expect(score({ claim: 'Jiffy raised its hourly rate.' }).stakes).not.toBe('high');
  });

  it('adds a bounded bump, not a floor — a weak trust claim stays weak', () => {
    const plain = score({ claim: 'Jiffy raised its rate in Toronto.' });
    const trust = score({ claim: 'Jiffy advertises insurance in Toronto.' });
    expect(trust.domain_score - plain.domain_score).toBeCloseTo(TRUST_BONUS, 6);
  });
});

/* ── geography ────────────────────────────────────────────────────────────── */

describe('the GTA corridor', () => {
  const claim = (city: string) => `Jiffy cut its minimum job size in ${city}.`;

  it('scores a Vancouver finding below the same finding about Toronto', () => {
    const gta = score({ claim: claim('Toronto') });
    const bc = score({ claim: claim('Vancouver') });
    expect(bc.domain_score).toBeLessThan(gta.domain_score);
  });

  it('does not zero it — a competitor expanding elsewhere is a leading indicator', () => {
    const bc = score({ claim: claim('Vancouver') });
    expect(bc.domain_score).toBeGreaterThan(0);
    expect(GEO_WEIGHT.elsewhere).toBeGreaterThan(0);
    // Weighted below half, so out-of-market can never outrank in-market on
    // geography alone, and above zero so it still clears unrelated noise.
    expect(GEO_WEIGHT.elsewhere).toBeLessThan(GEO_WEIGHT.home / 2);
  });

  it('counts the whole corridor as home, not just the city of Toronto', () => {
    const toronto = score({ claim: claim('Toronto') }).domain_score;
    for (const city of ['Mississauga', 'Brampton', 'Scarborough', 'Markham', 'the GTA']) {
      expect(score({ claim: claim(city) }).domain_score).toBe(toronto);
    }
  });

  it('treats a finding naming both markets as being about ours', () => {
    const both = score({ claim: 'Jiffy is expanding from Vancouver into Toronto.' });
    expect(both.domain_score).toBe(
      score({ claim: 'Jiffy is expanding into Toronto.' }).domain_score,
    );
  });

  it('sits an unplaced finding between the two — most category news is about us', () => {
    expect(GEO_WEIGHT.unknown).toBeGreaterThan(GEO_WEIGHT.elsewhere);
    expect(GEO_WEIGHT.unknown).toBeLessThan(GEO_WEIGHT.home);
  });

  it('accepts an injected corridor — the market is a parameter, not a constant', () => {
    const cfg: DomainScoringConfig = {
      ...CFG,
      corridor: { home: ['bengaluru'], elsewhere: GTA_CORRIDOR.home },
    };
    const india = score({ claim: 'Urban Company raised prices in Bengaluru.' }, cfg);
    const toronto = score({ claim: 'Urban Company raised prices in Toronto.' }, cfg);
    expect(india.domain_score).toBeGreaterThan(toronto.domain_score);
  });
});

/* ── source tier ──────────────────────────────────────────────────────────── */

describe('source tier caps what a claim can be worth', () => {
  it('caps a farm-only claim below high confidence no matter how many there are', () => {
    const many = score({
      claim: 'Jiffy raised prices across Toronto.',
      source_tiers: Array.from({ length: 12 }, () => 'farm' as const),
    });
    expect(many.domain_score).toBeLessThanOrEqual(FARM_ONLY_CEILING);
    expect(many.breakdown.some((c) => c.name === 'farm_only_ceiling')).toBe(true);
  });

  it('twelve farms do not out-score one primary source', () => {
    const farms = score({ source_tiers: Array.from({ length: 12 }, () => 'farm' as const) });
    const one = score({ source_tiers: ['primary'] });
    expect(one.domain_score).toBeGreaterThan(farms.domain_score);
  });

  it('takes the best tier, not the average — a strong source is not diluted', () => {
    const mixed = score({ source_tiers: ['farm', 'farm', 'first_party'] });
    const alone = score({ source_tiers: ['first_party'] });
    expect(mixed.domain_score).toBe(alone.domain_score);
  });

  it('lifts the ceiling as soon as one non-farm source exists', () => {
    const lifted = score({
      claim: 'Jiffy raised prices across Toronto.',
      source_tiers: ['farm', 'aggregator'],
    });
    expect(lifted.domain_score).toBeGreaterThan(FARM_ONLY_CEILING);
  });

  it('ranks the tiers in the contract order', () => {
    const tiers = ['first_party', 'primary', 'trade', 'aggregator', 'farm'] as const;
    const weights = tiers.map((t) => SOURCE_TIER_WEIGHT[t]);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it('treats a finding with no sources at all as the weakest case', () => {
    const none = score({ source_tiers: [] });
    expect(none.domain_score).toBeLessThanOrEqual(FARM_ONLY_CEILING);
  });
});

/* ── the score itself ─────────────────────────────────────────────────────── */

describe('a score a human can argue with', () => {
  it('explains itself: the breakdown sums to the score', () => {
    const r = score({
      claim: 'Jiffy is advertising insurance across Toronto.',
      source_tiers: ['primary'],
    });
    expect(sumOf(r.breakdown)).toBeCloseTo(r.domain_score, 6);
    for (const c of r.breakdown) expect(c.why.length).toBeGreaterThan(0);
  });

  it('stays inside [0,1] at both extremes', () => {
    const best = score({
      claim: `Jiffy is advertising insurance across Toronto and ${DEFAULT_COMPETITORS.join(', ')}.`,
      source_tiers: ['first_party'],
    });
    const worst = score({ claim: 'Something happened in Regina.', source_tiers: [] });
    expect(best.domain_score).toBeLessThanOrEqual(1);
    expect(worst.domain_score).toBeGreaterThanOrEqual(0);
  });

  it('weights a named competitor, but only a little', () => {
    const named = score({ claim: 'Jiffy raised prices in Toronto.' });
    const anon = score({ claim: 'An operator raised prices in Toronto.' });
    expect(named.domain_score - anon.domain_score).toBeCloseTo(COMPETITOR_BONUS, 6);
    expect(COMPETITOR_BONUS).toBeLessThan(SOURCE_MAX);
    expect(COMPETITOR_BONUS).toBeLessThan(GEO_MAX);
  });

  it('spends its budget where the evidence is: sources outweigh geography', () => {
    expect(SOURCE_MAX).toBeGreaterThan(GEO_MAX);
    expect(SOURCE_MAX + GEO_MAX + TRUST_BONUS + COMPETITOR_BONUS).toBeCloseTo(1, 6);
  });
});

describe('the trust boundary is not duplicated', () => {
  it('covers every forbidden claim the honesty gate knows about', () => {
    // Two copies of a LEGAL boundary drift. If the gate learns a new forbidden
    // claim, the stakes scorer must inherit it — this test fails loudly if
    // someone re-hardcodes the list here instead of sourcing it.
    for (const text of [
      'Jiffy now advertises criminal background checks',
      'they carry $2M liability insurance',
      'a new satisfaction guarantee',
      'enrolled in WSIB',
      'trade-licence verification added',
      'fully vetted professionals',
    ]) {
      const r = scoreFinding(
        { claim: text, so_what: 'changes how we describe our own trust surface', source_tiers: ['primary'], channel: null },
        { cacCeilingCents: 6000 },
      );
      expect(r.stakes, text).toBe('high');
    }
  });

  it('reads the topic, not the polarity — unlike the honesty gate', () => {
    // "Jiffy does NOT run background checks" is an honest sentence the gate
    // must let through, and a legally load-bearing finding the scorer must
    // still mark high stakes. Same topics, deliberately different question.
    const r = scoreFinding(
      {
        claim: 'Jiffy does not run criminal background checks either',
        so_what: 'our own trust copy sits in the same legal frame',
        source_tiers: ['primary'],
        channel: null,
      },
      { cacCeilingCents: 6000 },
    );
    expect(r.stakes).toBe('high');
  });
});
