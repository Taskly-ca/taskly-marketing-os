import { describe, it, expect } from 'vitest';
import { createRssCollector } from './rss.js';
import type { CollectorContext, CollectResult, FetchTextResult } from './types.js';

/* ── fixtures ───────────────────────────────────────────────────────────────
 * Inline strings only. No network, no filesystem, no fixtures directory. */

const RSS_2_0 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>GTA Home Services Weekly</title>
    <link>https://example.ca/feed</link>
    <item>
      <title>Toronto handyman rates rise 8% &amp; demand climbs</title>
      <link>https://example.ca/posts/rates-rise</link>
      <guid isPermaLink="false">post-1041</guid>
      <pubDate>Sat, 02 Aug 2026 14:05:00 GMT</pubDate>
      <description><![CDATA[<p>Contractors in Etobicoke report longer lead times.
      Reach Dave at dave@example.ca or 416-555-0134.</p>]]></description>
    </item>
    <item>
      <title>Snow removal contracts open early</title>
      <link>https://example.ca/posts/snow</link>
      <guid isPermaLink="true">https://example.ca/posts/snow</guid>
      <pubDate>Fri, 01 Aug 2026 09:00:00 GMT</pubDate>
      <description>Bookings for &quot;winter 2026&quot; opened in July.</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Taskly Blog</title>
  <entry>
    <id>tag:example.ca,2026:entry-7</id>
    <title type="text">Why GTA posters cancel</title>
    <link rel="edit" href="https://example.ca/edit/7"/>
    <link rel="alternate" type="text/html" href="https://example.ca/blog/cancel"/>
    <published>2026-08-01T11:30:00Z</published>
    <updated>2026-08-02T08:00:00Z</updated>
    <summary>Ping @someguy for the raw numbers.</summary>
  </entry>
</feed>`;

const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Quiet feed</title><link>https://example.ca/</link></channel></rss>`;

/** What a CDN actually returns when the origin is down — HTTP 200, not a feed. */
const HTML_ERROR_PAGE = `<html><head><title>502 Bad Gateway</title></head>
<body><h1>502 Bad Gateway</h1></body></html>`;

/** A response cut off mid-stream: item opened, never closed. */
const TRUNCATED = `<rss version="2.0"><channel><item><title>Half an it`;

const FEED_URL = 'https://example.ca/feed.xml';

/* ── harness ────────────────────────────────────────────────────────────── */

type Call = { url: string; headers: Record<string, string> | undefined };

function makeCtx(
  responder: FetchTextResult | (() => Promise<FetchTextResult>),
  extra: Partial<CollectorContext> = {},
) {
  const calls: Call[] = [];
  const ctx: CollectorContext = {
    fetchText: async (url, headers) => {
      calls.push({ url, headers });
      return typeof responder === 'function' ? await responder() : responder;
    },
    now: () => new Date('2026-08-03T12:00:00Z'),
    ...extra,
  };
  return { ctx, calls };
}

const res = (body: string, status = 200, headers: Record<string, string> = {}): FetchTextResult =>
  ({ status, body, headers }) satisfies FetchTextResult;

