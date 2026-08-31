/**
 * Acceptance tests for the Google Trends collector.
 *
 * Every fixture in this file is shaped from a REAL response captured on
 * 2026-08-31 against `trends.google.com` (see the header of `trends.ts` for the
 * transcript). Two of them encode findings that a hand-invented fixture would
 * never have produced, and both are load-bearing:
 *
 *   • the two endpoints use DIFFERENT anti-JSON-hijacking prefixes —
 *     `)]}'\n` from explore and `)]}',\n` from widgetdata/multiline;
 *   • a term with essentially no volume still comes back with a 100 in it,
 *     because the 0–100 scale is renormalised to whatever the series' own
 *     maximum happens to be. `zqxjkwv plumbing gutter` measured 1 week with
 *     data out of 53 — and a peak of 100.
 *
 * The second one is the reason `NO_DATA_TERM` exists as a test rather than as a
 * comment: a collector that reads `value` without reading `hasData` publishes
 * pure noise at maximum confidence.
 */
import { describe, expect, it } from 'vitest';

import { createTrendsCollector } from './trends.js';
import type { CollectResult, CollectorContext, FetchTextResult } from './types.js';

/* ── fixtures ───────────────────────────────────────────────────────────── */

/** explore sends `)]}'` and a newline. multiline sends `)]}'` , a COMMA, a newline. */
const EXPLORE_PREFIX = ")]}'\n";
const MULTILINE_PREFIX = ")]}',\n";

/** Monday 2025-09-01T00:00:00Z, in unix seconds — the first week of the window. */
const WEEK0 = 1_756_684_800;
const WEEK_SECONDS = 604_800;

interface Point {
  value: number;
  /** Google's own "was there enough volume to say anything" flag. */
  hasData?: boolean;
  partial?: boolean;
}

/** A `widgetdata/multiline` body from a list of weekly points. */
function multiline(points: readonly Point[]): string {
  const timelineData = points.map((p, i) => ({
    time: String(WEEK0 + i * WEEK_SECONDS),
    formattedTime: `week ${i}`,
    value: [p.value],
    hasData: [p.hasData ?? p.value > 0],
    formattedValue: [String(p.value)],
    ...(p.partial === true ? { isPartial: true } : {}),
  }));
  return MULTILINE_PREFIX + JSON.stringify({ default: { timelineData, averages: [] } });
}

/**
 * An `api/explore` body carrying the widgets Google actually returns.
 *
 * The keyword is echoed into the TIMESERIES `request` because that is what the
 * real one does — and it is how the harness knows which term a `multiline`
 * request is for, since by then the term only exists inside the echoed object.
 */
function explore(term = 'x', token = 'tok-abc'): string {
  return (
    EXPLORE_PREFIX +
    JSON.stringify({
      widgets: [
        {
          id: 'TIMESERIES',
          type: 'fe_line_chart',
          title: 'Interest over time',
          token,
          request: {
            time: '2025-08-31 2026-08-31',
            resolution: 'WEEK',
            locale: 'en-US',
            comparisonItem: [
              {
                geo: { region: 'CA-ON' },
                complexKeywordsRestriction: { keyword: [{ type: 'BROAD', value: term }] },
              },
            ],
            requestOptions: { property: '', backend: 'IZG', category: 0 },
          },
        },
        { id: 'GEO_MAP', type: 'fe_geo_chart_explore', token: 'tok-geo', request: {} },
        { id: 'RELATED_QUERIES', type: 'fe_related_searches', token: 'tok-rel', request: {} },
      ],
    })
  );
}

/** 52 complete weeks + 1 partial. Flat at `base`, then `recent` for the last 4. */
function flatThenRecent(base: number, recent: number): readonly Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < 48; i += 1) pts.push({ value: base, hasData: true });
  for (let i = 0; i < 4; i += 1) pts.push({ value: recent, hasData: true });
  // The current week is always incomplete. It is always the lowest point on the
  // chart, and it always looks like a collapse.
  pts.push({ value: 1, hasData: true, partial: true });
  return pts;
}

/**
 * The measured shape of a real seasonal term waking up: a past winter with
 * volume, a long dormant summer, then four weeks off zero. `snow removal
 * toronto` in CA-ON measured 20 of 53 weeks with data and a 12-month median of
 * exactly 0 — so the baseline the last four weeks are compared against is zero,
 * and a ratio is undefined rather than large.
 */
