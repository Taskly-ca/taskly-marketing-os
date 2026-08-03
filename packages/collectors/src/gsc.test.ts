import { describe, it, expect } from 'vitest';
import { createGscCollector, GSC_API_BASE, gscQueryUrl } from './gsc.js';
import { USER_AGENT } from './policy.js';
import type { CollectorContext, FetchInit, FetchTextResult } from './types.js';

/* ── Test doubles ──────────────────────────────────────────────────────────
 * No network, no filesystem, no keys. Every fixture below is an inline string.
 */

const NOW = new Date('2026-08-03T00:00:00.000Z');

interface Call {
  url: string;
  headers: Record<string, string> | undefined;
  init: FetchInit | undefined;
}

function stub(...results: FetchTextResult[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchText = async (url: string, headers?: Record<string, string>, init?: FetchInit) => {
    calls.push({ url, headers, init });
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    if (!r) throw new Error('test stub: no response configured');
    return r;
  };
  return { fetchText, calls };
}

const res = (status: number, body: string): FetchTextResult => ({ status, body, headers: {} });

function ctxWith(fetchText: CollectorContext['fetchText'], cursor?: string): CollectorContext {
  return { fetchText, now: () => NOW, ...(cursor ? { cursor } : {}) };
}

const ENV = {
  GSC_ACCESS_TOKEN: 'ya29.test-access-token',
  GSC_SITE_URL: 'sc-domain:taskly.ca',
};

/* ── Fixtures ──────────────────────────────────────────────────────────────
 * Verbatim shape of a Search Console searchAnalytics.query response. The third
 * row is a one-dimension row (page dropped) — real exports contain those and a
 * mapper that assumes keys[1] exists throws on them.
 */

const HAPPY = JSON.stringify({
  rows: [
    {
      keys: ['handyman toronto', 'https://taskly.ca/services/handyman'],
      clicks: 84,
      impressions: 2310,
      ctr: 0.03636363636363636,
      position: 7.412121212121212,
    },
    {
      keys: ['hire a cleaner near me', 'https://taskly.ca/services/cleaning'],
      clicks: 12,
      impressions: 940,
      ctr: 0.01276595744680851,
      position: 14.832978723404254,
    },
    {
      keys: ['email nishant@example.com for a quote'],
      clicks: 0,
      impressions: 3,
      ctr: 0,
      position: 61.333333333333336,
    },
  ],
  responseAggregationType: 'byProperty',
});

const EMPTY = JSON.stringify({ responseAggregationType: 'byProperty' });

const AUTH_ERROR = JSON.stringify({
  error: {
    code: 401,
    message: 'Request had invalid authentication credentials.',
    status: 'UNAUTHENTICATED',
  },
});

const QUOTA_ERROR = JSON.stringify({
  error: {
    code: 429,
    message: 'Quota exceeded for quota metric "Queries".',
    status: 'RESOURCE_EXHAUSTED',
  },
});

describe('gsc collector — identity', () => {
  it('declares the kind the source registry keys on', () => {
    const c = createGscCollector(ENV);
    expect(c.kind).toBe('gsc');
    expect(c.name).toBeTruthy();
  });
});

describe('gsc collector — isConfigured', () => {
  it('is false when either credential is missing, so the run SKIPS cleanly', () => {
    const c = createGscCollector(ENV);
    expect(c.isConfigured({})).toBe(false);
    expect(c.isConfigured({ GSC_ACCESS_TOKEN: 'ya29.x' })).toBe(false);
    expect(c.isConfigured({ GSC_SITE_URL: 'sc-domain:taskly.ca' })).toBe(false);
    expect(c.isConfigured({ GSC_ACCESS_TOKEN: '  ', GSC_SITE_URL: 'sc-domain:taskly.ca' })).toBe(
      false,
    );
  });

  it('is true with both', () => {
    expect(createGscCollector(ENV).isConfigured(ENV)).toBe(true);
  });

  it('collect() refuses with not_configured rather than fetching unauthenticated', async () => {
    const { fetchText, calls } = stub(res(200, HAPPY));
    const r = await createGscCollector({}).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('not_configured');
    expect(r.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('gsc collector — request shape', () => {
  it('POSTs a searchAnalytics query for the lagged 7-day window', async () => {
    const { fetchText, calls } = stub(res(200, HAPPY));
    await createGscCollector(ENV).collect(ctxWith(fetchText));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(gscQueryUrl(GSC_API_BASE, 'sc-domain:taskly.ca'));
    expect(call.url).toContain('sc-domain%3Ataskly.ca');
    expect(call.url.endsWith('/searchAnalytics/query')).toBe(true);

    const h = call.headers ?? {};
    expect(h['authorization']).toBe('Bearer ya29.test-access-token');
    expect(h['user-agent']).toBe(USER_AGENT);
    expect(h['content-type']).toBe('application/json');
    expect(call.init?.method).toBe('POST');
    // No smuggling: method/body are named fields, so no internal header can
    // ever escape to a third party through a missed strip.
    expect(Object.keys(h).some((k) => k.startsWith('x-tmos'))).toBe(false);

    const payload = JSON.parse(call.init?.body ?? '{}') as Record<string, unknown>;
    // Three days of reporting lag; a 7-day inclusive window behind it.
    expect(payload['endDate']).toBe('2026-07-31');
    expect(payload['startDate']).toBe('2026-07-25');
    expect(payload['dimensions']).toEqual(['query', 'page']);
    expect(payload['dataState']).toBe('final');
    expect(payload['rowLimit']).toBeGreaterThan(0);
  });

  it('resumes from the previous cursor as the window start', async () => {
    const { fetchText, calls } = stub(res(200, HAPPY));
    await createGscCollector(ENV).collect(ctxWith(fetchText, '2026-07-28'));
    const payload = JSON.parse(calls[0]!.init?.body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(payload['startDate']).toBe('2026-07-28');
  });

  it('blocks a never-scrape host before any fetch happens', async () => {
    const { fetchText, calls } = stub(res(200, HAPPY));
    const c = createGscCollector(ENV, 'https://x.com/webmasters/v3');
    const r = await c.collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('blocked_by_policy');
    expect(r.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('gsc collector — happy path', () => {
  it('maps each row to a RawItem with the metrics in meta', async () => {
    const { fetchText } = stub(res(200, HAPPY));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.detail);
    expect(r.items).toHaveLength(3);

    const first = r.items[0]!;
    expect(first.externalId).toBe(
      'handyman toronto|https://taskly.ca/services/handyman@2026-07-25',
    );
    expect(first.title).toBe('handyman toronto');
    expect(first.url).toBe('https://taskly.ca/services/handyman');
    expect(first.publishedAt).toBe('2026-07-31T00:00:00.000Z');
    expect(first.meta['clicks']).toBe(84);
    expect(first.meta['impressions']).toBe(2310);
    expect(first.meta['ctr']).toBeCloseTo(0.0363636, 6);
    expect(first.meta['position']).toBeCloseTo(7.4121212, 6);
    expect(first.meta['query']).toBe('handyman toronto');
    expect(first.meta['page']).toBe('https://taskly.ca/services/handyman');
    expect(first.meta['startDate']).toBe('2026-07-25');
    expect(first.meta['endDate']).toBe('2026-07-31');
  });

  it('writes a compact, human-readable body with no locale-dependent formatting', async () => {
    const { fetchText } = stub(res(200, HAPPY));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    if (!r.ok) throw new Error(r.detail);

    const body = r.items[0]!.body;
    expect(body).toContain('handyman toronto');
    expect(body).toContain('84 clicks');
    expect(body).toContain('2310 impressions');
    expect(body).toContain('3.64% CTR');
    expect(body).toContain('position 7.4');
    expect(body).toContain('2026-07-25');
    expect(body).toContain('2026-07-31');
  });

  it('survives a one-dimension row and leaves url null', async () => {
    const { fetchText } = stub(res(200, HAPPY));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    if (!r.ok) throw new Error(r.detail);

    const third = r.items[2]!;
    expect(third.url).toBeNull();
    expect(third.meta['page']).toBeNull();
    expect(third.externalId).toContain('@2026-07-25');
  });

  it('strips PII everywhere it can appear — search queries do contain emails', async () => {
    const { fetchText } = stub(res(200, HAPPY));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    if (!r.ok) throw new Error(r.detail);

    const third = r.items[2]!;
    for (const field of [third.body, third.title ?? '', third.externalId]) {
      expect(field).not.toContain('nishant@example.com');
      expect(field).toContain('[email]');
    }
    expect(third.meta['query']).not.toContain('nishant@example.com');
  });

  it('advances the cursor to the day after the window it just read', async () => {
    const { fetchText } = stub(res(200, HAPPY));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    if (!r.ok) throw new Error(r.detail);
    expect(r.cursor).toBe('2026-08-01');
  });
});

describe('gsc collector — empty is NOT an error', () => {
  it('returns ok with zero items when the property genuinely had no rows', async () => {
    const { fetchText } = stub(res(200, EMPTY));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.detail);
    expect(r.items).toEqual([]);
  });

  it('an explicitly empty rows array is also a success', async () => {
    const { fetchText } = stub(res(200, JSON.stringify({ rows: [] })));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.detail);
    expect(r.items).toEqual([]);
  });
});

describe('gsc collector — failures', () => {
  it('malformed JSON is a parse failure, never an empty success', async () => {
    const { fetchText } = stub(res(200, '{"rows": [{"keys": ['));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('parse');
    expect(r.retryable).toBe(false);
  });

  it('a rows field of the wrong type is a parse failure', async () => {
    const { fetchText } = stub(res(200, JSON.stringify({ rows: 'nope' })));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('parse');
  });

  it.each([401, 403])('HTTP %i is auth and is NOT retryable', async (status) => {
    const { fetchText } = stub(res(status, AUTH_ERROR));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('auth');
    expect(r.retryable).toBe(false);
    expect(r.detail).toContain(String(status));
  });

  it('HTTP 429 is rate_limited and IS retryable', async () => {
    const { fetchText } = stub(res(429, QUOTA_ERROR));
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('rate_limited');
    expect(r.retryable).toBe(true);
    expect(r.detail).toContain('Quota exceeded');
  });

  it('5xx is retryable network, 4xx is not', async () => {
    const server = stub(res(500, 'internal error'));
    const a = await createGscCollector(ENV).collect(ctxWith(server.fetchText));
    if (a.ok) throw new Error('unreachable');
    expect(a.reason).toBe('network');
    expect(a.retryable).toBe(true);

    const client = stub(res(400, 'bad request'));
    const b = await createGscCollector(ENV).collect(ctxWith(client.fetchText));
    if (b.ok) throw new Error('unreachable');
    expect(b.reason).toBe('network');
    expect(b.retryable).toBe(false);
  });

  it('a transport throw becomes a network failure, never an exception', async () => {
    const fetchText = async () => {
      throw new Error('ETIMEDOUT');
    };
    const r = await createGscCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('network');
    expect(r.detail).toContain('ETIMEDOUT');
  });
});
