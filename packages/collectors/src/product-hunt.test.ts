import { describe, it, expect } from 'vitest';
import { createProductHuntCollector, PRODUCT_HUNT_ENDPOINT } from './product-hunt.js';
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

const ENV = { PRODUCT_HUNT_TOKEN: 'ph-test-token' };

/* ── Fixtures ──────────────────────────────────────────────────────────────
 * Shaped exactly like a real Product Hunt GraphQL v2 payload, including the
 * relay edges/node nesting that is the usual place a naive mapper breaks. The
 * second post carries an email and a phone number on purpose — stripPii() has
 * to remove both before the body is ever stored.
 */

const POST_A = {
  id: '512345',
  name: 'Handyman Copilot',
  tagline: 'AI quoting for home-service pros',
  description: 'Generate a defensible quote in 20 seconds from a photo and a postcode.',
  url: 'https://www.producthunt.com/posts/handyman-copilot',
  createdAt: '2026-08-02T13:04:11Z',
  votesCount: 412,
  topics: {
    edges: [{ node: { name: 'Home Services' } }, { node: { name: 'Artificial Intelligence' } }],
  },
};

const POST_B = {
  id: '512201',
  name: 'Choreful',
  tagline: 'Book a cleaner in three taps',
  description: 'Questions? founders@choreful.io or +1 (416) 555-0134.',
  url: 'https://www.producthunt.com/posts/choreful',
  createdAt: '2026-08-01T09:15:00Z',
  votesCount: 88,
  topics: { edges: [{ node: { name: 'Productivity' } }] },
};

const HAPPY = JSON.stringify({
  data: {
    posts: {
      edges: [
        { cursor: 'Mg==', node: POST_A },
        { cursor: 'MQ==', node: POST_B },
      ],
      pageInfo: { endCursor: 'MQ==', hasNextPage: false },
    },
  },
});

const EMPTY = JSON.stringify({ data: { posts: { edges: [], pageInfo: { endCursor: null } } } });

const GRAPHQL_ERROR = JSON.stringify({
  data: null,
  errors: [{ message: 'Field "votesCount" does not exist on type "Post"' }],
});

const RATE_LIMIT_BODY = JSON.stringify({
  error: 'rate_limit_reached',
  error_description: 'Rate limit reached. Please try again later.',
});

describe('product hunt collector — identity', () => {
  it('declares the kind the source registry keys on', () => {
    const c = createProductHuntCollector(ENV);
    expect(c.kind).toBe('product_hunt');
    expect(c.name).toBeTruthy();
  });
});

