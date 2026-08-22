/**
 * Hacker News collector, via the Algolia search API.
 *
 * Free, keyless, explicitly public, and covered by an API rather than scraping
 * — which is the whole point after the Reddit §1201 rulings: where an official
 * API exists we use it and never touch the HTML.
 *
 * We keep the score and comment count (aggregate signal) and deliberately drop
 * the author handle (a person).
 */

import { checkHost, stripPii, USER_AGENT } from './policy.js';
import { fail, notModified, ok } from './types.js';
import type { Collector, CollectorContext, CollectResult, FetchTextResult } from './types.js';
import type { RawItem } from './types.js';

const DEFAULT_ENDPOINT = 'https://hn.algolia.com/api/v1/search_by_date';
const DEFAULT_HITS_PER_PAGE = 50;
const ITEM_BASE = 'https://news.ycombinator.com/item?id=';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HN story text is escaped HTML; we store the flattened text only. */
function plainText(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
      const e = ent.toLowerCase();
      const code = e.startsWith('#x')
        ? Number.parseInt(e.slice(2), 16)
        : e.startsWith('#')
          ? Number.parseInt(e.slice(1), 10)
          : Number.NaN;
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff)
        return String.fromCodePoint(code);
      return ENTITIES[e] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface HnCollectorOptions {
  /** Overridable so the endpoint itself is policy-checked and testable. */
  endpoint?: string;
  hitsPerPage?: number;
  /**
   * How far back a COLD start looks, in days. Only used when there is no cursor.
   *
   * `search_by_date` returns the newest matches, which sounds like it bounds
   * itself and does not: for a narrow query the newest fifty stories can reach
   * back a decade, and they did — the first real run ingested Hacker News posts
   * from 2009 and triage scored a 2012 acquisition as a live competitor move.
   */
  lookbackDays?: number;
}

const DEFAULT_LOOKBACK_DAYS = 120;

export function createHnCollector(
  query: string,
  name?: string,
  opts: HnCollectorOptions = {},
): Collector {
  const q = query.trim();
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const hitsPerPage = opts.hitsPerPage ?? DEFAULT_HITS_PER_PAGE;
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  return {
    kind: 'hn',
    name: name ?? `hn:${q || 'unconfigured'}`,
    isConfigured: () => q.length > 0,

    async collect(ctx: CollectorContext): Promise<CollectResult> {
      if (!q) return fail('not_configured', 'no hn query supplied', false);

      // ── THE CURSOR, WHICH THIS COLLECTOR USED TO IGNORE ──────────────────
      //
      // `ctx.cursor` arrived and was never read, and no cursor was ever
      // returned, so every run refetched the same fifty stories for all time.
      // The outbox's idempotency key meant nothing was double-WRITTEN, so the
      // waste was invisible — the cost was paid at the most expensive layer, and
      // a decade of history was re-presented as new on every pass.
      //
      // The cursor is the newest `created_at_i` we have seen. Absent one, fall
      // back to a bounded window rather than all of history.
      const floorFromLookback = Math.floor(Date.now() / 1000) - lookbackDays * 86_400;
      const fromCursor = Number.parseInt(ctx.cursor ?? '', 10);
      const since = Number.isFinite(fromCursor) && fromCursor > 0 ? fromCursor : floorFromLookback;

      const url =
        `${endpoint}?tags=story&query=${encodeURIComponent(q)}&hitsPerPage=${hitsPerPage}` +
        `&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`;
      const verdict = checkHost(url);
      if (!verdict.allowed) return fail('blocked_by_policy', verdict.reason, false);

      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      };
      if (ctx.etag) headers['If-None-Match'] = ctx.etag;

      let res: FetchTextResult;
      try {
        res = await ctx.fetchText(url, headers);
      } catch (err) {
        return fail('network', `fetch failed for ${endpoint}: ${messageOf(err)}`);
      }

      const etag = headerOf(res.headers, 'etag') ?? ctx.etag;
      if (res.status === 304) return notModified(etag);
      if (res.status === 429) return fail('rate_limited', 'hn algolia returned 429');
      if (res.status === 401 || res.status === 403) {
        return fail('auth', `hn algolia returned ${res.status}`, false);
      }
      if (res.status < 200 || res.status >= 300) {
        return fail('network', `hn algolia returned HTTP ${res.status}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body) as unknown;
      } catch (err) {
        return fail('parse', `hn response was not json: ${messageOf(err)}`);
      }
      const hits = isRecord(parsed) ? parsed.hits : undefined;
      if (!Array.isArray(hits)) {
        return fail('parse', 'hn response has no hits array — treating as broken, not empty');
      }

      const items: RawItem[] = [];
      let newest = since;
      for (const raw of hits) {
        if (!isRecord(raw)) continue;
        const objectId = str(raw.objectID);
        if (!objectId) continue;

        const discussion = `${ITEM_BASE}${objectId}`;
        const outbound = str(raw.url);
        // Never store a link to a host we are not allowed to touch.
        const link = outbound && checkHost(outbound).allowed ? outbound : discussion;
        const title = plainText(str(raw.title));

        const createdAtI = num(raw.created_at_i);
        if (createdAtI !== null && createdAtI > newest) newest = createdAtI;

        items.push({
          externalId: objectId,
          url: link,
          title: title ? stripPii(title) : null,
          body: stripPii(plainText(str(raw.story_text))),
          publishedAt: toIso(str(raw.created_at)),
          meta: {
            points: num(raw.points),
            num_comments: num(raw.num_comments),
            hnUrl: discussion,
          },
        });
      }

      const advanced = items.length > 0 && newest > since;
      return ok(items, {
        ...(etag ? { etag } : {}),
        ...(advanced ? { cursor: String(newest) } : {}),
      });
    },
  };
}
