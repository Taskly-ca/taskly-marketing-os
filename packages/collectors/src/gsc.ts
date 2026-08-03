/**
 * Google Search Console — Search Analytics (`searchAnalytics.query`).
 *
 * THE ONE SOURCE WITH GENUINE GROUND TRUTH. Every other collector in this
 * package reports what the world *says*: a launch post, a headline, a feed
 * item. This one reports what actually happened on our own property —
 * impressions Google really served and clicks a human really made, measured by
 * the party that served them. It is first-party, licensed to us, and it is the
 * only stream a prediction can be resolved against without an inference step.
 * Treat a conflict between GSC and any other source as GSC being right.
 *
 * Two consequences worth keeping in mind:
 *   • The data lags. Google finalises Search Analytics roughly 2–3 days behind
 *     "today", so we read a window that ENDS three days back. Reading fresher
 *     than that returns partial rows that later change underneath us — which
 *     looks exactly like a trend and is not one.
 *   • `dataState: 'final'` is deliberate for the same reason. Fresh data is
 *     available; it is also mutable, and a detector fed mutable counts fires on
 *     Google's backfill rather than on the world.
 *
 * ── POST ───────────────────────────────────────────────────────────────────
 * searchAnalytics.query is POST-with-a-body, passed via the `init` argument of
 * `ctx.fetchText`. The OAuth access token travels in `authorization`, never in
 * the URL, so it cannot leak into a log line or a cache key.
 */

import { checkHost, stripPii, USER_AGENT } from './policy.js';
import { fail, ok } from './types.js';
import type {
  Collector,
  CollectorContext,
  CollectResult,
  FetchTextResult,
  RawItem,
} from './types.js';

export const GSC_API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';

/** Google finalises Search Analytics ~2–3 days back; we read behind that line. */
const REPORTING_LAG_DAYS = 3;
/** Inclusive window length on a cold start, in days. */
const WINDOW_DAYS = 7;
const ROW_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `sc-domain:taskly.ca` and `https://taskly.ca/` are both legal site ids, and
 *  both contain characters that must not survive into the path unencoded. */
