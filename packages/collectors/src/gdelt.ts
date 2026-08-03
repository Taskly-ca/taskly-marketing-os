/**
 * GDELT DOC 2.0 collector.
 *
 * Free, keyless, worldwide news coverage — the cheapest breadth we can get, and
 * the reason it is worth the quirks: GDELT answers a bad query with plain text
 * and HTTP 200, so "not json" has to read as `fail('parse')` and never as a day
 * with no news.
 *
 * artlist returns headlines and metadata, not article bodies. We take the
 * headline as the body and never follow the link — the article itself lives
 * behind someone else's terms.
 */

import { checkHost, stripPii, USER_AGENT } from './policy.js';
import { fail, notModified, ok } from './types.js';
import type { Collector, CollectorContext, CollectResult, FetchTextResult } from './types.js';
import type { RawItem } from './types.js';

const DEFAULT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const DEFAULT_MAX_RECORDS = 75;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function plainText(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
      const e = ent.toLowerCase();
      const code = e.startsWith('#x')
        ? Number.parseInt(e.slice(2), 16)
        : e.startsWith('#')
          ? Number.parseInt(e.slice(1), 10)
          : Number.NaN;
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff)
        return String.fromCodePoint(code);
      return ENTITIES[e] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** GDELT stamps `20260802T141500Z`, which `new Date()` will not parse. */
function seendateToIso(value: unknown): string | null {
  const raw = str(value).trim();
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(raw);
  const iso = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : raw;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface GdeltCollectorOptions {
  /** Overridable so the endpoint itself is policy-checked and testable. */
  endpoint?: string;
  maxRecords?: number;
}

export function createGdeltCollector(
  query: string,
  name?: string,
  opts: GdeltCollectorOptions = {},
): Collector {
  const q = query.trim();
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS;

  return {
    kind: 'gdelt',
    name: name ?? `gdelt:${q || 'unconfigured'}`,
    isConfigured: () => q.length > 0,

    async collect(ctx: CollectorContext): Promise<CollectResult> {
      if (!q) return fail('not_configured', 'no gdelt query supplied', false);

      const url =
        `${endpoint}?query=${encodeURIComponent(q)}&mode=artlist&format=json` +
        `&maxrecords=${maxRecords}&sort=datedesc`;
      const verdict = checkHost(url);
      if (!verdict.allowed) return fail('blocked_by_policy', verdict.reason, false);

      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      };
      if (ctx.etag) headers['If-None-Match'] = ctx.etag;

      let res: FetchTextResult;
      try {
        res = await ctx.fetchText(url, headers);
      } catch (err) {
        return fail('network', `fetch failed for ${endpoint}: ${messageOf(err)}`);
      }

      const etag = headerOf(res.headers, 'etag') ?? ctx.etag;
      if (res.status === 304) return notModified(etag);
      if (res.status === 429) return fail('rate_limited', 'gdelt returned 429');
      if (res.status === 401 || res.status === 403) {
        return fail('auth', `gdelt returned ${res.status}`, false);
      }
      if (res.status < 200 || res.status >= 300) {
        return fail('network', `gdelt returned HTTP ${res.status}`);
      }

      const extra = etag ? { etag } : {};

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body) as unknown;
      } catch (err) {
        return fail('parse', `gdelt response was not json: ${messageOf(err)}`);
      }
      if (!isRecord(parsed)) return fail('parse', 'gdelt response was not a json object');

      const articles = parsed.articles;
      // GDELT genuinely omits `articles` when nothing matched — that is quiet,
      // not broken. A present-but-wrong-shaped field is broken.
      if (articles === undefined || articles === null) return ok([], extra);
      if (!Array.isArray(articles)) {
        return fail('parse', 'gdelt articles field is not an array');
      }

      const items: RawItem[] = [];
      for (const raw of articles) {
        if (!isRecord(raw)) continue;
        const link = str(raw.url).trim();
        if (!link) continue;
        // Liability follows the data: we do not ingest a banned host's content
        // just because an aggregator handed it to us.
        if (!checkHost(link).allowed) continue;

        const title = stripPii(plainText(str(raw.title)));
        items.push({
          externalId: link,
          url: link,
          title: title || null,
          body: title,
          publishedAt: seendateToIso(raw.seendate),
          meta: {
            domain: str(raw.domain),
            language: str(raw.language),
            sourcecountry: str(raw.sourcecountry),
            seendate: str(raw.seendate),
          },
        });
      }

      return ok(items, extra);
    },
  };
}
