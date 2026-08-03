import { describe, it, expect } from 'vitest';
import { createGdeltCollector } from './gdelt.js';
import type { CollectorContext, CollectResult, FetchTextResult } from './types.js';

/* ── fixtures ───────────────────────────────────────────────────────────── */

/** Shape of a real GDELT DOC 2.0 artlist response, trimmed. */
const ARTICLES = JSON.stringify({
  articles: [
    {
      url: 'https://www.thestar.com/news/gta/handyman-demand-up.html',
      url_mobile: '',
      title: 'Handyman demand up across the GTA &amp; rates follow - Toronto Star',
      seendate: '20260802T141500Z',
      socialimage: 'https://images.thestar.com/x.jpg',
      domain: 'thestar.com',
      language: 'English',
      sourcecountry: 'Canada',
    },
    {
      url: 'https://www.linkedin.com/pulse/gta-trades-shortage',
      title: 'GTA trades shortage deepens',
      seendate: '20260802T120000Z',
      domain: 'linkedin.com',
      language: 'English',
      sourcecountry: 'Canada',
    },
    {
      url: 'https://example.ca/contact-piece',
      title: 'Reach the newsroom at tips@example.ca or 416-555-0111',
      seendate: '20260801T083000Z',
      domain: 'example.ca',
      language: 'English',
      sourcecountry: 'Canada',
    },
  ],
});

/** GDELT genuinely returns an empty object when a query matches nothing. */
const NO_ARTICLES = JSON.stringify({});

/** GDELT's real failure mode: a plain-text complaint with HTTP 200. */
const PLAIN_TEXT_ERROR =
  'Your query was too short or too long. Please make sure it is between 3 and 500 characters.';

/** Valid JSON, wrong shape. */
const WRONG_SHAPE = JSON.stringify({ articles: 'nope' });

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

describe('gdelt collector — happy path', () => {
  it('maps articles to RawItem with url as externalId and domain/language in meta', async () => {
    const c = createGdeltCollector('handyman AND toronto');
    const { ctx, calls } = makeCtx(res(ARTICLES));
    const r = expectOk(await c.collect(ctx));

    expect(c.kind).toBe('gdelt');
    expect(calls[0]!.url).toContain('api.gdeltproject.org/api/v2/doc/doc');
    expect(calls[0]!.url).toContain('mode=artlist');
    expect(calls[0]!.url).toContain('format=json');
    expect(calls[0]!.url).toContain('query=handyman%20AND%20toronto');

    const first = r.items[0]!;
    expect(first.externalId).toBe('https://www.thestar.com/news/gta/handyman-demand-up.html');
    expect(first.url).toBe('https://www.thestar.com/news/gta/handyman-demand-up.html');
    expect(first.title).toBe('Handyman demand up across the GTA & rates follow - Toronto Star');
    expect(first.body).toBe('Handyman demand up across the GTA & rates follow - Toronto Star');
    expect(first.publishedAt).toBe('2026-08-02T14:15:00.000Z');
    expect(first.meta.domain).toBe('thestar.com');
    expect(first.meta.language).toBe('English');
    expect(first.meta.sourcecountry).toBe('Canada');
  });

  it('drops articles on banned hosts instead of ingesting them', async () => {
    const c = createGdeltCollector('gta trades');
    const r = expectOk(await c.collect(makeCtx(res(ARTICLES)).ctx));
    expect(r.items).toHaveLength(2);
    expect(JSON.stringify(r.items)).not.toContain('linkedin.com');
  });

  it('sends the bot User-Agent and If-None-Match when a prior etag exists', async () => {
    const c = createGdeltCollector('taskly');
    const { ctx, calls } = makeCtx(res(ARTICLES), { etag: '"gdelt-prev"' });
    await c.collect(ctx);
    const headers = calls[0]!.headers ?? {};
    expect(headers['If-None-Match']).toBe('"gdelt-prev"');
    expect(headers['User-Agent']).toContain('TasklyBot');
  });
});

describe('gdelt collector — quiet vs broken must be distinguishable', () => {
  it('a response with no articles key is ok:true with an empty array', async () => {
    const c = createGdeltCollector('taskly');
    const r = expectOk(await c.collect(makeCtx(res(NO_ARTICLES)).ctx));
    expect(r.items).toEqual([]);
    expect(r.notModified).toBeUndefined();
  });

  it("GDELT's plain-text error at HTTP 200 is a parse failure", async () => {
    const c = createGdeltCollector('taskly');
    const r = expectFail(await c.collect(makeCtx(res(PLAIN_TEXT_ERROR)).ctx));
    expect(r.reason).toBe('parse');
    expect(r.detail).toBeTruthy();
  });

  it('a non-array articles field is a parse failure, not an empty result', async () => {
    const c = createGdeltCollector('taskly');
    expect(expectFail(await c.collect(makeCtx(res(WRONG_SHAPE)).ctx)).reason).toBe('parse');
  });
});

describe('gdelt collector — transport', () => {
  it('returns notModified() on HTTP 304', async () => {
    const c = createGdeltCollector('taskly');
    const { ctx } = makeCtx(res('', 304), { etag: '"gdelt-prev"' });
    const r = expectOk(await c.collect(ctx));
    expect(r.notModified).toBe(true);
    expect(r.items).toEqual([]);
    expect(r.etag).toBe('"gdelt-prev"');
  });

  it('maps 429 to rate_limited and a thrown transport error to network', async () => {
    const c = createGdeltCollector('taskly');
    expect(expectFail(await c.collect(makeCtx(res('', 429)).ctx)).reason).toBe('rate_limited');

    const { ctx } = makeCtx(() => Promise.reject(new Error('DNS lookup failed')));
    const thrown = expectFail(await c.collect(ctx));
    expect(thrown.reason).toBe('network');
    expect(thrown.detail).toContain('DNS lookup failed');
  });
});

describe('gdelt collector — policy', () => {
  it('refuses a banned endpoint before any fetch happens', async () => {
    const c = createGdeltCollector('taskly', 'GDELT via facebook', {
      endpoint: 'https://facebook.com/api/v2/doc/doc',
    });
    const { ctx, calls } = makeCtx(res(ARTICLES));
    const r = expectFail(await c.collect(ctx));
    expect(r.reason).toBe('blocked_by_policy');
    expect(r.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('strips emails and phone numbers out of headline bodies', async () => {
    const c = createGdeltCollector('taskly');
    const r = expectOk(await c.collect(makeCtx(res(ARTICLES)).ctx));
    const contactPiece = r.items[1]!;
    expect(contactPiece.body).toContain('[email]');
    expect(contactPiece.body).toContain('[phone]');
    expect(contactPiece.body).not.toContain('tips@example.ca');
    expect(contactPiece.body).not.toContain('416-555-0111');
  });

  it('is not configured without a query and fails cleanly rather than fetching', async () => {
    const c = createGdeltCollector(' ');
    expect(c.isConfigured({})).toBe(false);
    const { ctx, calls } = makeCtx(res(ARTICLES));
    expect(expectFail(await c.collect(ctx)).reason).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });

  it('is configured with a query and needs no credential', () => {
    expect(createGdeltCollector('taskly').isConfigured({})).toBe(true);
  });
});