export function gscQueryUrl(base: string, siteUrl: string): string {
  return `${base.replace(/\/+$/, '')}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

/* ── Narrowing helpers ───────────────────────────────────────────────────── */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const dayString = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);

type Failure = Extract<CollectResult, { ok: false }>;

function classifyStatus(status: number, body: string): Failure | null {
  if (status >= 200 && status < 300) return null;
  const snippet = body.slice(0, 300);
  if (status === 401 || status === 403) {
    // An expired OAuth token and a property we were never granted look the
    // same here. Both need a human, so neither is retryable.
    return fail('auth', `HTTP ${status} — Search Console rejected the token: ${snippet}`, false);
  }
  if (status === 429) return fail('rate_limited', `HTTP ${status}: ${snippet}`, true);
  return fail('network', `HTTP ${status}: ${snippet}`, status >= 500);
}

function defaultEnv(): Record<string, string | undefined> {
  return typeof process === 'undefined' ? {} : process.env;
}

/**
 * @param env  Bind the SAME env you pass to `isConfigured` — `collect` has no
 *             env parameter of its own, by contract.
 * @param apiBase  Overridable so the policy gate is testable.
 */
export function createGscCollector(
  env: Record<string, string | undefined> = defaultEnv(),
  apiBase: string = GSC_API_BASE,
): Collector {
  const credentials = () => ({
    token: (env['GSC_ACCESS_TOKEN'] ?? '').trim(),
    site: (env['GSC_SITE_URL'] ?? '').trim(),
  });

  return {
    kind: 'gsc',
    name: 'Google Search Console (Search Analytics)',

    isConfigured(e) {
      const hasToken = (e['GSC_ACCESS_TOKEN'] ?? '').trim().length > 0;
      const hasSite = (e['GSC_SITE_URL'] ?? '').trim().length > 0;
      return hasToken && hasSite;
    },

    async collect(ctx: CollectorContext): Promise<CollectResult> {
      const { token, site } = credentials();
      if (!token || !site) {
        return fail(
          'not_configured',
          'GSC_ACCESS_TOKEN and GSC_SITE_URL are both required — skipping the source',
          false,
        );
      }

      const url = gscQueryUrl(apiBase, site);
      const verdict = checkHost(url);
      if (!verdict.allowed) return fail('blocked_by_policy', verdict.reason, false);

      const end = addDays(ctx.now(), -REPORTING_LAG_DAYS);
      const endDate = dayString(end);
      const startDate =
        ctx.cursor && DAY_RE.test(ctx.cursor)
          ? ctx.cursor
          : dayString(addDays(end, -(WINDOW_DAYS - 1)));

      // Caught up already: nothing has finalised since the last run. Genuinely
      // zero rows, not a failure — and no request spent finding that out.
      if (startDate > endDate) return ok([], { cursor: startDate });

      let response: FetchTextResult;
      try {
        response = await ctx.fetchText(
          url,
          {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
          },
          {
            method: 'POST',
            body: JSON.stringify({
              startDate,
              endDate,
              dimensions: ['query', 'page'],
              type: 'web',
              dataState: 'final',
              rowLimit: ROW_LIMIT,
            }),
          },
        );
      } catch (e) {
        return fail('network', `fetch threw: ${messageOf(e)}`, true);
      }

      const httpFailure = classifyStatus(response.status, response.body);
      if (httpFailure) return httpFailure;

      let json: unknown;
      try {
        json = JSON.parse(response.body);
      } catch (e) {
        return fail('parse', `response was not JSON: ${messageOf(e)}`, false);
      }
      if (!isRecord(json)) return fail('parse', 'response was not a JSON object', false);

      // A property with no traffic in the window omits `rows` entirely. That is
      // an honest zero; a `rows` of the wrong type is us misreading the API.
      const rows = json['rows'];
      if (rows === undefined) return ok([], { cursor: dayString(addDays(end, 1)) });
      if (!Array.isArray(rows)) return fail('parse', 'rows was present but not an array', false);

      const items: RawItem[] = [];
      const publishedAt = `${endDate}T00:00:00.000Z`;

      for (const row of rows) {
        if (!isRecord(row)) continue;
        const rawKeys = row['keys'];
        const keys = Array.isArray(rawKeys) ? rawKeys : [];
        const rawQuery = keys[0];
        if (typeof rawQuery !== 'string' || rawQuery.length === 0) continue;
        const page = typeof keys[1] === 'string' && keys[1].length > 0 ? keys[1] : null;

        // The query is the only operator-supplied text in a GSC row, and people
        // do type email addresses and phone numbers into Google. Strip it. The
        // page and the metrics are ours — running stripPii over a URL would
        // mangle date-like path segments into "[phone]".
        const query = stripPii(rawQuery);

        const clicks = num(row['clicks']);
        const impressions = num(row['impressions']);
        const ctr = num(row['ctr']);
        const position = num(row['position']);

        const where = page ? ` on ${page}` : '';
        const body =
          `"${query}"${where} — ${clicks} clicks, ${impressions} impressions, ` +
          `${(ctr * 100).toFixed(2)}% CTR, avg position ${position.toFixed(1)} ` +
          `(${startDate} to ${endDate})`;

        // Query+page is the natural key, stamped with the window so that the
        // same term next week is a new observation rather than an overwrite —
        // the detectors need the series, not the latest value.
        const rowKey = page === null ? query : `${query}|${page}`;

        items.push({
          externalId: `${rowKey}@${startDate}`,
          url: page,
          title: query,
          body,
          publishedAt,
          meta: { clicks, impressions, ctr, position, query, page, startDate, endDate },
        });
      }

      return ok(items, { cursor: dayString(addDays(end, 1)) });
    },
  };
}

/** Bound to `process.env` for the pipeline; use the factory in tests. */
export const gsc: Collector = createGscCollector();
