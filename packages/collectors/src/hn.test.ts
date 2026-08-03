import { describe, it, expect } from 'vitest';
import { createHnCollector } from './hn.js';
import type { CollectorContext, CollectResult, FetchTextResult } from './types.js';

/* ── fixtures ───────────────────────────────────────────────────────────── */

/** Shape of a real hn.algolia.com search_by_date response, trimmed. */
const HITS = JSON.stringify({
  hits: [
    {
      objectID: '41928374',
      created_at: '2026-08-02T13:02:11.000Z',
      title: 'Ask HN: how do you vet a handyman without a platform?',
      url: null,
      story_text: 'We tried three apps in Toronto. Text me at 647-555-0199 if you have data.',
      points: 142,
      num_comments: 88,
      author: 'someuser',
    },
    {
      objectID: '41928001',
      created_at: '2026-08-01T20:11:00.000Z',
      title: 'Show HN: a task marketplace for the GTA',
      url: 'https://example.ca/show',
      story_text: '<p>Built it in a weekend. Email <b>founder@example.com</b>.</p>',
      points: 57,
      num_comments: 31,
      author: 'builder',
    },
    {
      objectID: '41927500',
      created_at: '2026-08-01T09:00:00.000Z',
      title: 'Gig work regulation in Ontario',
      url: 'https://www.linkedin.com/pulse/gig-work-ontario',
      story_text: '',
      points: 12,
      num_comments: 4,
      author: 'lurker',
    },
  ],
});

const NO_HITS = JSON.stringify({ hits: [], nbHits: 0 });

/** Algolia behind a proxy outage: HTML body, HTTP 200. */
const NOT_JSON = '<html><body>503 Service Unavailable</body></html>';

/** Valid JSON, wrong shape — still a parse failure, never a quiet source. */
const WRONG_SHAPE = JSON.stringify({ message: 'index not found' });

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

describe('hn collector — happy path', () => {
  it('maps Algolia hits to RawItem and carries points + num_comments in meta', async () => {
    const c = createHnCollector('task marketplace');
    const { ctx, calls } = makeCtx(res(HITS));
    const r = expectOk(await c.collect(ctx));

    expect(c.kind).toBe('hn');
    expect(calls[0]!.url).toContain('hn.algolia.com/api/v1/search_by_date');
    expect(calls[0]!.url).toContain('tags=story');
    expect(calls[0]!.url).toContain('query=task%20marketplace');

    expect(r.items).toHaveLength(3);
    const ask = r.items[0]!;
    expect(ask.externalId).toBe('41928374');
    expect(ask.title).toBe('Ask HN: how do you vet a handyman without a platform?');
    expect(ask.publishedAt).toBe('2026-08-02T13:02:11.000Z');
    expect(ask.meta.points).toBe(142);
    expect(ask.meta.num_comments).toBe(88);
    expect(ask.meta.hnUrl).toBe('https://news.ycombinator.com/item?id=41928374');

    // A story with no outbound link points at the HN discussion instead of null.
    expect(ask.url).toBe('https://news.ycombinator.com/item?id=41928374');
    expect(r.items[1]!.url).toBe('https://example.ca/show');

    // HTML in story_text is flattened to plain text.
    expect(r.items[1]!.body).toContain('Built it in a weekend.');
    expect(r.items[1]!.body).not.toContain('<p>');
  });

  it('never stores a banned-host link — falls back to the HN discussion url', async () => {
    const c = createHnCollector('gig work');
    const r = expectOk(await c.collect(makeCtx(res(HITS)).ctx));
    const linked = r.items[2]!;
    expect(linked.url).toBe('https://news.ycombinator.com/item?id=41927500');
    expect(JSON.stringify(linked)).not.toContain('linkedin.com');
  });

  it('sends the bot User-Agent and If-None-Match when a prior etag exists', async () => {
    const c = createHnCollector('taskly');
    const { ctx, calls } = makeCtx(res(HITS), { etag: '"hn-prev"' });
    await c.collect(ctx);
    const headers = calls[0]!.headers ?? {};
    expect(headers['If-None-Match']).toBe('"hn-prev"');
    expect(headers['User-Agent']).toContain('TasklyBot');
  });
});

describe('hn collector — quiet vs broken must be distinguishable', () => {
  it('zero hits is ok:true with an empty array', async () => {
    const c = createHnCollector('taskly');
    const r = expectOk(await c.collect(makeCtx(res(NO_HITS)).ctx));
    expect(r.items).toEqual([]);
    expect(r.notModified).toBeUndefined();
  });

  it('a non-JSON body served as 200 is a parse failure', async () => {
    const c = createHnCollector('taskly');
    const r = expectFail(await c.collect(makeCtx(res(NOT_JSON)).ctx));
    expect(r.reason).toBe('parse');
  });

  it('valid JSON without a hits array is a parse failure, not an empty result', async () => {
    const c = createHnCollector('taskly');
    expect(expectFail(await c.collect(makeCtx(res(WRONG_SHAPE)).ctx)).reason).toBe('parse');
  });
});

describe('hn collector — transport', () => {
  it('returns notModified() on HTTP 304', async () => {
    const c = createHnCollector('taskly');
    const { ctx } = makeCtx(res('', 304), { etag: '"hn-prev"' });
    const r = expectOk(await c.collect(ctx));
    expect(r.notModified).toBe(true);
    expect(r.items).toEqual([]);
    expect(r.etag).toBe('"hn-prev"');
  });

  it('maps 429 to rate_limited and a thrown transport error to network', async () => {
    const c = createHnCollector('taskly');
    expect(expectFail(await c.collect(makeCtx(res('', 429)).ctx)).reason).toBe('rate_limited');

    const { ctx } = makeCtx(() => Promise.reject(new Error('socket hang up')));
    const thrown = expectFail(await c.collect(ctx));
    expect(thrown.reason).toBe('network');
    expect(thrown.detail).toContain('socket hang up');
  });
});

describe('hn collector — policy', () => {
  it('refuses a banned endpoint before any fetch happens', async () => {
    const c = createHnCollector('taskly', 'HN via x', {
      endpoint: 'https://x.com/api/v1/search_by_date',
    });
    const { ctx, calls } = makeCtx(res(HITS));
    const r = expectFail(await c.collect(ctx));
    expect(r.reason).toBe('blocked_by_policy');
    expect(r.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('strips phone numbers and emails from story bodies', async () => {
    const c = createHnCollector('taskly');
    const r = expectOk(await c.collect(makeCtx(res(HITS)).ctx));
    expect(r.items[0]!.body).toContain('[phone]');
    expect(r.items[0]!.body).not.toContain('647-555-0199');
    expect(r.items[1]!.body).toContain('[email]');
    expect(r.items[1]!.body).not.toContain('founder@example.com');
  });

  it('never carries the author handle into the item', async () => {
    const c = createHnCollector('taskly');
    const r = expectOk(await c.collect(makeCtx(res(HITS)).ctx));
    expect(JSON.stringify(r.items)).not.toContain('someuser');
  });

  it('is not configured without a query and fails cleanly rather than fetching', async () => {
    const c = createHnCollector('   ');
    expect(c.isConfigured({})).toBe(false);
    const { ctx, calls } = makeCtx(res(HITS));
    expect(expectFail(await c.collect(ctx)).reason).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });

  it('is configured with a query and needs no credential', () => {
    expect(createHnCollector('taskly').isConfigured({})).toBe(true);
  });
});
