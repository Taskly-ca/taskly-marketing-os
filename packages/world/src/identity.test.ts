import { describe, it, expect } from 'vitest';
import {
  domainKey,
  socialKey,
  normalizeName,
  identityVerdict,
  mayFuzzyMatch,
  isPlatformHost,
  MIN_FUZZY_LENGTH,
} from './identity.js';

describe('hard keys auto-merge without scoring', () => {
  it('reduces any URL on a company site to one domain key', () => {
    const a = domainKey('https://www.jiffyondemand.com/services?utm_source=x');
    const b = domainKey('http://blog.jiffyondemand.com/post/1');
    expect(a).toEqual({ kind: 'domain', valueNorm: 'jiffyondemand.com' });
    expect(a).toEqual(b);
  });

  it('REFUSES a domain key on a platform host', () => {
    // Otherwise every business with a Facebook page merges into one entity
    // whose hard key is facebook.com — a single index collision silently
    // fusing an entire market. There is no review step to catch it, because
    // hard keys are the path that skips review.
    for (const url of [
      'https://www.facebook.com/some-cleaner',
      'https://sites.google.com/view/handyman',
      'https://mystore.myshopify.com',
      'https://someone.github.io',
    ]) {
      expect(domainKey(url)).toBeNull();
    }
    expect(isPlatformHost('facebook.com')).toBe(true);
    expect(isPlatformHost('jiffyondemand.com')).toBe(false);
  });

  it('normalizes handles from any of the forms a source hands us', () => {
    const want = { kind: 'social', valueNorm: 'instagram:tasklyca' };
    expect(socialKey('Instagram', '@TasklyCA')).toEqual(want);
    expect(socialKey('instagram', 'tasklyca')).toEqual(want);
    expect(socialKey('instagram', 'https://instagram.com/tasklyca/')).toEqual(want);
    expect(socialKey('instagram', 'https://instagram.com/tasklyca?hl=en')).toEqual(want);
  });

  it('rejects a handle that is not one', () => {
    expect(socialKey('instagram', '')).toBeNull();
    expect(socialKey('instagram', 'a')).toBeNull();
    expect(socialKey('', 'tasklyca')).toBeNull();
  });
});

describe('name normalization', () => {
  it('strips legal suffixes, including stacked ones', () => {
    expect(normalizeName('Jiffy On Demand Inc.').norm).toBe('jiffy on demand');
    expect(normalizeName('Acme Holdings Ltd').norm).toBe('acme');
    expect(normalizeName('Handy Services Pvt Ltd').norm).toBe('handy services');
  });

  it('folds case, accents and spacing', () => {
    expect(normalizeName('  Café  Ménage  ').norm).toBe('cafe menage');
  });

  it('never strips a name down to nothing', () => {
    // "Limited" alone is a company called Limited, not an empty string.
    expect(normalizeName('Limited').norm).toBe('limited');
    expect(normalizeName('The').norm).toBe('the');
  });
});

describe('the two name traps', () => {
  it('protects brands whose punctuation or wording is load-bearing', () => {
    for (const brand of ['AT&T', '3M', 'E*TRADE', 'eBay', 'The Gap']) {
      const n = normalizeName(brand);
      expect(n.exactOnly).toBe(true);
      expect(n.reason).toBe('protected_brand');
    }
  });

  it('refuses to fuzzy-match any short name', () => {
    // pg_trgm on a 2-char string produces a handful of padded trigrams, so its
    // similarity to unrelated short strings is both high and unstable.
    const n = normalizeName('Zap');
    expect(n.norm.length).toBeLessThan(MIN_FUZZY_LENGTH);
    expect(n.exactOnly).toBe(true);
    expect(n.reason).toBe('too_short');
  });

  it('lets ordinary names through to scoring', () => {
    const a = normalizeName('Jiffy On Demand Inc.');
    const b = normalizeName('Jiffy OnDemand');
    expect(a.exactOnly).toBe(false);
    expect(mayFuzzyMatch(a, b)).toBe(true);
  });
});

describe('identityVerdict — what happens BEFORE any score', () => {
  const named = (name: string, keys: Parameters<typeof identityVerdict>[0]['keys'] = []) => ({
    keys,
    name: normalizeName(name),
  });

  it('merges on a shared hard key regardless of the names', () => {
    const v = identityVerdict(
      named('Jiffy', [{ kind: 'domain', valueNorm: 'jiffyondemand.com' }]),
      named('Totally Different Brand', [{ kind: 'domain', valueNorm: 'jiffyondemand.com' }]),
    );
    expect(v).toEqual({
      decision: 'merge',
      via: 'hard_key',
      key: { kind: 'domain', valueNorm: 'jiffyondemand.com' },
    });
  });

  it('merges two protected brands only on an exact match', () => {
    expect(identityVerdict(named('AT&T'), named('AT&T')).decision).toBe('merge');
    expect(identityVerdict(named('AT&T'), named('ATT Corp')).decision).toBe('reject');
  });

  it('never sends a protected or short name to the scorer', () => {
    const v = identityVerdict(named('3M'), named('3M Innovations'));
    expect(v.decision).toBe('reject');
    if (v.decision === 'reject') expect(v.reason).toMatch(/protected_brand|too_short/);
  });

  it('sends ordinary names to the scorer rather than deciding', () => {
    expect(identityVerdict(named('Jiffy On Demand'), named('Jiffy OnDemand Inc')).decision).toBe(
      'score',
    );
  });

  it('does not merge two entities that merely share a platform URL', () => {
    // The platform-host guard means neither side has a domain key at all, so
    // the pair falls through to scoring instead of auto-merging.
    const a = named('Alice Cleaning', [socialKey('facebook', 'alicecleaning')!]);
    const b = named('Bob Cleaning', [socialKey('facebook', 'bobcleaning')!]);
    expect(identityVerdict(a, b).decision).toBe('score');
  });
});