function seasonalWake(): readonly Point[] {
  const pts: Point[] = [];
  // weeks 0–15: last winter.
  for (let i = 0; i < 16; i += 1) pts.push({ value: 12 + i, hasData: true });
  // weeks 16–47: dormant. Zero, and Google says it has nothing to report.
  for (let i = 0; i < 32; i += 1) pts.push({ value: 0, hasData: false });
  // weeks 48–51: the season turning.
  for (let i = 0; i < 4; i += 1) pts.push({ value: 35, hasData: true });
  pts.push({ value: 4, hasData: true, partial: true });
  return pts;
}

/** The measured shape of a term with no real volume: one stray week, at 100. */
const NO_DATA_TERM: readonly Point[] = [
  ...Array.from({ length: 20 }, () => ({ value: 0, hasData: false })),
  { value: 100, hasData: true },
  ...Array.from({ length: 31 }, () => ({ value: 0, hasData: false })),
  { value: 0, hasData: false, partial: true },
];

const SEED_COOKIE =
  'NID=534=pSgbSMuXF8ypjRu6x199eIVbNQOW; expires=Sat, 28-Feb-2026 21:49:35 GMT; path=/; domain=.google.com; HttpOnly';

/* ── harness ────────────────────────────────────────────────────────────── */

type Call = { url: string; headers: Record<string, string> | undefined };
type Route = FetchTextResult | (() => Promise<FetchTextResult>);

const res = (body: string, status = 200, headers: Record<string, string> = {}): FetchTextResult =>
  ({ status, body, headers }) satisfies FetchTextResult;

const seedOk = (cookie: string | null = SEED_COOKIE): FetchTextResult =>
  res('<html>Trends</html>', 200, cookie === null ? {} : { 'set-cookie': cookie });

/** The keyword inside a `req=` parameter, so a route can answer per term. */
function termOf(url: string): string {
  const req = new URL(url).searchParams.get('req') ?? '{}';
  return /"(?:keyword|value)"\s*:\s*"([^"]*)"/.exec(req)?.[1] ?? '';
}

interface Routes {
  seed?: Route;
  explore?: (term: string) => Route;
  multiline?: (term: string) => Route;
}

function makeCtx(routes: Routes, extra: Partial<CollectorContext> = {}) {
  const calls: Call[] = [];
  const answer = async (r: Route): Promise<FetchTextResult> =>
    typeof r === 'function' ? await r() : r;

  const ctx: CollectorContext = {
    fetchText: async (url, headers) => {
      calls.push({ url, headers });
      if (url.includes('/trends/api/explore')) {
        const term = termOf(url);
        return answer(routes.explore?.(term) ?? res(explore(term)));
      }
      if (url.includes('/trends/api/widgetdata/multiline')) {
        return answer(routes.multiline?.(termOf(url)) ?? res(multiline(flatThenRecent(10, 10))));
      }
      return answer(routes.seed ?? seedOk());
    },
    now: () => new Date('2026-08-31T12:00:00Z'),
    ...extra,
  };
  return { ctx, calls };
}

