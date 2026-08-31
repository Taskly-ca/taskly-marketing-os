/**
 * Google Trends — search interest for a set of terms, in one region, weekly.
 *
 * WHY THIS SOURCE EXISTS. News has been measured and it has failed: four runs,
 * roughly half the signals more than a year old, near-zero materiality. Demand
 * for the work this marketplace sells is weather- and calendar-driven, the
 * draft already reasons over a season calendar, and the prediction ledger
 * already carries a forecast that resolves against Google Trends — and until
 * now nothing in the system observed it. This is the one source whose reading
 * is never stale by construction: it is always the week that just closed.
 *
 * ── THE ENDPOINT, AND HONESTLY: IT IS FRAGILE ──────────────────────────────
 *
 * There is NO free official API. What exists is the undocumented JSON that the
 * trends.google.com front-end calls, and using it is a three-request dance.
 * Verified against the live endpoint on 2026-08-31; the transcript:
 *
 *   0. GET /trends/                             → 200, Set-Cookie: NID=534=…
 *   1. GET /trends/api/explore?req={…}          → 200, body starts `)]}'\n`
 *        → widgets[], one per chart; we want id === 'TIMESERIES', for its
 *          short-lived `token` and the exact `request` object to echo back
 *   2. GET /trends/api/widgetdata/multiline?req={…}&token=…
 *                                               → 200, body starts `)]}',\n`
 *        → default.timelineData[]: { time, value[], hasData[], isPartial? }
 *
 * Four things about that are worth writing down because each one is a way this
 * collector dies, and each one dies LOUDLY here rather than quietly:
 *
 *   • THE COOKIE IS THE GATE. The identical explore request with no cookie
 *     answered HTTP 429 on the first attempt, from a cold IP. That is not rate
 *     limiting, it is a bot check wearing a 429. Hence request 0, whose only
 *     purpose is to be handed an NID cookie, paid once per pass.
 *   • THE PREFIX IS NOT DECORATION. `)]}'` is Google's anti-JSON-hijacking
 *     guard, and the two endpoints do not agree on it — explore sends `)]}'`,
 *     multiline sends `)]}',`. A body that does not carry one is not this API,
 *     so its absence is a `parse` failure and never an empty reading.
 *   • THE TOKEN IS SINGLE-USE-ISH and belongs to the exact `request` object
 *     explore returned. We echo that object back verbatim rather than rebuild
 *     it, because a token bound to a request we reconstructed is a 400 that
 *     looks like a bug in our query.
 *   • NONE OF THIS IS PROMISED TO US. Google can change or gate it in a week.
 *     Every failure mode above lands as `{ok:false, reason}` — `parse` if the
 *     shape moved, `rate_limited` if we are being throttled, `auth` if we have
 *     been identified and refused. It never lands as "the source was quiet."
 *
 * robots.txt was checked before any of this: trends.google.com disallows
 * exactly `/explore?` and `/trends/explore?`, and nothing under `/trends/api/`.
 * Every request still goes through `ctx.fetchText`, so the gate, the honest UA
 * and the 2s-per-host floor apply — which is also why this collector is slow by
 * design: two requests per term, serialised behind one host.
 *
 * ── WHAT THE 0–100 NUMBER IS, AND THE TRAP IN IT ───────────────────────────
 *
 * It is NOT a count of searches. It is the series renormalised so that its own
 * maximum, in this region and this window, is 100 — which means a term with no
 * volume at all still comes back with a 100 in it. Measured, same session:
 * `zqxjkwv plumbing gutter` in CA-ON returned 1 week with data out of 53, and a
 * peak of 100. A collector that reads `value` and ignores `hasData` therefore
 * publishes pure noise as the strongest signal on the board. So coverage is
 * checked first, and a series thinner than MIN_WEEKS_WITH_DATA is reported as
 * having nothing to say — which is a real reading, not an error.
 *
 * ── ONE REQUEST PER TERM, DELIBERATELY ─────────────────────────────────────
 *
 * `comparisonItem` accepts up to five keywords in a single request and it is
 * tempting — one fifth of the crawl budget. It is also wrong: comparing terms
 * renormalises them AGAINST EACH OTHER, so the biggest term pins to 100 and
 * every other term is expressed as a fraction of it. The ledger's open forecast
 * is about one term's own scale ("interest for 'snow removal toronto' exceeds
 * 50"), and a comparison request cannot answer it. Terms are asked separately.
 */

