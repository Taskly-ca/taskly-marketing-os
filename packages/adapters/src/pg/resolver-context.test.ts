/**
 * `ResolverContext`, with no database and no network.
 *
 * Three things are pinned here, and each one is a rule from
 * `packages/intel/src/resolver/kinds.ts` rather than a preference:
 *
 *   · a MISSING capability annuls — it never throws, and nothing here supplies
 *     a stub that would turn an absent capability into a "resolver threw";
 *   · the read-only boundary is opened by the statement that opens the
 *     transaction, applies to every statement in it, and the transaction is
 *     rolled back whatever happens;
 *   · a fetch is a crawl. The banned-host list and robots.txt are checked
 *     BEFORE the request, not after, and the assertion is that the fake fetch
 *     was never called at all.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Connect, PooledClient, QueryResultLike } from '@tmos/db';
import {
  httpJsonResolver,
  scrapeAssertResolver,
  sqlResolver,
  type ResolverSpec,
} from '@tmos/intel';

import {
  RESOLVER_ROLE,
  createResolverContext,
  createResolverFetchers,
  createResolverQuery,
} from './resolver-context.js';

/* ── fakes ──────────────────────────────────────────────────────────────── */

interface Statement {
  text: string;
  values: readonly unknown[];
}

function fakeConnect(
  onQuery: (text: string) => QueryResultLike | Error = () => ({ rows: [], rowCount: 0 }),
): { connect: Connect; statements: Statement[]; released: (boolean | undefined)[] } {
  const statements: Statement[] = [];
  const released: (boolean | undefined)[] = [];

  const client: PooledClient = {
    async query(text, values = []) {
      statements.push({ text, values });
      const result = onQuery(text);
      if (result instanceof Error) throw result;
      return result;
    },
    release(err) {
      released.push(err as boolean | undefined);
    },
  };
  return { connect: async () => client, statements, released };
}

const texts = (statements: Statement[]): string[] => statements.map((s) => s.text);

interface StubRoute {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

function stubFetch(routes: Record<string, StubRoute>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ url, headers });
    const route = routes[url];
    if (route === undefined) return new Response('', { status: 404 });
    return new Response(route.body ?? '', { status: route.status ?? 200, headers: route.headers });
  }) as typeof globalThis.fetch;

  return { fetch, calls };
}

