/**
 * The catalogue claim.
 *
 * Three properties matter and each has already failed somewhere else in this
 * system: a claim must name only what its span can cite, a reordering must
 * produce silence, and a number in a claim must be one L0 will not demand
 * verbatim.
 */
import { describe, expect, it } from 'vitest';
import { assertL0 } from '@tmos/reason';

import { NAMED_LIMIT, catalogueClaim, diffCatalogues, list } from './catalogue-finding.js';
import { quoteSlugs } from './sitemap.js';

const BEFORE = 'appliance-repair,handyman,plumbing,tv-mounting';

describe('diffCatalogues', () => {
  it('reports both directions', () => {
    expect(diffCatalogues(BEFORE, 'handyman,junk-removal,plumbing,tv-mounting')).toEqual({
      added: ['junk-removal'],
      removed: ['appliance-repair'],
    });
  });

  it('sees no change in a reordered catalogue', () => {
    // A generated sitemap reshuffles on every deploy. The set is the catalogue;
    // the string is only how it was stored.
    expect(diffCatalogues(BEFORE, 'tv-mounting,plumbing,handyman,appliance-repair')).toEqual({
      added: [],
      removed: [],
    });
  });

  it('treats an empty prior as everything being new', () => {
    expect(diffCatalogues('', 'plumbing').added).toEqual(['plumbing']);
  });
});

describe('list', () => {
  it('reads as a sentence', () => {
    expect(list(['a'])).toBe('a');
    expect(list(['a', 'b'])).toBe('a and b');
    expect(list(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('catalogueClaim', () => {
  it('says nothing when the catalogue did not change', () => {
    expect(catalogueClaim('Jiffy', BEFORE, 'plumbing,handyman,tv-mounting,appliance-repair')).toBeNull();
  });

  it('names what appeared, and cites exactly what it names', () => {
    const c = catalogueClaim('Jiffy', BEFORE, `${BEFORE},junk-removal,mold-remediation`);
    expect(c).not.toBeNull();
    expect(c?.claim).toBe(
      "Jiffy's sitemap now lists junk-removal and mold-remediation.",
    );
    expect(c?.cited).toEqual(['junk-removal', 'mold-remediation']);
  });

  it('leads with a removal, because nobody announces a retreat', () => {
    const c = catalogueClaim('Jiffy', BEFORE, 'handyman,junk-removal,plumbing,tv-mounting');
    expect(c?.claim).toMatch(/^Jiffy's sitemap no longer lists appliance-repair, and now lists junk-removal\./);
    expect(c?.cited).toEqual(['appliance-repair', 'junk-removal']);
  });

  it('says what to do about it, in both directions', () => {
    const c = catalogueClaim('Jiffy', BEFORE, 'handyman,junk-removal,plumbing,tv-mounting');
    expect(c?.so_what).toMatch(/left their catalogue/);
    expect(c?.so_what).toMatch(/our taxonomy/);
  });

  it('stops naming past the limit and counts the rest without a countable number', () => {
    const many = Array.from({ length: NAMED_LIMIT + 3 }, (_, i) => `svc-${String.fromCharCode(97 + i)}`);
    const c = catalogueClaim('Jiffy', BEFORE, `${BEFORE},${many.join(',')}`);

    expect(c?.cited).toHaveLength(NAMED_LIMIT);
    // Not "among 3 other changes": BARE_INTEGER_FLOOR is 10 today, and a claim
    // whose wording only survives L0 while a constant stays put is a claim
    // waiting to break. The word costs nothing.
    expect(c?.claim).toMatch(/among other changes\.$/);
  });

  /**
   * THE INVARIANT THIS WHOLE FILE EXISTS FOR: a catalogue claim passes L0
   * against the span built from the slugs it names. Driven through the real
   * gate rather than approximated, and with slugs that carry digits — real ones
   * do (`24-7-plumbing`), and a digit in a claim is exactly what L0 demands
   * from the span.
   */
  it('passes L0 against the span built from the slugs it names', () => {
    const prefix = 'https://jiffyondemand.com/service/';
    const next = `${BEFORE},24-7-plumbing,junk-removal,mold-remediation`;
    const c = catalogueClaim('Jiffy', BEFORE, next);
    expect(c).not.toBeNull();

    const urls = new Map(
      next.split(',').map((slug) => [slug, `${prefix}${slug}`] as const),
    );
    const span = quoteSlugs(urls, c?.cited ?? []);

    const l0 = assertL0({
      claim: c?.claim ?? '',
      evidence: [
        {
          signal_id: null,
          fact_id: null,
          source_url: `${prefix.slice(0, -9)}sitemap.xml`,
          span,
          observed_at: '2026-08-23T00:00:00.000Z',
        },
      ],
      retrievedUrls: [`${prefix.slice(0, -9)}sitemap.xml`],
    });

    expect(l0.ok, JSON.stringify(l0)).toBe(true);
  });
});
