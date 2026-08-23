/**
 * A COMPETITOR'S SITEMAP — the first instrument with no model in it.
 *
 * Two problems, one answer.
 *
 * The first is Jiffy. `jiffyondemand.com` flattens to **29 characters** of
 * text: the page is assembled in the browser, so one of three watched
 * competitors has contributed nothing since the watch was built, silently, as a
 * line reading "too little text to read".
 *
 * The second is `service_categories_count`, which had to be demoted to a
 * recording-only measure after it reported a change that was the extractor
 * choosing a wider span. Asking a model to count things on a marketing page is
 * asking it to compose a number, and composed numbers drift.
 *
 * `sitemap.xml` answers both. It is first-party, server-rendered, published
 * deliberately for machines, and Jiffy's lists **every service they sell** as a
 * URL. Counting `<loc>` entries under `/service/` is not an extraction — there
 * is no model, no span to choose and no judgement to drift. Run it twice on an
 * unchanged sitemap and it returns the same answer, which is the property the
 * count measure never had.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO YET is mint a Finding, and the reason is
 * L0 rather than caution. The claim template renders the observed value —
 * "…count is now 61" — and L0 requires every number in a claim to appear
 * verbatim in a cited span. A count derived from a document has no span
 * containing it, so the honest change-Finding for a sitemap is a different
 * sentence: "Jiffy's sitemap now lists junk-removal and mold-remediation, which
 * it did not list before", whose values ARE in the span. That needs a
 * purpose-built claim rather than T2's generic template, and it is the next
 * step. Recording starts now because the first run is a baseline either way —
 * a change detector needs a before, and there is no cost to having one early.
 */

/** `<loc>` is the only element carrying a URL in the sitemap protocol. */
const LOC = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;

/**
 * Every URL in a sitemap, in document order, undeduplicated.
 *
 * Deliberately a regex and not an XML parser: the input is one element type
 * from a schema that has not changed since 2005, and a parser would add a
 * dependency that can fail on a namespace declaration this does not care about.
 * A malformed document yields fewer URLs, never an exception — a competitor's
 * bad XML must not take a run down.
 */
export function extractLocs(xml: string): string[] {
  return [...xml.matchAll(LOC)].map((m) => decodeEntities(m[1] ?? ''));
}

/** The five XML predefined entities. `&amp;` is the one that actually appears. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The service slugs under `prefix`, deduplicated and sorted, each mapped to the
 * URL it was read from — VERBATIM, so a citation quotes the document rather
 * than a string we rebuilt from a slug and a prefix. Reconstructing the line
 * would look identical and would not be evidence.
 *
 * SORTED IS NOT COSMETIC. The value is compared against the last run to decide
 * whether anything changed, so a sitemap that reorders itself — and generated
 * ones do, on every deploy — would otherwise read as a change in the catalogue.
 * Sorting is what makes the instrument insensitive to everything except which
 * services exist.
 *
 * A trailing slash and a query string are stripped for the same reason.
 */
function serviceUrls(
  locs: readonly string[],
  prefix: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const loc of locs) {
    const at = loc.indexOf(prefix);
    if (at === -1) continue;
    const slug = loc
      .slice(at + prefix.length)
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .trim();
    // Nothing after the prefix is the index page, not a service; a further
    // slash is a child page of one we have already counted.
    if (slug === '' || slug.includes('/')) continue;
    const key = slug.toLowerCase();
    if (!out.has(key)) out.set(key, loc);
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function serviceSlugs(locs: readonly string[], prefix: string): string[] {
  return [...serviceUrls(locs, prefix).keys()];
}

export interface SitemapReading {
  /** The document this reading came from — the URL a citation points at. */
  readonly sourceUrl: string;
  /** When it was read. Carried so a citation is not stamped by its consumer. */
  readonly observedAt: string;
  readonly slugs: readonly string[];
  /** slug → the URL as the document wrote it. The citation for that slug. */
  readonly urls: ReadonlyMap<string, string>;
  /** Deterministic: the same document always yields the same number. */
  readonly count: number;
  /** The comparable value — sorted, comma-joined, insensitive to ordering. */
  readonly catalogue: string;
  /**
   * The evidence. The `<loc>` lines the reading was taken from, verbatim, so a
   * reader can check any slug against the document it came from — which is the
   * whole difference between a sourced fact and a plausible one.
   */
  readonly span: string;
}

/** How many `<loc>` lines to quote. The whole sitemap is not evidence, it is
 *  the source; a citation a human will not read is not a citation. */
const SPAN_LINES = 12;

export function readSitemap(
  xml: string,
  prefix: string,
  at: { sourceUrl: string; observedAt: string },
): SitemapReading {
  const urls = serviceUrls(extractLocs(xml), prefix);
  const slugs = [...urls.keys()];
  return {
    sourceUrl: at.sourceUrl,
    observedAt: at.observedAt,
    slugs,
    urls,
    count: slugs.length,
    catalogue: slugs.join(','),
    span: quoteSlugs(urls, slugs.slice(0, SPAN_LINES)),
  };
}

/**
 * The evidence for a specific set of slugs.
 *
 * A change-Finding names the services that appeared, so the span it cites must
 * contain THOSE URLs — not the first twelve in the document, which is what a
 * general-purpose span would give it and which would leave the named services
 * uncited. A slug with no URL is dropped rather than invented.
 */
export function quoteSlugs(
  urls: ReadonlyMap<string, string>,
  slugs: readonly string[],
): string {
  return slugs
    .map((s) => urls.get(s))
    .filter((u): u is string => u !== undefined)
    .map((u) => `<loc>${u}</loc>`)
    .join(' ');
}
