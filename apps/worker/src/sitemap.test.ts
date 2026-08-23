/**
 * The sitemap reader.
 *
 * The property under test is the one the model-based count never had:
 * determinism. The same document must give the same answer, and a document that
 * differs only in ORDER must give the same answer too — generated sitemaps
 * reshuffle on every deploy, and a catalogue that reads as changed on a
 * reordering is the drifting instrument again in a new costume.
 */
import { describe, expect, it } from 'vitest';

import { extractLocs, readSitemap, serviceSlugs } from './sitemap.js';

const PREFIX = 'https://jiffyondemand.com/service/';
const AT = {
  sourceUrl: 'https://jiffyondemand.com/sitemap.xml',
  observedAt: '2026-08-23T00:00:00.000Z',
};

const xml = (paths: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url>\n    <loc>${p}</loc>\n    <changefreq>weekly</changefreq>\n  </url>`).join('\n')}
</urlset>`;

const SITEMAP = xml([
  'https://jiffyondemand.com/about_us',
  'https://jiffyondemand.com/service/plumbing',
  'https://jiffyondemand.com/service/junk-removal',
  'https://jiffyondemand.com/service/tv-mounting',
  'https://jiffyondemand.com/users/sign_in',
]);

describe('extractLocs', () => {
  it('reads every URL, in document order', () => {
    expect(extractLocs(SITEMAP)).toHaveLength(5);
  });

  it('decodes the entities a real sitemap contains', () => {
    expect(extractLocs('<loc>https://x.com/a?b=1&amp;c=2</loc>')).toEqual([
      'https://x.com/a?b=1&c=2',
    ]);
  });

  it('returns fewer URLs from a malformed document, never an exception', () => {
    expect(() => extractLocs('<urlset><loc>https://x.com/a</urlset>')).not.toThrow();
    expect(extractLocs('<urlset><loc>https://x.com/a</urlset>')).toEqual([]);
  });
});

describe('serviceSlugs', () => {
  it('keeps only what is under the prefix', () => {
    expect(serviceSlugs(extractLocs(SITEMAP), PREFIX)).toEqual([
      'junk-removal',
      'plumbing',
      'tv-mounting',
    ]);
  });

  it('is insensitive to the order the sitemap lists them in', () => {
    const a = readSitemap(SITEMAP, PREFIX, AT);
    const b = readSitemap(
      xml([
        'https://jiffyondemand.com/service/tv-mounting',
        'https://jiffyondemand.com/service/plumbing',
        'https://jiffyondemand.com/service/junk-removal',
      ]),
      PREFIX,
      AT,
    );
    // A generated sitemap reshuffles on every deploy. If that read as a change,
    // the catalogue would be a drift detector rather than a change detector.
    expect(b.catalogue).toBe(a.catalogue);
  });

  it('ignores the index page and the children of a service', () => {
    const locs = [`${PREFIX}`, `${PREFIX}plumbing/toronto`, `${PREFIX}plumbing`];
    expect(serviceSlugs(locs, PREFIX)).toEqual(['plumbing']);
  });

  it('strips a query string and a trailing slash before comparing', () => {
    const locs = [`${PREFIX}plumbing/`, `${PREFIX}plumbing?utm=x`, `${PREFIX}Plumbing`];
    expect(serviceSlugs(locs, PREFIX)).toEqual(['plumbing']);
  });
});

describe('readSitemap', () => {
  const reading = readSitemap(SITEMAP, PREFIX, AT);

  it('gives the same answer for the same document', () => {
    expect(readSitemap(SITEMAP, PREFIX, AT)).toEqual(reading);
  });

  it('counts what it lists, and nothing else', () => {
    expect(reading.count).toBe(3);
    expect(reading.count).toBe(reading.slugs.length);
  });

  it('cites the lines it read, so any slug can be checked against the document', () => {
    for (const slug of reading.slugs) expect(reading.span).toContain(slug);
  });
});
