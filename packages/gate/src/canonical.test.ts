import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, urlHash, registrableDomain } from './canonical.js';

describe('canonical URL — the cheapest dedup in the pipeline', () => {
  it('collapses tracking-parameter variants to ONE identity', () => {
    const variants = [
      'https://example.com/post?utm_source=twitter&utm_medium=social',
      'http://www.example.com/post/',
      'https://example.com/post#section-2',
      'https://EXAMPLE.com/post?fbclid=abc123',
      'https://example.com/post?gclid=xyz&mc_cid=1',
    ];
    const canon = variants.map((v) => canonicalizeUrl(v));
    expect(new Set(canon).size).toBe(1);
    expect(canon[0]).toBe('https://example.com/post');
  });

  it('KEEPS meaningful query params and sorts them for stability', () => {
    const a = canonicalizeUrl('https://example.com/search?q=cleaning&page=2');
    const b = canonicalizeUrl('https://example.com/search?page=2&q=cleaning');
    expect(a).toBe(b);
    expect(a).toContain('q=cleaning');
    expect(a).toContain('page=2');
  });

  it('does not merge genuinely different pages', () => {
    expect(canonicalizeUrl('https://example.com/a')).not.toBe(
      canonicalizeUrl('https://example.com/b'),
    );
    expect(canonicalizeUrl('https://example.com/s?q=x')).not.toBe(
      canonicalizeUrl('https://example.com/s?q=y'),
    );
  });

  it('lets a declared rel=canonical win — the site owns its own identity', () => {
    const got = canonicalizeUrl('https://example.com/post?utm_source=x', {
      declaredCanonical: 'https://example.com/the-real-post',
    });
    expect(got).toBe('https://example.com/the-real-post');
  });

  it('rejects unparseable and non-http schemes', () => {
    expect(canonicalizeUrl('not a url')).toBeNull();
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('ftp://example.com/f')).toBeNull();
  });

  it('hashes deterministically and distinctly', () => {
    const a = urlHash(canonicalizeUrl('https://example.com/a')!);
    expect(a).toBe(urlHash(canonicalizeUrl('https://example.com/a?utm_source=q')!));
    expect(a).not.toBe(urlHash(canonicalizeUrl('https://example.com/b')!));
    expect(a).toHaveLength(32);
  });
});

describe('registrable domain — the hard identity key for entity resolution', () => {
  it('reduces subdomains to the registrable domain', () => {
    expect(registrableDomain('https://blog.jiffyondemand.com/post')).toBe('jiffyondemand.com');
    expect(registrableDomain('https://www.jiffyondemand.com')).toBe('jiffyondemand.com');
    expect(registrableDomain('https://jiffyondemand.com')).toBe('jiffyondemand.com');
  });

  it('handles two-part public suffixes rather than truncating them', () => {
    expect(registrableDomain('https://shop.example.co.uk/x')).toBe('example.co.uk');
    expect(registrableDomain('https://news.example.com.au')).toBe('example.com.au');
    expect(registrableDomain('https://a.example.co.in')).toBe('example.co.in');
  });

  it('returns null on garbage rather than guessing', () => {
    expect(registrableDomain('nonsense')).toBeNull();
  });
});
