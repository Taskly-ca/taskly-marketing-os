/**
 * Generic RSS 2.0 + Atom collector.
 *
 * Parsed with string handling rather than an XML library on purpose: feeds are
 * the one format where a dependency buys us nothing (we read five fields) and
 * costs us a parser CVE surface on untrusted input.
 *
 * The load-bearing behaviour is the ok/fail split. A CDN that serves an HTML
 * error page with HTTP 200 — the single most common feed failure — must read as
 * `fail('parse')`, never as a feed that happened to have no items.
 */

import { checkHost, hostOf, stripPii, USER_AGENT } from './policy.js';
import { fail, notModified, ok } from './types.js';
import type { Collector, CollectorContext, CollectResult, FetchTextResult } from './types.js';
import type { RawItem } from './types.js';

const ITEM_RE = /<item[\s>][\s\S]*?<\/item>/gi;
const ENTRY_RE = /<entry[\s>][\s\S]*?<\/entry>/gi;
/** A document is a feed only if it opens a feed root. `<html>` is not one. */
const FEED_ROOT_RE = /<(rss|feed|rdf:rdf|channel)[\s>]/i;
const ANY_ITEM_OPEN_RE = /<(item|entry)[\s>]/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
};

function codePoint(n: number): string | null {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    const e = ent.toLowerCase();
    if (e.startsWith('#x')) return codePoint(Number.parseInt(e.slice(2), 16)) ?? whole;
    if (e.startsWith('#')) return codePoint(Number.parseInt(e.slice(1), 10)) ?? whole;
    return NAMED_ENTITIES[e] ?? whole;
  });
}

/** CDATA out, tags out, entities decoded, whitespace collapsed. */
function plainText(input: string): string {
  return decodeEntities(input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function tagContent(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  return re.exec(xml)?.[1] ?? null;
}

function tagText(xml: string, tag: string): string {
  const raw = tagContent(xml, tag);
  return raw === null ? '' : plainText(raw);
}

/** Atom links are attributes, and there are several — alternate is the article. */
function atomHref(block: string): string {
  let fallback = '';
  for (const m of block.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase();
    if (!rel || rel === 'alternate') return href;
    if (!fallback) fallback = href;
  }
  return fallback;
}

function toIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
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

function toItem(
  externalId: string,
  link: string,
  title: string,
  bodyRaw: string,
  published: string,
  meta: Record<string, unknown>,
): RawItem | null {
  const id = externalId || link || title;
  if (!id) return null;
  return {
    externalId: id,
    url: link || null,
    title: title ? stripPii(title) : null,
    body: stripPii(plainText(bodyRaw)),
    publishedAt: toIso(published),
    meta,
  };
}

function parseRssItem(block: string, feedUrl: string): RawItem | null {
  const body = tagContent(block, 'content:encoded') ?? tagContent(block, 'description') ?? '';
  return toItem(
    tagText(block, 'guid'),
    tagText(block, 'link'),
    tagText(block, 'title'),
    body,
    tagText(block, 'pubDate'),
    { feedUrl, format: 'rss' },
  );
}

function parseAtomEntry(block: string, feedUrl: string): RawItem | null {
  const body = tagContent(block, 'content') ?? tagContent(block, 'summary') ?? '';
  const published = tagText(block, 'published') || tagText(block, 'updated');
  return toItem(tagText(block, 'id'), atomHref(block), tagText(block, 'title'), body, published, {
    feedUrl,
    format: 'atom',
  });
}

export function createRssCollector(feedUrl: string, name?: string): Collector {
  const url = feedUrl.trim();
  return {
    kind: 'rss',
    name: name ?? `rss:${hostOf(url) || url || 'unconfigured'}`,
    isConfigured: () => url.length > 0,

    async collect(ctx: CollectorContext): Promise<CollectResult> {
      if (!url) return fail('not_configured', 'no feed url supplied', false);

      const verdict = checkHost(url);
      if (!verdict.allowed) return fail('blocked_by_policy', verdict.reason, false);

      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5',
      };
      if (ctx.etag) headers['If-None-Match'] = ctx.etag;

      let res: FetchTextResult;
      try {
        res = await ctx.fetchText(url, headers);
      } catch (err) {
        return fail('network', `fetch failed for ${url}: ${messageOf(err)}`);
      }

      const etag = headerOf(res.headers, 'etag') ?? ctx.etag;
      if (res.status === 304) return notModified(etag);
      if (res.status === 429) return fail('rate_limited', `${url} returned 429`);
      if (res.status === 401 || res.status === 403) {
        return fail('auth', `${url} returned ${res.status}`, false);
      }
      if (res.status < 200 || res.status >= 300) {
        return fail('network', `${url} returned HTTP ${res.status}`);
      }

      const extra = etag ? { etag } : {};
      const text = res.body;
      if (!FEED_ROOT_RE.test(text)) {
        return fail('parse', `${url} did not return a feed (no rss/feed/channel root)`);
      }

      const rssBlocks = text.match(ITEM_RE) ?? [];
      const atomBlocks = text.match(ENTRY_RE) ?? [];
      if (rssBlocks.length === 0 && atomBlocks.length === 0) {
        if (ANY_ITEM_OPEN_RE.test(text)) {
          return fail('parse', `${url} looks truncated: item/entry opened but never closed`);
        }
        return ok([], extra);
      }

      const items: RawItem[] = [];
      for (const block of rssBlocks) {
        const item = parseRssItem(block, url);
        if (item) items.push(item);
      }
      for (const block of atomBlocks) {
        const item = parseAtomEntry(block, url);
        if (item) items.push(item);
      }
      return ok(items, extra);
    },
  };
}