describe('product hunt collector — isConfigured', () => {
  it('is false without a token, so the pipeline SKIPS instead of failing the run', () => {
    const c = createProductHuntCollector({});
    expect(c.isConfigured({})).toBe(false);
    expect(c.isConfigured({ PRODUCT_HUNT_TOKEN: '' })).toBe(false);
    expect(c.isConfigured({ PRODUCT_HUNT_TOKEN: '   ' })).toBe(false);
  });

  it('is true once the token is present', () => {
    expect(createProductHuntCollector(ENV).isConfigured(ENV)).toBe(true);
  });

  it('collect() refuses with not_configured rather than fetching unauthenticated', async () => {
    const { fetchText, calls } = stub(res(200, HAPPY));
    const r = await createProductHuntCollector({}).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('not_configured');
    expect(r.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('product hunt collector — request shape', () => {
  it('POSTs the GraphQL document via the documented header convention', async () => {
    const { fetchText, calls } = stub(res(200, HAPPY));
    await createProductHuntCollector(ENV).collect(ctxWith(fetchText));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(PRODUCT_HUNT_ENDPOINT);

    const h = call.headers ?? {};
    expect(h['authorization']).toBe('Bearer ph-test-token');
    expect(h['user-agent']).toBe(USER_AGENT);
    expect(h['content-type']).toBe('application/json');
    expect(call.init?.method).toBe('POST');
    // No smuggling: method/body are named fields, so no internal header can
    // ever escape to a third party through a missed strip.
    expect(Object.keys(h).some((k) => k.startsWith('x-tmos'))).toBe(false);

    const payload = JSON.parse(call.init?.body ?? '{}') as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(payload.query).toContain('posts');
    expect(payload.query).toContain('votesCount');
    expect(payload.variables['postedAfter']).toBe('2026-08-02T00:00:00.000Z');
  });

  it('uses the previous cursor as the postedAfter watermark', async () => {
    const { fetchText, calls } = stub(res(200, HAPPY));
    await createProductHuntCollector(ENV).collect(ctxWith(fetchText, '2026-07-30T00:00:00.000Z'));
    const payload = JSON.parse(calls[0]!.init?.body ?? '{}') as {
      variables: Record<string, unknown>;
    };
    expect(payload.variables['postedAfter']).toBe('2026-07-30T00:00:00.000Z');
  });

  it('blocks a never-scrape host before any fetch happens', async () => {
    const { fetchText, calls } = stub(res(200, HAPPY));
    const c = createProductHuntCollector(ENV, 'https://x.com/v2/api/graphql');
    const r = await c.collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('blocked_by_policy');
    expect(r.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('product hunt collector — happy path', () => {
  it('maps relay edges to RawItems with votes and topics in meta', async () => {
    const { fetchText } = stub(res(200, HAPPY));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.detail);
    expect(r.items).toHaveLength(2);

    const first = r.items[0]!;
    expect(first.externalId).toBe('512345');
    expect(first.title).toBe('Handyman Copilot');
    expect(first.url).toBe('https://www.producthunt.com/posts/handyman-copilot');
    expect(first.publishedAt).toBe('2026-08-02T13:04:11.000Z');
    expect(first.body).toContain('AI quoting for home-service pros');
    expect(first.body).toContain('defensible quote');
    expect(first.meta['votesCount']).toBe(412);
    expect(first.meta['topics']).toEqual(['Home Services', 'Artificial Intelligence']);
    expect(first.meta['tagline']).toBe('AI quoting for home-service pros');
  });

  it('strips PII from the body before it is ever stored', async () => {
    const { fetchText } = stub(res(200, HAPPY));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    if (!r.ok) throw new Error(r.detail);

    const second = r.items[1]!;
    expect(second.body).not.toContain('founders@choreful.io');
    expect(second.body).not.toContain('555-0134');
    expect(second.body).toContain('[email]');
    expect(second.body).toContain('[phone]');
  });

  it('advances the cursor to the newest createdAt it saw', async () => {
    const { fetchText } = stub(res(200, HAPPY));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    if (!r.ok) throw new Error(r.detail);
    expect(r.cursor).toBe('2026-08-02T13:04:11.000Z');
  });

  it('skips nodes with no id rather than inventing one', async () => {
    const body = JSON.stringify({
      data: {
        posts: {
          edges: [{ node: { name: 'No id here', tagline: 'x' } }, { node: POST_A }],
        },
      },
    });
    const { fetchText } = stub(res(200, body));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    if (!r.ok) throw new Error(r.detail);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.externalId).toBe('512345');
  });
});

describe('product hunt collector — empty is NOT an error', () => {
  it('returns ok with zero items when the source genuinely had nothing', async () => {
    const { fetchText } = stub(res(200, EMPTY));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.detail);
    expect(r.items).toEqual([]);
    // A quiet source keeps the previous watermark instead of jumping forward.
    expect(r.cursor).toBe('2026-08-02T00:00:00.000Z');
  });
});

describe('product hunt collector — failures', () => {
  it('malformed JSON is a parse failure, never an empty success', async () => {
    const { fetchText } = stub(res(200, '{"data": {"posts": '));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('parse');
    expect(r.retryable).toBe(false);
  });

  it('an unexpected JSON shape is a parse failure too', async () => {
    const { fetchText } = stub(res(200, JSON.stringify({ data: { posts: null } })));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('parse');
  });

  it('a GraphQL error array is a failure, not zero items', async () => {
    const { fetchText } = stub(res(200, GRAPHQL_ERROR));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('parse');
    expect(r.retryable).toBe(false);
    expect(r.detail).toContain('votesCount');
  });

  it.each([401, 403])('HTTP %i is auth and is NOT retryable', async (status) => {
    const { fetchText } = stub(res(status, '{"error":"invalid_token"}'));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('auth');
    expect(r.retryable).toBe(false);
    expect(r.detail).toContain(String(status));
  });

  it('HTTP 429 is rate_limited and IS retryable', async () => {
    const { fetchText } = stub(res(429, RATE_LIMIT_BODY));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('rate_limited');
    expect(r.retryable).toBe(true);
  });

  it('a GraphQL-level rate limit message is also rate_limited', async () => {
    const body = JSON.stringify({ errors: [{ message: 'Rate limit reached for this token' }] });
    const { fetchText } = stub(res(200, body));
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('rate_limited');
    expect(r.retryable).toBe(true);
  });

  it('5xx is retryable network, 4xx is not', async () => {
    const server = stub(res(503, 'upstream down'));
    const a = await createProductHuntCollector(ENV).collect(ctxWith(server.fetchText));
    if (a.ok) throw new Error('unreachable');
    expect(a.reason).toBe('network');
    expect(a.retryable).toBe(true);

    const client = stub(res(400, 'bad request'));
    const b = await createProductHuntCollector(ENV).collect(ctxWith(client.fetchText));
    if (b.ok) throw new Error('unreachable');
    expect(b.reason).toBe('network');
    expect(b.retryable).toBe(false);
  });

  it('a transport throw becomes a network failure, never an exception', async () => {
    const fetchText = async () => {
      throw new Error('ECONNRESET');
    };
    const r = await createProductHuntCollector(ENV).collect(ctxWith(fetchText));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('network');
    expect(r.detail).toContain('ECONNRESET');
  });
});