/** A clock and a sleep that record instead of waiting. */
function fakeClock() {
  const slept: number[] = [];
  let t = 1_000_000;
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

const spec = (over: Partial<ResolverSpec> = {}): ResolverSpec => ({
  kind: 'sql',
  spec: 'select count(*) > 40 from entity',
  source_url: 'https://example.test/warehouse',
  fallback: 'annul',
  ...over,
});

/* ── a capability that is absent annuls, and never throws ───────────────── */

describe('a missing capability annuls', () => {
  it('omits query, fetchJson and fetchText when asked to, and every resolver annuls', async () => {
    const ctx = createResolverContext({ query: false, http: false });

    expect('query' in ctx).toBe(false);
    expect('fetchText' in ctx).toBe(false);

    expect(await sqlResolver.run(spec(), ctx)).toEqual({
      outcome: 'annulled',
      reason: 'no query capability supplied',
    });
    expect(
      await httpJsonResolver.run(spec({ kind: 'http_json', spec: '$.count >= 40' }), ctx),
    ).toEqual({ outcome: 'annulled', reason: 'no fetchJson capability supplied' });
    expect(
      await scrapeAssertResolver.run(spec({ kind: 'scrape_assert', spec: 'count:x >= 1' }), ctx),
    ).toEqual({ outcome: 'annulled', reason: 'no fetchText capability supplied' });
  });

  it('supplies all three, and a clock, by default', () => {
    const ctx = createResolverContext({ query: {}, http: {} });
    expect(typeof ctx.query).toBe('function');
    expect(typeof ctx.fetchJson).toBe('function');
    expect(typeof ctx.fetchText).toBe('function');
    expect(ctx.now?.()).toBeInstanceOf(Date);
  });
});

/* ── ctx.query: the boundary is the transaction, not the regex ──────────── */

describe('ctx.query', () => {
  it('opens read-only, drops privilege, runs the spec verbatim, and rolls back', async () => {
    const { connect, statements, released } = fakeConnect((text) =>
      text.startsWith('select count')
        ? { rows: [{ ok: true }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const query = createResolverQuery({ connect });

    expect(await query('select count(*) > 40 from entity')).toEqual([{ ok: true }]);

    expect(texts(statements)).toEqual([
      'begin read only',
      'select set_config($1, $2, true)',
      'select set_config($1, $2, true)',
      'select count(*) > 40 from entity',
      'rollback',
    ]);
    // A GUC name is an identifier and there is no `sql.raw`; `set_config` takes
    // both as parameters, so neither the role nor the timeout is spliced in.
    expect(statements[1]?.values).toEqual(['statement_timeout', '30000']);
    expect(statements[2]?.values).toEqual(['role', RESOLVER_ROLE]);
    // The spec is the value. It cannot be parameterised — which is exactly why
    // the two statements above it exist.
    expect(statements[3]?.values).toEqual([]);
    expect(released).toEqual([undefined]);
  });

  it('rolls back and releases when the spec fails, and reports the real error', async () => {
    const { connect, statements, released } = fakeConnect((text) =>
      text.startsWith('delete')
        ? Object.assign(new Error('cannot execute DELETE in a read-only transaction'), {
            code: '25006',
          })
        : { rows: [], rowCount: 0 },
    );

    await expect(createResolverQuery({ connect })('delete from fact')).rejects.toThrow(
      /read-only transaction/,
    );
    expect(texts(statements).at(-1)).toBe('rollback');
    expect(released).toEqual([undefined]);
  });

  it('honours role: null — the transaction-level boundary, and nothing else', async () => {
    const { connect, statements } = fakeConnect();
    await createResolverQuery({ connect, role: null })('select 1');

    // The timeout is still set; only the privilege drop is skipped.
    expect(statements.filter((s) => s.values[0] === 'role')).toHaveLength(0);
    expect(texts(statements)).toEqual([
      'begin read only',
      'select set_config($1, $2, true)',
      'select 1',
      'rollback',
    ]);
  });

  it('lets the caller pin a shorter statement timeout', async () => {
    const { connect, statements } = fakeConnect();
    await createResolverQuery({ connect, statementTimeoutMs: 500 })('select 1');
    expect(statements[1]?.values).toEqual(['statement_timeout', '500']);
  });

  it('destroys the connection when the rollback itself fails', async () => {
    const { connect, released } = fakeConnect((text) =>
      text === 'rollback' ? new Error('connection terminated') : { rows: [], rowCount: 0 },
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createResolverQuery({ connect })('select 1');
    expect(released).toEqual([true]);
    vi.restoreAllMocks();
  });
});

/* ── ctx.fetchText / fetchJson: a resolver is a crawler ─────────────────── */

const PAGE = 'https://example.test/pricing';
const ROBOTS = 'https://example.test/robots.txt';

describe('the fetch capabilities obey the collector policy', () => {
  it('never requests a banned host — the gate is before the request', async () => {
    const { fetch, calls } = stubFetch({});
    const { fetchText } = createResolverFetchers({ fetch });

    await expect(fetchText('https://www.linkedin.com/company/jiffy')).rejects.toThrow(
      /never-scrape list/,
    );
    expect(calls).toHaveLength(0);
  });

  it('treats robots.txt as a hard gate and does not fetch the page it disallows', async () => {
    const { fetch, calls } = stubFetch({
      [ROBOTS]: { body: 'User-agent: *\nDisallow: /pricing' },
      [PAGE]: { body: 'from $99' },
    });
    const { fetchText } = createResolverFetchers({ fetch, ...fakeClock() });

    await expect(fetchText(PAGE)).rejects.toThrow(/robots.txt disallows \/pricing/);
    expect(calls.map((c) => c.url)).toEqual([ROBOTS]);
  });

  it('identifies itself as TasklyBot and returns the body when allowed', async () => {
    const { fetch, calls } = stubFetch({
      [ROBOTS]: { status: 404 },
      [PAGE]: { body: 'Handyman from $99/hr' },
    });
    const { fetchText } = createResolverFetchers({ fetch, ...fakeClock() });

    expect(await fetchText(PAGE)).toBe('Handyman from $99/hr');
    expect(calls[1]?.headers['user-agent']).toMatch(/^TasklyBot\/1\.0/);
  });

  it('refuses when robots.txt is unreadable rather than assuming it is permissive', async () => {
    const { fetch } = stubFetch({ [ROBOTS]: { status: 503 }, [PAGE]: { body: 'x' } });
    const { fetchText } = createResolverFetchers({ fetch, ...fakeClock() });

    await expect(fetchText(PAGE)).rejects.toThrow(/robots.txt for example.test is unreadable/);
  });

  it('waits at least 2s between requests to a host, and honours a longer Crawl-delay', async () => {
    const ownFloor = fakeClock();
    const { fetch } = stubFetch({ [ROBOTS]: { status: 404 }, [PAGE]: { body: 'a' } });
    const polite = createResolverFetchers({ fetch, ...ownFloor });
    await polite.fetchText(PAGE);
    await polite.fetchText(PAGE);
    expect(ownFloor.slept).toEqual([2000, 2000]);

    const theirs = fakeClock();
    const slow = stubFetch({
      [ROBOTS]: { body: 'User-agent: *\nCrawl-delay: 5' },
      [PAGE]: { body: 'a' },
    });
    const politeSlow = createResolverFetchers({ fetch: slow.fetch, ...theirs });
    await politeSlow.fetchText(PAGE);
    await politeSlow.fetchText(PAGE);
    expect(theirs.slept).toEqual([5000, 5000]);
    // robots.txt is read once per host, not once per request.
    expect(slow.calls.filter((c) => c.url === ROBOTS)).toHaveLength(1);
  });

  it('re-checks policy on every redirect hop, so a redirect cannot smuggle a banned host', async () => {
    const { fetch, calls } = stubFetch({
      [ROBOTS]: { status: 404 },
      [PAGE]: { status: 302, headers: { location: 'https://www.linkedin.com/company/jiffy' } },
    });
    const { fetchText } = createResolverFetchers({ fetch, ...fakeClock() });

    await expect(fetchText(PAGE)).rejects.toThrow(/never-scrape list/);
    expect(calls.some((c) => c.url.includes('linkedin'))).toBe(false);
  });

  it('annuls on a non-2xx and on a body that is not JSON, rather than guessing', async () => {
    const { fetch } = stubFetch({ [ROBOTS]: { status: 404 }, [PAGE]: { status: 500 } });
    const { fetchText } = createResolverFetchers({ fetch, ...fakeClock() });
    await expect(fetchText(PAGE)).rejects.toThrow(/HTTP 500/);

    const html = stubFetch({
      [ROBOTS]: { status: 404 },
      [PAGE]: { body: '<html>error</html>' },
    });
    const { fetchJson } = createResolverFetchers({ fetch: html.fetch, ...fakeClock() });
    await expect(fetchJson(PAGE)).rejects.toThrow(/did not return JSON/);
  });

  it('refuses a body past the ceiling instead of holding it', async () => {
    const { fetch } = stubFetch({ [ROBOTS]: { status: 404 }, [PAGE]: { body: 'x'.repeat(50) } });
    const { fetchText } = createResolverFetchers({ fetch, maxBytes: 10, ...fakeClock() });
    await expect(fetchText(PAGE)).rejects.toThrow(/exceeds 10 bytes/);
  });
});

/* ── the resolvers, driven through the real context ─────────────────────── */

describe('end to end, through the resolvers that consume the context', () => {
  it('scrape_assert resolves against a fetched page', async () => {
    const { fetch } = stubFetch({
      [ROBOTS]: { status: 404 },
      [PAGE]: { body: 'Toronto Toronto Toronto' },
    });
    const ctx = createResolverContext({ query: false, http: { fetch, ...fakeClock() } });

    expect(
      await scrapeAssertResolver.run(
        { kind: 'scrape_assert', spec: 'count:Toronto >= 2', source_url: PAGE, fallback: 'annul' },
        ctx,
      ),
    ).toEqual({ outcome: 1, observed: 3 });
  });

  it('a blocked fetch annuls with the reason attached — never a failed prediction', async () => {
    const { fetch } = stubFetch({});
    const ctx = createResolverContext({ query: false, http: { fetch, ...fakeClock() } });

    const result = await scrapeAssertResolver.run(
      {
        kind: 'scrape_assert',
        spec: 'count:x >= 1',
        source_url: 'https://www.tiktok.com/@jiffy',
        fallback: 'annul',
      },
      ctx,
    );
    expect(result.outcome).toBe('annulled');
    expect(result).toHaveProperty('reason', expect.stringContaining('never-scrape list'));
  });

  it('sql annuls on ambiguity — more than one row is never a guess', async () => {
    const { connect } = fakeConnect((text) =>
      text.startsWith('select') && !text.startsWith('select set_config')
        ? { rows: [{ a: 1 }, { a: 2 }], rowCount: 2 }
        : { rows: [], rowCount: 0 },
    );
    const ctx = createResolverContext({ query: { connect }, http: false });

    expect(await sqlResolver.run(spec(), ctx)).toEqual({
      outcome: 'annulled',
      reason: 'expected exactly 1 row, got 2',
    });
  });
});