import { checkHost, hostOf, stripPii, USER_AGENT } from './policy.js';
import { fail, ok } from './types.js';
import type { Collector, CollectorContext, CollectResult, FetchTextResult } from './types.js';
import type { RawItem } from './types.js';

const DEFAULT_BASE = 'https://trends.google.com';
/** Ontario. This is a GTA marketplace; a worldwide reading answers no question
 *  we have. Google's finest free resolution here is the province. */
const DEFAULT_GEO = 'CA-ON';
/** Twelve months of WEEKLY points. Shorter windows switch Google to daily
 *  resolution, which is noisier than the seasonal question deserves. */
const DEFAULT_TIMEFRAME = 'today 12-m';
const DEFAULT_HL = 'en-US';
/** Minutes west of UTC, Google's convention. 240 = Toronto on daylight time. */
const DEFAULT_TZ = 240;

/** Two requests per term behind a 2s host floor — the budget, not a hard limit. */
const DEFAULT_MAX_TERMS = 8;

/**
 * The coverage floor, from the measurement in the header.
 *
 * `zqxjkwv plumbing gutter` scored 1 week with data; `snow removal toronto` —
 * a genuinely seasonal, genuinely low-volume real term whose 12-month MEDIAN in
 * CA-ON is literally 0 — scored 20. Eight sits between them with room on both
 * sides, and is the number to move if a real term starts being dropped.
 */
const MIN_WEEKS_WITH_DATA = 8;

/** "Now" and "the normal it is moving against". Four weeks is short enough to
 *  turn inside a season's lead time; twelve is long enough not to be noise. */
const RECENT_WEEKS = 4;
const BASELINE_WEEKS = 12;

/** Google's anti-JSON-hijacking prefix. explore sends `)]}'`; multiline `)]}',`. */
const XSSI_PREFIX_RE = /^\)\]\}'[,\s]*/;

/** The Set-Cookie pair that actually unlocks the API. */
const NID_RE = /(?:^|[;,\s])(NID=[^;,\s]+)/;

export type TrendDirection = 'surging' | 'rising' | 'steady' | 'falling' | 'dormant' | 'unknown';

export interface TrendsCollectorOptions {
  /** Overridable so the base itself is policy-checked and testable. */
  base?: string;
  /** Google geo code. `CA-ON` = Ontario, `CA` = Canada, `''` = worldwide. */
  geo?: string;
  timeframe?: string;
  hl?: string;
  tz?: number;
  maxTerms?: number;
  minWeeksWithData?: number;
}

/* ── small helpers, same shape as the other collectors ──────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** `)]}'`-guarded JSON. A missing guard means we are not talking to this API. */
function parseGuarded(body: string, what: string): { value: unknown } | { detail: string } {
  if (!XSSI_PREFIX_RE.test(body)) {
    return { detail: `${what} did not carry the )]}' prefix — not a trends api response` };
  }
  try {
    return { value: JSON.parse(body.replace(XSSI_PREFIX_RE, '')) as unknown };
  } catch (err) {
    return { detail: `${what} was not json behind the prefix: ${messageOf(err)}` };
  }
}

/* ── the timeline ───────────────────────────────────────────────────────── */

interface Week {
  /** ISO date of the week's first day. */
  readonly week: string;
  readonly value: number;
  readonly hasData: boolean;
}

const isoWeek = (unixSeconds: number): string =>
  new Date(unixSeconds * 1_000).toISOString().slice(0, 10);

/**
 * timelineData → complete weeks only.
 *
 * `isPartial` marks the week currently in progress. It is always the last
 * point, it is always low because the week is not over, and including it makes
 * every single reading look like demand just collapsed. Dropped, always.
 */
function toWeeks(timeline: readonly unknown[]): Week[] {
  const out: Week[] = [];
  for (const raw of timeline) {
    if (!isRecord(raw)) continue;
    if (raw.isPartial === true) continue;
    const seconds = Number.parseInt(str(raw.time), 10);
    if (!Number.isFinite(seconds)) continue;
    const value = Array.isArray(raw.value) ? raw.value[0] : undefined;
    const hasData = Array.isArray(raw.hasData) ? raw.hasData[0] : undefined;
    out.push({
      week: isoWeek(seconds),
      value: typeof value === 'number' && Number.isFinite(value) ? value : 0,
      hasData: hasData === true,
    });
  }
  return out;
}

