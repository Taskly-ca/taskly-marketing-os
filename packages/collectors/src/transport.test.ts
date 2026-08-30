import { USER_AGENT } from '@tmos/collectors';
import { describe, expect, it } from 'vitest';

import { createTransport, type FetchImpl } from './transport.js';

interface Call {
  url: string;
  headers: Record<string, string>;
  method: string;
}

/** A fetch built from a routing table. Nothing here touches the network. */
function fakeFetch(routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, method: init.method });
    const route = routes[url] ?? { status: 404, body: 'not found' };
    const headers = route.headers ?? {};
    return {
      status: route.status,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
        forEach: (fn: (value: string, key: string) => void) => {
          for (const [k, v] of Object.entries(headers)) fn(v, k);
        },
      },
      text: async () => route.body ?? '',
    };
  };
  return { impl, calls };
}

const noSleep = async (): Promise<void> => undefined;

describe('createTransport', () => {
  it('fetches robots.txt before the resource, once per host', async () => {
    const { impl, calls } = fakeFetch({
      'https://feeds.test/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' },
      'https://feeds.test/a': { status: 200, body: '<rss/>' },
      'https://feeds.test/b': { status: 200, body: '<rss/>' },
    });
    const t = createTransport({ fetchImpl: impl, sleep: noSleep });

    await t.fetchText('https://feeds.test/a');
    await t.fetchText('https://feeds.test/b');

    expect(calls.map((c) => c.url)).toEqual([
      'https://feeds.test/robots.txt',
      'https://feeds.test/a',
      'https://feeds.test/b',
    ]);
    expect(t.requestCount()).toBe(3);
  });

  it('refuses a disallowed path — a HARD gate, and the bytes never move', async () => {
    const { impl, calls } = fakeFetch({
      'https://trade.test/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /feed/' },
      'https://trade.test/feed/': { status: 200, body: '<rss/>' },
    });
    const t = createTransport({ fetchImpl: impl, sleep: noSleep });

    await expect(t.fetchText('https://trade.test/feed/')).rejects.toThrow(/disallows/);
    expect(calls.map((c) => c.url)).toEqual(['https://trade.test/robots.txt']);
    expect(t.drainDenials()).toEqual([expect.stringContaining('robots.txt disallows /feed/')]);
    // Draining clears, so the next source starts with a clean slate.
    expect(t.drainDenials()).toEqual([]);
  });

  it('refuses a never-scrape host before it even asks for robots.txt', async () => {
    const { impl, calls } = fakeFetch({});
    const t = createTransport({ fetchImpl: impl, sleep: noSleep });

    await expect(t.fetchText('https://www.linkedin.com/feed')).rejects.toThrow(/never-scrape/);
    expect(calls).toEqual([]);
  });

  it('treats a 4xx robots.txt as no rules, and a 5xx as unknown-therefore-refused', async () => {
    const open = fakeFetch({
      'https://open.test/robots.txt': { status: 404 },
      'https://open.test/feed': { status: 200, body: 'ok' },
    });
    const openT = createTransport({ fetchImpl: open.impl, sleep: noSleep });
    expect((await openT.fetchText('https://open.test/feed')).status).toBe(200);

    const broken = fakeFetch({ 'https://broken.test/robots.txt': { status: 503 } });
    const brokenT = createTransport({ fetchImpl: broken.impl, sleep: noSleep });
    await expect(brokenT.fetchText('https://broken.test/feed')).rejects.toThrow(/unreadable/);
  });

  async function waitsFor(robots: string): Promise<number[]> {
    const waits: number[] = [];
    const { impl } = fakeFetch({
      'https://paced.test/robots.txt': { status: 200, body: robots },
      'https://paced.test/a': { status: 200, body: 'a' },
      'https://paced.test/b': { status: 200, body: 'b' },
    });
    let clock = 0;
    const t = createTransport({
      fetchImpl: impl,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await t.fetchText('https://paced.test/a');
    await t.fetchText('https://paced.test/b');
    return waits;
  }

  it('honours a Crawl-delay stricter than our own floor', async () => {
    // Three requests, two gaps: robots.txt → /a, then /a → /b.
    expect(await waitsFor('User-agent: *\nCrawl-delay: 30')).toEqual([30_000, 30_000]);
  });

  it('keeps our own 2s floor when theirs is laxer — self-imposed, not negotiated', async () => {
    expect(await waitsFor('User-agent: *\nCrawl-delay: 0.5')).toEqual([2_000, 2_000]);
  });

  it('uses our floor when a host declares no Crawl-delay at all', async () => {
    expect(await waitsFor('User-agent: *\nAllow: /')).toEqual([2_000, 2_000]);
  });

  it('forces the honest User-Agent even if a collector omitted it', async () => {
    const { impl, calls } = fakeFetch({
      'https://ua.test/robots.txt': { status: 404 },
      'https://ua.test/feed': { status: 200, body: 'ok' },
    });
    const t = createTransport({ fetchImpl: impl, sleep: noSleep });
    await t.fetchText('https://ua.test/feed', { accept: 'application/rss+xml' });

    expect(calls.at(-1)?.headers['user-agent']).toBe(USER_AGENT);
    expect(calls.at(-1)?.headers.accept).toBe('application/rss+xml');
  });

  it('passes a conditional request through and returns 304 as a RESULT, not an error', async () => {
    const { impl, calls } = fakeFetch({
      'https://etag.test/robots.txt': { status: 404 },
      'https://etag.test/feed': { status: 304, headers: { etag: 'W/"abc"' } },
    });
    const t = createTransport({ fetchImpl: impl, sleep: noSleep });

    const res = await t.fetchText('https://etag.test/feed', { 'If-None-Match': 'W/"abc"' });
    expect(res.status).toBe(304);
    expect(res.headers.etag).toBe('W/"abc"');
    expect(calls.at(-1)?.headers['If-None-Match']).toBe('W/"abc"');
  });

  it('re-checks policy on every redirect hop instead of following blindly', async () => {
    const { impl, calls } = fakeFetch({
      'https://hop.test/robots.txt': { status: 404 },
      'https://hop.test/feed': { status: 301, headers: { location: 'https://dest.test/real' } },
      'https://dest.test/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /real' },
    });
    const t = createTransport({ fetchImpl: impl, sleep: noSleep });

    await expect(t.fetchText('https://hop.test/feed')).rejects.toThrow(/disallows/);
    // It asked the DESTINATION's robots.txt — a `follow` redirect never would.
    expect(calls.map((c) => c.url)).toContain('https://dest.test/robots.txt');
  });

  it('stops after a bounded number of redirects', async () => {
    const { impl } = fakeFetch({
      'https://loop.test/robots.txt': { status: 404 },
      'https://loop.test/a': { status: 302, headers: { location: 'https://loop.test/a' } },
    });
    const t = createTransport({ fetchImpl: impl, sleep: noSleep });
    await expect(t.fetchText('https://loop.test/a')).rejects.toThrow(/too many redirects/);
  });

  it('carries a POST body as a named field rather than smuggling it in a header', async () => {
    const { impl, calls } = fakeFetch({
      'https://api.test/robots.txt': { status: 404 },
      'https://api.test/graphql': { status: 200, body: '{}' },
    });
    const t = createTransport({ fetchImpl: impl, sleep: noSleep });

    await t.fetchText('https://api.test/graphql', {}, { method: 'POST', body: '{"query":"{ posts }"}' });
    expect(calls.at(-1)?.method).toBe('POST');
    for (const value of Object.values(calls.at(-1)?.headers ?? {})) {
      expect(value).not.toContain('query');
    }
  });

  it('refuses a body larger than the cap instead of holding it in memory', async () => {
    const { impl } = fakeFetch({
      'https://big.test/robots.txt': { status: 404 },
      'https://big.test/feed': { status: 200, body: 'x'.repeat(100) },
    });
    const t = createTransport({ fetchImpl: impl, sleep: noSleep, maxBytes: 50 });
    await expect(t.fetchText('https://big.test/feed')).rejects.toThrow(/exceeds 50 bytes/);
  });
});
