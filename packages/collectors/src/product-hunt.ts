/**
 * Product Hunt — GraphQL v2 (`https://api.producthunt.com/v2/api/graphql`).
 *
 * A free, credentialed, fully licensed source: a developer token, an official
 * API, no scraping and no robots.txt question. It is the cheapest early read on
 * "who is launching next to us", which is why it is in the free tier.
 *
 * ── POST ───────────────────────────────────────────────────────────────────
 * `ctx.fetchText` is the ONLY I/O primitive a collector may use — it is what
 * makes every test keyless and offline. GraphQL needs a method and a body, and
 * both are named fields on its `init` argument.
 *
 * The token never appears in a URL, only in the `authorization` header, so it
 * cannot leak into a log line or a cache key.
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

export const PRODUCT_HUNT_ENDPOINT = 'https://api.producthunt.com/v2/api/graphql';

/** How far back we look on a cold start — one day, then the cursor takes over. */
const COLD_START_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const TOPICS_PER_POST = 5;

const QUERY = `query TmosRecentPosts($postedAfter: DateTime, $first: Int!) {
  posts(order: NEWEST, postedAfter: $postedAfter, first: $first) {
    edges {
      cursor
      node {
        id
        name
        tagline
        description
        url
        createdAt
        votesCount
        topics(first: ${TOPICS_PER_POST}) { edges { node { name } } }
      }
    }
    pageInfo { endCursor hasNextPage }
  }
}`;

/* ── Narrowing helpers ──────────────────────────────────────────────────────
 * Hand-rolled and total, because `noUncheckedIndexedAccess` is on and because
 * a collector that guesses at a shape is exactly the failure this contract
 * exists to prevent. Anything unexpected becomes `fail('parse')`, never [].
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function topicNames(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const edges = raw['edges'];
  if (!Array.isArray(edges)) return [];
  const names: string[] = [];
  for (const edge of edges) {
    const node = isRecord(edge) ? edge['node'] : undefined;
    const name = isRecord(node) ? str(node['name']) : null;
    if (name) names.push(name);
  }
  return names;
}

type Failure = Extract<CollectResult, { ok: false }>;

/** HTTP status → the four outcomes the scheduler treats differently. */
function classifyStatus(status: number, body: string): Failure | null {
  if (status >= 200 && status < 300) return null;
  const snippet = body.slice(0, 300);
  if (status === 401 || status === 403) {
    return fail('auth', `HTTP ${status} — Product Hunt rejected the token: ${snippet}`, false);
  }
  if (status === 429) return fail('rate_limited', `HTTP ${status}: ${snippet}`, true);
  // 5xx is worth another attempt; a 4xx we did not name is our bug, not theirs.
  return fail('network', `HTTP ${status}: ${snippet}`, status >= 500);
}

/** GraphQL returns 200 with an `errors` array. Zero items would be a lie here. */
function classifyGraphqlErrors(errors: unknown[]): Failure {
  const message = errors
    .map((e) =>
      isRecord(e) && typeof e['message'] === 'string' ? e['message'] : JSON.stringify(e),
    )
    .join('; ');
  if (/rate limit|throttl|too many requests/i.test(message)) {
    return fail('rate_limited', `graphql: ${message}`, true);
  }
  if (/unauthor|unauthenticat|invalid token|forbidden/i.test(message)) {
    return fail('auth', `graphql: ${message}`, false);
  }
  // A document-level error is deterministic — the same query fails identically
  // next run — so retrying only burns quota. Not retryable.
  return fail('parse', `graphql error: ${message}`, false);
}

function defaultEnv(): Record<string, string | undefined> {
  return typeof process === 'undefined' ? {} : process.env;
}

/**
 * @param env  Bind the SAME env you pass to `isConfigured` — `collect` has no
 *             env parameter of its own, by contract.
 * @param endpoint  Overridable so the policy gate is testable.
 */
export function createProductHuntCollector(
  env: Record<string, string | undefined> = defaultEnv(),
  endpoint: string = PRODUCT_HUNT_ENDPOINT,
): Collector {
  const token = () => (env['PRODUCT_HUNT_TOKEN'] ?? '').trim();

  return {
    kind: 'product_hunt',
    name: 'Product Hunt (GraphQL v2)',

    isConfigured(e) {
      return (e['PRODUCT_HUNT_TOKEN'] ?? '').trim().length > 0;
    },

    async collect(ctx: CollectorContext): Promise<CollectResult> {
      const bearer = token();
      if (!bearer) {
        return fail('not_configured', 'PRODUCT_HUNT_TOKEN is not set — skipping the source', false);
      }

      const verdict = checkHost(endpoint);
      if (!verdict.allowed) return fail('blocked_by_policy', verdict.reason, false);

      const postedAfter =
        ctx.cursor ?? new Date(ctx.now().getTime() - COLD_START_WINDOW_MS).toISOString();

      let response: FetchTextResult;
      try {
        response = await ctx.fetchText(
          endpoint,
          {
            authorization: `Bearer ${bearer}`,
            accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
          },
          {
            method: 'POST',
            body: JSON.stringify({ query: QUERY, variables: { postedAfter, first: PAGE_SIZE } }),
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

      const errors = json['errors'];
      if (Array.isArray(errors) && errors.length > 0) return classifyGraphqlErrors(errors);

      const data = json['data'];
      const posts = isRecord(data) ? data['posts'] : undefined;
      if (!isRecord(posts)) return fail('parse', 'response had no data.posts object', false);
      const edges = posts['edges'];
      if (!Array.isArray(edges)) return fail('parse', 'data.posts.edges was not an array', false);

      const items: RawItem[] = [];
      let newest: string | null = null;

      for (const edge of edges) {
        const node = isRecord(edge) ? edge['node'] : undefined;
        if (!isRecord(node)) continue;
        const id = str(node['id']);
        if (!id) continue; // no stable id ⇒ no idempotency ⇒ we do not store it

        const createdAt = isoOrNull(node['createdAt']);
        if (createdAt && (newest === null || createdAt > newest)) newest = createdAt;

        const tagline = str(node['tagline']);
        const description = str(node['description']);
        const votes = node['votesCount'];
        const text = [tagline, description].filter((s): s is string => s !== null).join('\n\n');

        items.push({
          externalId: id,
          url: str(node['url']),
          // A published product name is not personal information, and mangling
          // it would break entity resolution downstream. The free text is what
          // gets stripped.
          title: str(node['name']),
          body: stripPii(text),
          publishedAt: createdAt,
          meta: {
            votesCount: typeof votes === 'number' ? votes : null,
            topics: topicNames(node['topics']),
            tagline,
          },
        });
      }

      // A quiet run keeps the watermark where it was rather than skipping ahead
      // over a window we never actually saw.
      return ok(items, { cursor: newest ?? postedAfter });
    },
  };
}

/** Bound to `process.env` for the pipeline; use the factory in tests. */
export const productHunt: Collector = createProductHuntCollector();