interface Reading {
  readonly week: string;
  readonly latest: number;
  readonly recentMean: number;
  readonly baselineMean: number;
  /** recent ÷ baseline. `null` when the baseline is zero — see `direction`. */
  readonly momentum: number | null;
  readonly direction: TrendDirection;
  readonly peak: number;
  readonly peakWeek: string;
  readonly percentOfPeak: number;
  readonly weeksTotal: number;
  readonly weeksWithData: number;
}

/**
 * The shape of the number that makes this actionable.
 *
 * A HIGH reading is not news — "house cleaning is searched for in Ontario" was
 * true last year too. A reading that has MOVED is news, and it is only useful
 * before the window opens, which is what the pack's `leadWeeks` is for. So the
 * headline number is the last four weeks against the twelve before them.
 *
 * The baseline is NOT the year's median, which was the first attempt and is
 * wrong for exactly the terms this exists to catch: `snow removal toronto` has
 * a 12-month median of 0 in CA-ON (33 of 53 weeks read zero), so a ratio
 * against it is either zero or a division by zero all year. A term waking from
 * a dormant baseline is the strongest signal this source can produce, and it is
 * named rather than computed.
 */
function readSeries(weeks: readonly Week[]): Reading {
  const values = weeks.map((w) => w.value);
  const last = weeks[weeks.length - 1]!;

  const recent = values.slice(-RECENT_WEEKS);
  const baseline = values.slice(-(RECENT_WEEKS + BASELINE_WEEKS), -RECENT_WEEKS);
  const recentMean = round(mean(recent), 1);
  const baselineMean = round(mean(baseline), 1);

  let momentum: number | null = null;
  let direction: TrendDirection;
  if (baseline.length < BASELINE_WEEKS) {
    // Too short a history to say anything about movement. Say that, do not guess.
    direction = 'unknown';
  } else if (baselineMean === 0) {
    direction = recentMean > 0 ? 'surging' : 'dormant';
  } else {
    momentum = round(recentMean / baselineMean, 2);
    direction =
      momentum >= 2 ? 'surging' : momentum >= 1.25 ? 'rising' : momentum <= 0.75 ? 'falling' : 'steady';
  }

  let peak = 0;
  let peakWeek = last.week;
  for (const w of weeks) {
    if (w.value > peak) {
      peak = w.value;
      peakWeek = w.week;
    }
  }

  return {
    week: last.week,
    latest: last.value,
    recentMean,
    baselineMean,
    momentum,
    direction,
    peak,
    peakWeek,
    percentOfPeak: peak === 0 ? 0 : round((last.value / peak) * 100, 0),
    weeksTotal: weeks.length,
    weeksWithData: weeks.filter((w) => w.hasData).length,
  };
}

/* ── the item a triage model actually reads ─────────────────────────────── */

/**
 * T1 sees the TITLE and the BODY and nothing else — `meta` is stored, not
 * prompted (see `apps/worker/src/cascade.ts`). So the whole judgement has to be
 * in prose, including the caveat: without the last sentence a downstream model
 * will write "100 searches for snow removal", which is both false and the kind
 * of fabricated statistic the honesty gate exists to keep out of a draft.
 */
function describe(term: string, geo: string, r: Reading, timeframe: string): { title: string; body: string } {
  const movement =
    r.direction === 'surging' && r.momentum === null
      ? 'rising from zero — the term was dormant through the preceding twelve weeks'
      : r.momentum === null
        ? `no movement to report (${r.direction})`
        : `${r.direction}, at ${r.momentum} times the preceding twelve-week mean of ${r.baselineMean}`;

  const title = `Search interest for "${term}" in ${geo} is ${r.direction}: ${r.latest} of 100 in the week of ${r.week}`;

  const body = [
    `Google Trends search interest for "${term}" in ${geo} read ${r.latest} out of 100 for the week beginning ${r.week}.`,
    `The last four weeks average ${r.recentMean}, which is ${movement}.`,
    `Over the ${timeframe} window the peak was ${r.peak}, in the week beginning ${r.peakWeek}, so the current week sits at ${r.percentOfPeak} percent of that peak.`,
    `${r.weeksWithData} of ${r.weeksTotal} complete weeks carried enough volume for Google to report a value.`,
    `The zero to one hundred scale is relative to this term's own maximum in this region and window. It is not a count of searches, and it is not comparable to the scale of any other term.`,
  ].join(' ');

  return { title, body };
}