function expectOk(r: CollectResult): Extract<CollectResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.detail}`);
  return r;
}

function expectFail(r: CollectResult): Extract<CollectResult, { ok: false }> {
  if (r.ok) throw new Error(`expected failure, got ${r.items.length} items`);
  return r;
}

/* ── tests ──────────────────────────────────────────────────────────────── */

describe('rss collector — happy path', () => {
  it('parses RSS 2.0 items with guid, link, title, body and date', async () => {
    const c = createRssCollector(FEED_URL, 'GTA Weekly');
    const { ctx, calls } = makeCtx(res(RSS_2_0, 200, { ETag: 'W/"abc123"' }));
    const r = expectOk(await c.collect(ctx));

    expect(c.kind).toBe('rss');
    expect(c.name).toBe('GTA Weekly');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(FEED_URL);
    expect(r.items).toHaveLength(2);

    const first = r.items[0]!;
    expect(first.externalId).toBe('post-1041');
    expect(first.url).toBe('https://example.ca/posts/rates-rise');
    expect(first.title).toBe('Toronto handyman rates rise 8% & demand climbs');
    expect(first.body).toContain('Contractors in Etobicoke');
    expect(first.publishedAt).toBe('2026-08-02T14:05:00.000Z');
    expect(first.meta.format).toBe('rss');
    expect(first.meta.feedUrl).toBe(FEED_URL);

    // CDATA unwrapped, HTML stripped, entities decoded.
    expect(first.body).not.toContain('CDATA');
    expect(first.body).not.toContain('<p>');
    expect(r.items[1]!.body).toBe('Bookings for "winter 2026" opened in July.');

    // ETag surfaces so the next run can ask conditionally.
    expect(r.etag).toBe('W/"abc123"');
    expect(r.notModified).toBeUndefined();
  });

  it('parses Atom entries, preferring rel="alternate" and <published>', async () => {
    const c = createRssCollector(FEED_URL);
    const { ctx } = makeCtx(res(ATOM));
    const r = expectOk(await c.collect(ctx));

    expect(r.items).toHaveLength(1);
    const e = r.items[0]!;
    expect(e.externalId).toBe('tag:example.ca,2026:entry-7');
    expect(e.url).toBe('https://example.ca/blog/cancel');
    expect(e.title).toBe('Why GTA posters cancel');
    expect(e.publishedAt).toBe('2026-08-01T11:30:00.000Z');
    expect(e.meta.format).toBe('atom');
  });

  it('sends the bot User-Agent and If-None-Match when a prior etag exists', async () => {
    const c = createRssCollector(FEED_URL);
    const { ctx, calls } = makeCtx(res(RSS_2_0), { etag: 'W/"prev"' });
    await c.collect(ctx);

    const headers = calls[0]!.headers ?? {};
    expect(headers['If-None-Match']).toBe('W/"prev"');
    expect(headers['User-Agent']).toContain('TasklyBot');
  });

  it('omits If-None-Match when there is no prior etag', async () => {
    const c = createRssCollector(FEED_URL);
    const { ctx, calls } = makeCtx(res(RSS_2_0));
    await c.collect(ctx);
    expect(calls[0]!.headers?.['If-None-Match']).toBeUndefined();
  });
});

describe('rss collector — quiet vs broken must be distinguishable', () => {
  it('a valid feed with zero items is ok:true with an empty array', async () => {
    const c = createRssCollector(FEED_URL);
    const { ctx } = makeCtx(res(EMPTY_FEED));
    const r = expectOk(await c.collect(ctx));
    expect(r.items).toEqual([]);
    expect(r.notModified).toBeUndefined();
  });

  it('an HTML error page served as 200 is a parse failure, NOT an empty feed', async () => {
    const c = createRssCollector(FEED_URL);
    const { ctx } = makeCtx(res(HTML_ERROR_PAGE));
    const r = expectFail(await c.collect(ctx));
    expect(r.reason).toBe('parse');
    expect(r.detail).toBeTruthy();
  });

  it('a truncated feed is a parse failure, not an empty feed', async () => {
    const c = createRssCollector(FEED_URL);
    const { ctx } = makeCtx(res(TRUNCATED));
    expect(expectFail(await c.collect(ctx)).reason).toBe('parse');
  });
});

describe('rss collector — transport', () => {
  it('returns notModified() on HTTP 304 with zero items', async () => {
    const c = createRssCollector(FEED_URL);
    const { ctx } = makeCtx(res('', 304), { etag: 'W/"prev"' });
    const r = expectOk(await c.collect(ctx));
    expect(r.notModified).toBe(true);
    expect(r.items).toEqual([]);
    expect(r.etag).toBe('W/"prev"');
  });

  it('maps 429 to rate_limited (retryable) and 403 to auth (not retryable)', async () => {
    const c = createRssCollector(FEED_URL);
    const limited = expectFail(await c.collect(makeCtx(res('', 429)).ctx));
    expect(limited.reason).toBe('rate_limited');
    expect(limited.retryable).toBe(true);

    const forbidden = expectFail(await c.collect(makeCtx(res('', 403)).ctx));
    expect(forbidden.reason).toBe('auth');
    expect(forbidden.retryable).toBe(false);
  });

  it('maps other non-2xx and thrown transport errors to network', async () => {
    const c = createRssCollector(FEED_URL);
    expect(expectFail(await c.collect(makeCtx(res('', 500)).ctx)).reason).toBe('network');

    const { ctx } = makeCtx(() => Promise.reject(new Error('ECONNRESET')));
    const thrown = expectFail(await c.collect(ctx));
    expect(thrown.reason).toBe('network');
    expect(thrown.detail).toContain('ECONNRESET');
  });
});

describe('rss collector — policy', () => {
  it('refuses a banned host before any fetch happens', async () => {
    const c = createRssCollector('https://www.linkedin.com/feed/rss', 'LinkedIn');
    const { ctx, calls } = makeCtx(res(RSS_2_0));
    const r = expectFail(await c.collect(ctx));
    expect(r.reason).toBe('blocked_by_policy');
    expect(r.retryable).toBe(false);
    expect(r.detail).toContain('linkedin.com');
    expect(calls).toHaveLength(0);
  });

  it('strips emails, phone numbers and @handles from item bodies', async () => {
    const c = createRssCollector(FEED_URL);
    const r = expectOk(await c.collect(makeCtx(res(RSS_2_0)).ctx));
    const body = r.items[0]!.body;
    expect(body).toContain('[email]');
    expect(body).toContain('[phone]');
    expect(body).not.toContain('dave@example.ca');
    expect(body).not.toContain('416-555-0134');

    const atom = expectOk(await c.collect(makeCtx(res(ATOM)).ctx));
    expect(atom.items[0]!.body).toContain('[handle]');
    expect(atom.items[0]!.body).not.toContain('@someguy');
  });

  it('is not configured without a feed url, and fails cleanly rather than fetching', async () => {
    const c = createRssCollector('  ');
    expect(c.isConfigured({})).toBe(false);
    const { ctx, calls } = makeCtx(res(RSS_2_0));
    const r = expectFail(await c.collect(ctx));
    expect(r.reason).toBe('not_configured');
    expect(r.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('is configured with a feed url and needs no credential', () => {
    expect(createRssCollector(FEED_URL).isConfigured({})).toBe(true);
  });
});