function expectOk(r: CollectResult): Extract<CollectResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.detail}`);
  return r;
}

function expectFail(r: CollectResult): Extract<CollectResult, { ok: false }> {
  if (r.ok) throw new Error(`expected failure, got ${r.items.length} items`);
  return r;
}

/* ── tests ──────────────────────────────────────────────────────────────── */

describe('trends collector — the two-step dance', () => {
  it('seeds a cookie, then explores and reads the timeseries widget per term', async () => {
    const c = createTrendsCollector(['snow removal', 'house cleaning']);
    const { ctx, calls } = makeCtx({});
    const r = expectOk(await c.collect(ctx));

    expect(c.kind).toBe('trends');
    // 1 seed + (explore + multiline) per term. The seed is paid once, not twice.
    expect(calls).toHaveLength(5);
    expect(calls[0]!.url).toBe('https://trends.google.com/trends/');
    expect(calls[1]!.url).toContain('/trends/api/explore');
    expect(calls[2]!.url).toContain('/trends/api/widgetdata/multiline');
    expect(r.items).toHaveLength(2);
  });

  it('forwards the NID cookie the seed request set — without it Google answers 429', async () => {
    const c = createTrendsCollector(['snow removal']);
    const { ctx, calls } = makeCtx({});
    expectOk(await c.collect(ctx));

    // Only the NID pair, never the whole Set-Cookie line with its attributes.
    expect(calls[1]!.headers?.Cookie).toBe('NID=534=pSgbSMuXF8ypjRu6x199eIVbNQOW');
    expect(calls[1]!.headers?.Cookie).not.toContain('HttpOnly');
    expect(calls[2]!.headers?.Cookie).toBe('NID=534=pSgbSMuXF8ypjRu6x199eIVbNQOW');
    expect(calls[1]!.headers?.['User-Agent']).toContain('TasklyBot');
  });

  it('carries the token from explore into the widgetdata request', async () => {
    const c = createTrendsCollector(['snow removal'], undefined, {});
    const { ctx, calls } = makeCtx({ explore: (t) => res(explore(t, 'tok-XYZ')) });
    expectOk(await c.collect(ctx));
    expect(new URL(calls[2]!.url).searchParams.get('token')).toBe('tok-XYZ');
  });

  it('asks about Ontario, not the world', async () => {
    const c = createTrendsCollector(['snow removal']);
    const { ctx, calls } = makeCtx({});
    expectOk(await c.collect(ctx));
    const req = new URL(calls[1]!.url).searchParams.get('req') ?? '';
    expect(JSON.parse(req)).toMatchObject({
      comparisonItem: [{ keyword: 'snow removal', geo: 'CA-ON', time: 'today 12-m' }],
    });
  });
});

describe("trends collector — the )]}' prefix", () => {
  it('strips both prefix forms: bare on explore, comma-suffixed on multiline', async () => {
    const c = createTrendsCollector(['snow removal']);
    const r = expectOk(await c.collect(makeCtx({}).ctx));
    expect(r.items).toHaveLength(1);
  });

  it('treats a body WITHOUT the prefix as a parse failure, not as an empty term', async () => {
    // A proxy or a consent interstitial that answers 200 with something else is
    // the single most likely way this endpoint dies. It must not read as quiet.
    const c = createTrendsCollector(['snow removal']);
    const naked = explore().slice(EXPLORE_PREFIX.length);
    const r = expectFail(await c.collect(makeCtx({ explore: () => res(naked) }).ctx));
    expect(r.reason).toBe('parse');
    expect(r.detail).toContain(")]}'");
  });

  it('treats a prefixed body that is not JSON as a parse failure', async () => {
    const c = createTrendsCollector(['snow removal']);
    const r = expectFail(
      await c.collect(makeCtx({ multiline: () => res(`${MULTILINE_PREFIX}<html>502</html>`) }).ctx),
    );
    expect(r.reason).toBe('parse');
  });
});

describe('trends collector — a reading of nothing is a reading, not a failure', () => {
  it('an empty timeline is ok:true and contributes no item', async () => {
    const c = createTrendsCollector(['zqxjkwv gutter']);
    const r = expectOk(await c.collect(makeCtx({ multiline: () => res(multiline([])) }).ctx));
    expect(r.items).toEqual([]);
  });

  it('refuses to publish the renormalised 100 of a term with one week of data', async () => {
    // MEASURED 2026-08-31: `zqxjkwv plumbing gutter` in CA-ON returned 1/53
    // weeks with data and a peak of 100. Reading `value` without `hasData`
    // reports a nonsense term as the strongest signal on the board.
    const c = createTrendsCollector(['zqxjkwv plumbing gutter']);
    const r = expectOk(await c.collect(makeCtx({ multiline: () => res(multiline(NO_DATA_TERM)) }).ctx));
    expect(r.items).toEqual([]);
  });

  it('one silent term does not silence the terms beside it', async () => {
    const c = createTrendsCollector(['zqxjkwv gutter', 'house cleaning']);
    const { ctx } = makeCtx({
      multiline: (term) =>
        res(term === 'house cleaning' ? multiline(flatThenRecent(10, 40)) : multiline(NO_DATA_TERM)),
    });
    const r = expectOk(await c.collect(ctx));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.meta.term).toBe('house cleaning');
  });
});

describe('trends collector — what the signal carries', () => {
  it('reports momentum against the recent baseline, because rising beats high', async () => {
    const c = createTrendsCollector(['snow removal']);
    const { ctx } = makeCtx({ multiline: () => res(multiline(flatThenRecent(10, 40))) });
    const r = expectOk(await c.collect(ctx));
    const item = r.items[0]!;

    expect(item.meta.latest).toBe(40);
    expect(item.meta.recentMean).toBe(40);
    expect(item.meta.baselineMean).toBe(10);
    expect(item.meta.momentum).toBe(4);
    expect(item.meta.direction).toBe('surging');
    expect(item.meta.geo).toBe('CA-ON');
    expect(item.meta.weeksWithData).toBe(52);
    expect(item.title).toContain('snow removal');
    expect(item.title).toContain('surging');
  });

  it('calls a fall a fall, and a flat series steady', async () => {
    const c = createTrendsCollector(['moving help']);
    const falling = expectOk(
      await c.collect(makeCtx({ multiline: () => res(multiline(flatThenRecent(80, 20))) }).ctx),
    );
    expect(falling.items[0]!.meta.direction).toBe('falling');

    const steady = expectOk(
      await c.collect(makeCtx({ multiline: () => res(multiline(flatThenRecent(50, 50))) }).ctx),
    );
    expect(steady.items[0]!.meta.direction).toBe('steady');
  });

  it('calls a term waking from zero surging rather than dividing by it', async () => {
    // The snow-removal case exactly: the 12-month median in CA-ON is 0, so a
    // ratio against the year's typical week is either 0 or infinity.
    const c = createTrendsCollector(['snow removal']);
    const { ctx } = makeCtx({ multiline: () => res(multiline(seasonalWake())) });
    const r = expectOk(await c.collect(ctx));
    expect(r.items[0]!.meta.direction).toBe('surging');
    expect(r.items[0]!.meta.momentum).toBeNull();
    expect(r.items[0]!.body).toContain('from zero');
  });

  it('excludes the partial current week, which always looks like a collapse', async () => {
    const c = createTrendsCollector(['house cleaning']);
    const { ctx } = makeCtx({ multiline: () => res(multiline(flatThenRecent(10, 40))) });
    const r = expectOk(await c.collect(ctx));
    // The partial week carries value 1; the reading must be the last COMPLETE one.
    expect(r.items[0]!.meta.latest).toBe(40);
    expect(r.items[0]!.meta.weeksTotal).toBe(52);
    // 2026-08-24 is week 51 of a window starting 2025-09-01.
    expect(r.items[0]!.publishedAt).toBe('2026-08-24T00:00:00.000Z');
    expect(r.items[0]!.meta.week).toBe('2026-08-24');
  });

  it('gives every term a distinct, week-stamped id and url so the T0 gate keeps both', async () => {
    const c = createTrendsCollector(['snow removal', 'house cleaning']);
    const r = expectOk(await c.collect(makeCtx({}).ctx));
    const [a, b] = r.items;
    expect(a!.externalId).toBe('trends:CA-ON:snow removal:2026-08-24');
    expect(new Set([a!.externalId, b!.externalId]).size).toBe(2);
    expect(new Set([a!.url, b!.url]).size).toBe(2);
    // The url is the human verification link, and it pins the same window.
    expect(a!.url).toContain('https://trends.google.com/trends/explore?');
    expect(a!.url).toContain('geo=CA-ON');
    expect(a!.url).toContain('2025-08-31%202026-08-31');
  });

  it('says in the body that the scale is relative, so nothing downstream calls it searches', async () => {
    const c = createTrendsCollector(['handyman']);
    const r = expectOk(await c.collect(makeCtx({}).ctx));
    expect(r.items[0]!.body).toContain('not a count of searches');
    expect(r.items[0]!.body).toContain('relative');
  });

  it('leaves the numbers intact through the PII strip', async () => {
    // `stripPii` redacts phone-shaped digit runs. Every field in this signal is
    // a number; a corrupted one is worse than a missing one.
    const c = createTrendsCollector(['lawn care']);
    const { ctx } = makeCtx({ multiline: () => res(multiline(flatThenRecent(12, 34))) });
    const r = expectOk(await c.collect(ctx));
    expect(r.items[0]!.body).not.toContain('[phone]');
    expect(r.items[0]!.body).toContain('34');
  });
});

describe('trends collector — the cursor', () => {
  it('re-reading the same week emits nothing rather than the same reading again', async () => {
    const c = createTrendsCollector(['snow removal']);
    const { ctx, calls } = makeCtx({}, { cursor: '2026-08-24' });
    const r = expectOk(await c.collect(ctx));
    expect(r.items).toEqual([]);
    expect(r.notModified).toBeUndefined();
    // We still had to fetch to learn that, so the crawl happened.
    expect(calls.length).toBeGreaterThan(0);
  });

  it('advances the cursor to the newest complete week it emitted', async () => {
    const c = createTrendsCollector(['snow removal']);
    const r = expectOk(await c.collect(makeCtx({}, { cursor: '2026-08-17' }).ctx));
    expect(r.items).toHaveLength(1);
    expect(r.cursor).toBe('2026-08-24');
  });
});

describe('trends collector — broken must never look quiet', () => {
  it('valid JSON with no widgets array is a parse failure', async () => {
    const c = createTrendsCollector(['snow removal']);
    const body = EXPLORE_PREFIX + JSON.stringify({ message: 'quota exceeded' });
    expect(expectFail(await c.collect(makeCtx({ explore: () => res(body) }).ctx)).reason).toBe('parse');
  });

  it('widgets without a TIMESERIES entry is a parse failure', async () => {
    const c = createTrendsCollector(['snow removal']);
    const body = EXPLORE_PREFIX + JSON.stringify({ widgets: [{ id: 'GEO_MAP', token: 't', request: {} }] });
    const r = expectFail(await c.collect(makeCtx({ explore: () => res(body) }).ctx));
    expect(r.reason).toBe('parse');
    expect(r.detail).toContain('TIMESERIES');
  });

  it('widgetdata without a timelineData array is a parse failure, not an empty term', async () => {
    const c = createTrendsCollector(['snow removal']);
    const body = MULTILINE_PREFIX + JSON.stringify({ default: {} });
    expect(expectFail(await c.collect(makeCtx({ multiline: () => res(body) }).ctx)).reason).toBe('parse');
  });

  it('a term that breaks does not hide a term that worked', async () => {
    const c = createTrendsCollector(['broken term', 'house cleaning']);
    const { ctx } = makeCtx({
      explore: (term) => (term === 'broken term' ? res('garbage') : res(explore(term))),
    });
    const r = expectOk(await c.collect(ctx));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.meta.term).toBe('house cleaning');
  });

  it('but if every term breaks, the run is a failure and not an empty source', async () => {
    const c = createTrendsCollector(['a', 'b']);
    const r = expectFail(await c.collect(makeCtx({ explore: () => res('garbage') }).ctx));
    expect(r.reason).toBe('parse');
  });
});

describe('trends collector — HTTP failures', () => {
  it('maps 429 to rate_limited and STOPS, rather than hammering the limiter', async () => {
    const c = createTrendsCollector(['a', 'b', 'c']);
    const { ctx, calls } = makeCtx({ explore: () => res('', 429) });
    const r = expectFail(await c.collect(ctx));
    expect(r.reason).toBe('rate_limited');
    expect(r.retryable).toBe(true);
    // seed + exactly one explore. The other two terms are never requested.
    expect(calls).toHaveLength(2);
  });

  it('maps 403 to auth and stops — Google has decided we are a bot', async () => {
    const c = createTrendsCollector(['a', 'b']);
    const { ctx, calls } = makeCtx({ explore: () => res('', 403) });
    const r = expectFail(await c.collect(ctx));
    expect(r.reason).toBe('auth');
    expect(r.retryable).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('maps a 5xx to network', async () => {
    const c = createTrendsCollector(['a']);
    const r = expectFail(await c.collect(makeCtx({ multiline: () => res('', 503) }).ctx));
    expect(r.reason).toBe('network');
    expect(r.detail).toContain('503');
  });

  it('maps a thrown transport error to network', async () => {
    const c = createTrendsCollector(['a']);
    const { ctx } = makeCtx({ seed: () => Promise.reject(new Error('socket hang up')) });
    const r = expectFail(await c.collect(ctx));
    expect(r.reason).toBe('network');
    expect(r.detail).toContain('socket hang up');
  });

  it('a seed that sets no cookie is not fatal on its own — the status codes decide', async () => {
    const c = createTrendsCollector(['snow removal']);
    const { ctx, calls } = makeCtx({ seed: seedOk(null) });
    const r = expectOk(await c.collect(ctx));
    expect(r.items).toHaveLength(1);
    expect(calls[1]!.headers?.Cookie).toBeUndefined();
  });
});

describe('trends collector — policy and configuration', () => {
  it('refuses a banned base host before any fetch happens', async () => {
    const c = createTrendsCollector(['snow removal'], 'trends via x', {
      base: 'https://x.com',
    });
    const { ctx, calls } = makeCtx({});
    const r = expectFail(await c.collect(ctx));
    expect(r.reason).toBe('blocked_by_policy');
    expect(r.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('is not configured without terms and fails cleanly rather than fetching', async () => {
    const c = createTrendsCollector(['  ', '']);
    expect(c.isConfigured({})).toBe(false);
    const { ctx, calls } = makeCtx({});
    expect(expectFail(await c.collect(ctx)).reason).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });

  it('is configured with terms and needs no credential', () => {
    expect(createTrendsCollector(['snow removal']).isConfigured({})).toBe(true);
  });

  it('de-duplicates terms and caps how many it will ask for in one pass', async () => {
    const c = createTrendsCollector(['a', 'a', 'b', 'c'], undefined, { maxTerms: 2 });
    const { ctx, calls } = makeCtx({});
    expectOk(await c.collect(ctx));
    // seed + 2 terms × 2 requests.
    expect(calls).toHaveLength(5);
  });
});