/* ── the collector ──────────────────────────────────────────────────────── */

/** Terms, cleaned. A pack answers WHERE we look; duplicates are its typo, not
 *  a reason to spend the crawl budget twice. */
function normalizeTerms(terms: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    const term = t.trim().replace(/\s+/g, ' ');
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

/** Non-2xx → the failure it actually is. `null` means the response is usable. */
function statusFailure(status: number, what: string): Extract<CollectResult, { ok: false }> | null {
  if (status === 429) return fail('rate_limited', `${what} returned 429`);
  if (status === 401 || status === 403) return fail('auth', `${what} returned ${status}`, false);
  if (status < 200 || status >= 300) return fail('network', `${what} returned HTTP ${status}`);
  return null;
}

type Failure = Extract<CollectResult, { ok: false }>;

/** A refusal we must not walk past: continuing would mean hammering a limiter
 *  or arguing with a host that has already decided we are a bot. */
const isHardStop = (f: Failure): boolean => f.reason === 'rate_limited' || f.reason === 'auth';

/** Discriminated on purpose: `'failure' in x` does not narrow an optional
 *  property, and the whole point of this file is that a failure is never
 *  silently treated as a response. */
type Got = { got: true; res: FetchTextResult } | { got: false; failure: Failure };

export function createTrendsCollector(
  terms: readonly string[],
  name?: string,
  opts: TrendsCollectorOptions = {},
): Collector {
  const base = (opts.base ?? DEFAULT_BASE).replace(/\/+$/, '');
  const geo = opts.geo ?? DEFAULT_GEO;
  const timeframe = opts.timeframe ?? DEFAULT_TIMEFRAME;
  const hl = opts.hl ?? DEFAULT_HL;
  const tz = opts.tz ?? DEFAULT_TZ;
  const minWeeks = opts.minWeeksWithData ?? MIN_WEEKS_WITH_DATA;
  const wanted = normalizeTerms(terms, opts.maxTerms ?? DEFAULT_MAX_TERMS);

  const seedUrl = `${base}/trends/`;
  const exploreUrl = (term: string): string => {
    const req = JSON.stringify({
      comparisonItem: [{ keyword: term, geo, time: timeframe }],
      category: 0,
      property: '',
    });
    return `${base}/trends/api/explore?hl=${encodeURIComponent(hl)}&tz=${tz}&req=${encodeURIComponent(req)}`;
  };
  const widgetUrl = (request: unknown, token: string): string =>
    `${base}/trends/api/widgetdata/multiline?hl=${encodeURIComponent(hl)}&tz=${tz}` +
    `&req=${encodeURIComponent(JSON.stringify(request))}&token=${encodeURIComponent(token)}`;

  /** The link a human opens to check the claim. Pins the same window, so the
   *  URL differs every week — which is also what keeps the T0 gate from
   *  dropping next week's reading as a duplicate of this one. */
  const humanUrl = (term: string, window: string): string =>
    `${base}/trends/explore?date=${encodeURIComponent(window)}&geo=${encodeURIComponent(geo)}&q=${encodeURIComponent(term)}`;

  return {
    kind: 'trends',
    name: name ?? `trends:${hostOf(base) || 'unconfigured'}:${geo || 'world'}`,
    isConfigured: () => wanted.length > 0,

    async collect(ctx: CollectorContext): Promise<CollectResult> {
      if (wanted.length === 0) return fail('not_configured', 'no trends terms supplied', false);

      const verdict = checkHost(seedUrl);
      if (!verdict.allowed) return fail('blocked_by_policy', verdict.reason, false);

      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
      };

      const get = async (url: string, what: string): Promise<Got> => {
        let res: FetchTextResult;
        try {
          res = await ctx.fetchText(url, headers);
        } catch (err) {
          return { got: false, failure: fail('network', `fetch failed for ${what}: ${messageOf(err)}`) };
        }
        const failure = statusFailure(res.status, what);
        return failure ? { got: false, failure } : { got: true, res };
      };

      // ── 0. the cookie ────────────────────────────────────────────────────
      // Paid once for the whole pass. Without it the API answered 429 to a
      // first-ever request, so this is a bot check, not a rate limit.
      const seed = await get(seedUrl, 'trends seed');
      if (!seed.got) return seed.failure;
      const nid = NID_RE.exec(headerOf(seed.res.headers, 'set-cookie') ?? '')?.[1];
      // Only the NID pair travels back — never the attributes, and never any
      // other cookie Google felt like setting on us.
      if (nid) headers.Cookie = nid;

      const items: RawItem[] = [];
      let newestWeek = ctx.cursor ?? '';
      /** Kept, not thrown: a source that fails on ONE term while answering for
       *  the rest is not a broken source, but a source that fails on all of
       *  them must never be reported as a quiet one. */
      let firstFailure: Failure | null = null;

      for (const term of wanted) {
        const explored = await get(exploreUrl(term), `trends explore (${term})`);
        if (!explored.got) {
          firstFailure ??= explored.failure;
          if (isHardStop(explored.failure)) return explored.failure;
          continue;
        }

        const parsedExplore = parseGuarded(explored.res.body, `trends explore (${term})`);
        if ('detail' in parsedExplore) {
          firstFailure ??= fail('parse', parsedExplore.detail);
          continue;
        }
        const widgets = isRecord(parsedExplore.value) ? parsedExplore.value.widgets : undefined;
        if (!Array.isArray(widgets)) {
          firstFailure ??= fail('parse', `trends explore (${term}) has no widgets array`);
          continue;
        }
        const timeseries = widgets.find((w) => isRecord(w) && w.id === 'TIMESERIES');
        if (!isRecord(timeseries) || !str(timeseries.token)) {
          firstFailure ??= fail('parse', `trends explore (${term}) returned no TIMESERIES widget`);
          continue;
        }

        const widget = await get(widgetUrl(timeseries.request, str(timeseries.token)), `trends widgetdata (${term})`);
        if (!widget.got) {
          firstFailure ??= widget.failure;
          if (isHardStop(widget.failure)) return widget.failure;
          continue;
        }

        const parsedWidget = parseGuarded(widget.res.body, `trends widgetdata (${term})`);
        if ('detail' in parsedWidget) {
          firstFailure ??= fail('parse', parsedWidget.detail);
          continue;
        }
        const root = isRecord(parsedWidget.value) ? parsedWidget.value.default : undefined;
        const timeline = isRecord(root) ? root.timelineData : undefined;
        if (!Array.isArray(timeline)) {
          firstFailure ??= fail('parse', `trends widgetdata (${term}) has no timelineData array`);
          continue;
        }

        // ── empty is not error, from here down ───────────────────────────
        const weeks = toWeeks(timeline);
        if (weeks.length === 0) continue;

        const reading = readSeries(weeks);
        // The renormalisation trap: too little volume to say anything, and
        // Google will still hand us a 100. A real reading of nothing.
        if (reading.weeksWithData < minWeeks) continue;
        // Already read. The week has not turned, so this is the same reading we
        // ingested last pass, not a new one.
        if (ctx.cursor !== undefined && reading.week <= ctx.cursor) continue;

        const window = str(isRecord(timeseries.request) ? timeseries.request.time : '') || timeframe;
        const { title, body } = describe(term, geo, reading, timeframe);
        if (reading.week > newestWeek) newestWeek = reading.week;

        items.push({
          externalId: `trends:${geo}:${term}:${reading.week}`,
          url: humanUrl(term, window),
          title: stripPii(title),
          body: stripPii(body),
          // Always the week that just closed — this source cannot go stale.
          publishedAt: `${reading.week}T00:00:00.000Z`,
          meta: {
            term,
            geo,
            timeframe,
            resolution: 'WEEK',
            week: reading.week,
            latest: reading.latest,
            recentMean: reading.recentMean,
            baselineMean: reading.baselineMean,
            momentum: reading.momentum,
            direction: reading.direction,
            peak: reading.peak,
            peakWeek: reading.peakWeek,
            percentOfPeak: reading.percentOfPeak,
            weeksTotal: reading.weeksTotal,
            weeksWithData: reading.weeksWithData,
            /** The tail, so a later pass can recompute without re-fetching. */
            recentWeeks: weeks.slice(-(RECENT_WEEKS + BASELINE_WEEKS)).map((w) => w.value),
            scale: 'relative_0_100_not_search_volume',
          },
        });
      }

      if (items.length === 0 && firstFailure) return firstFailure;
      return ok(items, items.length > 0 && newestWeek ? { cursor: newestWeek } : {});
    },
  };
}
