/**
 * THE RETRIEVAL LEDGER — what this run can prove it fetched.
 *
 * L0 refuses a claim that cites a URL the run never retrieved. That check is
 * what makes a fabricated source impossible, and it is the last one that should
 * ever be relaxed. It was being handed `[t.url]` — the page, unconditionally,
 * whether or not the page read, and never the sitemap.
 *
 * So the one instrument in this system with no model in it produced the exact
 * output it was built for and could not ship it. Live run, 2026-08-30:
 *
 *   ! sitemap_service_catalogue  ac-tune-up,appliance-install,… → …
 *       ✗ refuted at l0: cited a URL that was never retrieved this run:
 *         https://jiffyondemand.com/sitemap.xml
 *
 * The sitemap WAS retrieved, through the same transport and the same robots
 * gate as the page, one function call earlier. Nothing told L0. A gate that
 * refuses a document we actually read teaches an operator that its refusals are
 * noise, which is the way a fabrication check dies.
 *
 * The ledger is built from what came back, not from what was configured: a page
 * that failed to read is not in it, which is strictly stricter than the
 * `[t.url]` it replaces.
 */
import { describe, expect, it } from 'vitest';

import { assertL0 } from '@tmos/reason';

import { catalogueClaim } from './catalogue-finding.js';
import { quoteSlugs, readSitemap } from './sitemap.js';
import { retrievalLedger } from './watch.js';

const PAGE = 'https://jiffyondemand.com/';
const SITEMAP = 'https://jiffyondemand.com/sitemap.xml';

describe('retrievalLedger', () => {
  it('holds the sitemap, which is a document this run read', () => {
    expect(retrievalLedger({ pageUrl: PAGE, pageRead: true, sitemapUrl: SITEMAP })).toEqual([
      PAGE,
      SITEMAP,
    ]);
  });

  it('omits a page that did not read — we cannot cite what did not come back', () => {
    // Jiffy's homepage flattened to 29 characters for a week. Listing it as
    // retrieved would let a claim cite a document nobody has.
    expect(retrievalLedger({ pageUrl: PAGE, pageRead: false, sitemapUrl: SITEMAP })).toEqual([
      SITEMAP,
    ]);
  });

  it('omits a sitemap the target does not publish', () => {
    expect(retrievalLedger({ pageUrl: PAGE, pageRead: true, sitemapUrl: null })).toEqual([PAGE]);
  });
});

/* ── the failure this exists to prevent, end to end ───────────────────────── */

const xml = (slugs: readonly string[]): string =>
  `<urlset>${slugs.map((s) => `<url><loc>https://jiffyondemand.com/service/${s}</loc></url>`).join('')}</urlset>`;

const reading = (slugs: readonly string[]) =>
  readSitemap(xml(slugs), 'https://jiffyondemand.com/service/', {
    sourceUrl: SITEMAP,
    observedAt: '2026-08-30T05:45:00.000Z',
  });

describe('a catalogue change, through the real L0', () => {
  const before = reading(['ac-tune-up', 'appliance-install']);
  const after = reading(['ac-tune-up', 'air-conditioning-ventilation', 'appliance-install']);

  const claim = catalogueClaim('Jiffy', before.catalogue, after.catalogue);
  const evidence = [
    {
      signal_id: null,
      fact_id: null,
      source_url: after.sourceUrl,
      span: quoteSlugs(after.urls, claim?.cited ?? []),
      observed_at: after.observedAt,
    },
  ];

  it('names the service that appeared, and cites the line it appeared on', () => {
    expect(claim?.claim).toBe("Jiffy's sitemap now lists air-conditioning-ventilation.");
    expect(evidence[0]!.span).toContain('air-conditioning-ventilation');
  });

  it('was refuted by the old ledger, which knew only about the page', () => {
    const res = assertL0({ claim: claim!.claim, evidence, retrievedUrls: [PAGE] });
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.code)).toContain('url_not_retrieved');
  });

  it('passes with the ledger built from what was actually fetched', () => {
    const res = assertL0({
      claim: claim!.claim,
      evidence,
      retrievedUrls: retrievalLedger({ pageUrl: PAGE, pageRead: false, sitemapUrl: SITEMAP }),
    });
    expect(res).toEqual({ ok: true, violations: [] });
  });

  it('still refuses a sitemap URL that was never fetched', () => {
    // The gate has to keep working. A target with no sitemap read cannot cite
    // one, and this is the case that proves the fix is not a blanket allow.
    const res = assertL0({
      claim: claim!.claim,
      evidence,
      retrievedUrls: retrievalLedger({ pageUrl: PAGE, pageRead: true, sitemapUrl: null }),
    });
    expect(res.ok).toBe(false);
  });
});
