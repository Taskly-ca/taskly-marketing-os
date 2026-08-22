/**
 * `ResolverContext` (packages/intel/src/resolver/types.ts), wired to the real
 * world: one database capability and two fetch capabilities.
 *
 * A resolver decides whether a prediction resolved true or false. Its spec is
 * DATA — a string in a jsonb column, written weeks earlier by a human or an
 * agent — so both capabilities below are built on the assumption that the spec
 * is hostile, and both keep the two rules `kinds.ts` enforces above them:
 *
 *   A MISSING CAPABILITY ANNULS, it never throws. `createResolverContext` can
 *   omit any of them (`{ query: false }`), and the resolvers then return
 *   `{outcome: 'annulled', reason: 'no query capability supplied'}` on their
 *   own. Nothing here fabricates a capability that cannot work.
 *
 *   AMBIGUITY ANNULS. Everything below fails LOUDLY instead of guessing: a
 *   blocked host, a robots.txt disallow, a non-2xx, an oversized body and a
 *   redirect chain all throw, and `httpJsonResolver` / `scrapeAssertResolver`
 *   catch them and annul with the reason attached. An unreachable source is
 *   never a failed prediction.
 *
 * `ctx.query` is the one place in this repository where a STRING reaches the
 * driver. `@tmos/db`'s `sql` tag exists so "the unsafe path does not exist",
 * and that guarantee is structurally unavailable here — the resolver's SQL IS
 * the value. So the boundary has to be somewhere the string cannot argue with:
 * see `createResolverQuery`.
 */
import {
  USER_AGENT,
  checkHost,
  effectiveDelayMs,
  hostOf,
  parseRobots,
  robotsAllows,
  type RobotsRules,
} from '@tmos/collectors';
import { connectFromPool, type Connect } from '@tmos/db';
import type { ResolverContext } from '@tmos/intel';

import { AdapterError, guard } from '../errors.js';

/* ── ctx.query ──────────────────────────────────────────────────────────── */

/**
 * The role `runAnalyticalQuery` was given a boundary with, in migration 006:
 * `select` on the world tables only, and explicitly revoked from `belief`,
 * `prediction`, `decision_record` and `consent` — "an ad-hoc query is
 * exploration, not an audit path". A resolver wants exactly that surface, and
 * a resolver that could read `prediction` could read the answer to its own
 * question.
 *
 * It is NOLOGIN by design: membership is granted out of band to whatever role
 * the connection string authenticates as. If that has not been done, the `set
 * role` below fails with 42501 and every sql resolver annuls loudly — which is
 * the correct direction to fail in. Pass `role: null` to run with the
 * application's own grants and the transaction-level boundary alone.
 */
export const RESOLVER_ROLE = 'tmos_analyst';

/** 006 pins the same 30s on the role itself; role settings apply at LOGIN, not
 *  at `set role`, so it is set again here where it actually takes effect. */
export const RESOLVER_STATEMENT_TIMEOUT_MS = 30_000;

export interface ResolverQueryOptions {
  /** Postgres role assumed for the query. `null` opts out — see the note in
   *  `createResolverQuery` about what that costs. Default: `tmos_analyst`. */
  readonly role?: string | null;
  readonly statementTimeoutMs?: number;
  /** Injection seam for tests, mirroring `withTx`'s `TxDeps.connect`. */
  readonly connect?: Connect;
}

/**
 * Runs a resolver's SQL, and cannot write.
 *
 * WHY NOT THE AMBIENT EXECUTOR. Every other repository in this package takes
 * `ex: Executor = db()` and enlists in the caller's transaction. This one must
 * not, and the reason is specific: the read-only boundary is a property of the
 * TRANSACTION, and Postgres will not let a read-only transaction go back to
 * read/write once a snapshot is taken. Enlisting would therefore leave the
 * caller's transaction read-only for the rest of its life — and the caller is
 * `runDueResolvers`, which writes the resolution immediately afterwards. So
 * this capability checks out its own connection, and the resolver's SQL never
 * touches the connection anything else is using.
 *
 * THE BOUNDARY, in three layers, weakest first:
 *
 *   1. `sqlResolver.parse` rejects anything that is not a single leading
 *      SELECT. It is a regex over a string; parser-level blocklists are
 *      routinely bypassed. Defence in depth and nothing more — and it runs in
 *      `packages/intel`, not here, so this function does not rely on it.
 *   2. `begin read only`. The SERVER refuses every INSERT/UPDATE/DELETE/COPY/
 *      DDL/GRANT in the transaction with SQLSTATE 25006, whatever the text
 *      says, and the transaction is ROLLED BACK either way — nothing a
 *      resolver does can be committed, including by a function it calls.
 *   3. `set role`, which removes the privileges rather than the opportunity.
 *      This is the layer 006 calls "the security boundary"; (2) still permits
 *      READING every table the application can read, and `prediction` is one of
 *      them. Only (3) closes that, and only if membership has been granted.
 *
 * `QueryExecutorPort` in `packages/world` has the same problem and is being
 * solved in parallel by another lane. The two should converge on ONE mechanism
 * — most likely a `withReadOnlyTx` in `@tmos/db` — rather than two hand-rolled
 * transaction blocks; this one deliberately does not reach into that lane's
 * files, and deliberately does not quietly use the privileged pool instead.
 */
export function createResolverQuery(
  options: ResolverQueryOptions = {},
): NonNullable<ResolverContext['query']> {
  const role = options.role === undefined ? RESOLVER_ROLE : options.role;
  const statementTimeoutMs = options.statementTimeoutMs ?? RESOLVER_STATEMENT_TIMEOUT_MS;
  const connect = options.connect ?? connectFromPool;

  return (text: string) =>
    guard('resolverQuery', async () => {
      const client = await connect();
      let broken = false;
      try {
        // The access mode is set BY the statement that opens the transaction,
        // so there is no window in which a write could land before the guard.
        await client.query('begin read only');
        // `set_config(name, value, is_local)` rather than `SET` — a GUC name is
        // an identifier, `SET` cannot take a placeholder, and there is
        // deliberately no `sql.raw` in this repo to reach for. The function
        // form takes both as parameters. `is_local = true` scopes them to this
        // transaction, which is about to be rolled back regardless.
        await client.query('select set_config($1, $2, true)', [
          'statement_timeout',
          String(statementTimeoutMs),
        ]);
        if (role !== null) {
          await client.query('select set_config($1, $2, true)', ['role', role]);
        }
        const result = await client.query(text);
        // node-postgres always yields row objects in its default row mode; the
        // resolver contract is `ReadonlyArray<Record<string, unknown>>`, and
        // `sqlResolver` counts the keys of the first row before reading any.
        return result.rows as ReadonlyArray<Record<string, unknown>>;
      } finally {
        try {
          await client.query('rollback');
        } catch (rollbackError) {
          // Never let cleanup replace the cause. The session is now in an
          // unknown state, so it is destroyed rather than handed to the next
          // borrower — the same rule `withTx` follows.
          broken = true;
          console.error('[@tmos/adapters] resolver ROLLBACK failed:', errorMessage(rollbackError));
        }
        client.release(broken || undefined);
      }
    });
}

/* ── ctx.fetchText / ctx.fetchJson ──────────────────────────────────────── */

/**
 * A resolver fetching a competitor's pricing page is a crawler, and is subject
 * to exactly the rules a collector is — `packages/collectors/src/policy.ts` is
 * "LEGAL POLICY, COMPILED IN", not a second-best guess to be re-implemented
 * here. So this reuses it wholesale: the banned-host list, `TasklyBot/1.0`,
 * robots.txt as a HARD gate including Crawl-delay, and ≤1 request per 2s per
 * host with no concurrency.
 *
 * WHAT IS NOT REUSED, and why: `stripPii` is NOT applied to a fetched body.
 * Collectors strip at ingest because they RETAIN what they fetched; nothing
 * here retains a page — the text lives in one local variable for the duration
 * of one regex match and is then dropped. Stripping first would silently
 * corrupt the match (a phone number redacted to `[phone]` changes a
 * `count:` result, and every date is a phone-shaped digit run). The residual
 * risk is a resolver whose capture group is itself PII, since `observed` IS
 * stored — that lives in the spec, is visible at write-time dry-run, and is not
 * something the transport can fix.
 */
export interface ResolverFetchOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Elapsed-time source for the throttle. Injected so tests need no clock. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** A body this large is a mistake or a tarpit; either way it annuls. */
  readonly maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5_000_000;
/** Each hop is re-checked against the policy, so this is a loop bound, not a
 *  trust decision. Three is what a normal http → https → canonical chain needs. */
const MAX_REDIRECTS = 3;

export interface ResolverFetchers {
  fetchText: (url: string) => Promise<string>;
  fetchJson: (url: string) => Promise<unknown>;
}

export function createResolverFetchers(options: ResolverFetchOptions = {}): ResolverFetchers {
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const clock = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  /** One in-flight request per host (MAX_CONCURRENT_PER_HOST = 1), enforced by
   *  chaining rather than by a semaphore: a queue of one is a promise. */
  const queues = new Map<string, Promise<unknown>>();
  const lastRequestAt = new Map<string, number>();
  const robotsByHost = new Map<string, RobotsRules | null>();

  function enqueue<T>(host: string, run: () => Promise<T>): Promise<T> {
    const prior = queues.get(host) ?? Promise.resolve();
    // `.then(run, run)` — a failed request must not wedge the host forever.
    const next = prior.then(run, run);
    queues.set(
      host,
      next.catch(() => undefined),
    );
    return next;
  }

  /** The only place a request is actually made. Waits out the interval first. */
  async function send(url: string, host: string, delayMs: number, accept: string) {
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = last + delayMs - clock();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, clock());

    const response = await doFetch(url, {
      headers: { 'user-agent': USER_AGENT, accept },
      // Manual: a redirect can cross into a banned host or a disallowed path,
      // and `follow` would make that invisible. Every hop is re-checked.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    if (body.length > maxBytes) {
      throw new AdapterError(`body from ${url} exceeds ${maxBytes} bytes (${body.length})`);
    }
    return { status: response.status, body, location: response.headers.get('location') };
  }

  /**
   * robots.txt, once per host, as a HARD gate. A 4xx means there is no file to
   * obey and the host is open; anything else — 5xx, a network failure — is
   * refused rather than assumed permissive, because "we could not read the
   * rules" is not "there are no rules".
   */
  async function robotsFor(host: string, origin: string): Promise<RobotsRules | null> {
    const cached = robotsByHost.get(host);
    if (cached !== undefined) return cached;

    // ── robots.txt redirects, and a redirect is not a refusal ────────────────
    //
    // RFC 9309 §2.3.1.2 says a client SHOULD follow at least five redirects for
    // robots.txt, and in practice nearly every site needs it: www↔apex and
    // http→https both land here. Treating the 301 as "unreadable" made this gate
    // refuse hosts that were perfectly willing to be crawled — and because it
    // fails CLOSED it looked like good manners rather than a bug. Found when
    // five seed predictions were refused against a competitor whose robots.txt
    // 301s from www to the apex and then answers 200.
    //
    // Each hop is re-gated through `checkHost`, so a redirect cannot be used to
    // walk us onto a banned host.
    let url = `${origin}/robots.txt`;
    let hopHost = host;
    let res = await send(url, hopHost, effectiveDelayMs(null), 'text/plain');

    for (let redirects = 0; redirects < 5; redirects += 1) {
      if (res.status < 300 || res.status >= 400 || !res.location) break;
      const next = new URL(res.location, url);
      const gate = checkHost(next.toString());
      if (!gate.allowed) {
        throw new AdapterError(`blocked by policy: ${gate.reason} (robots.txt redirect)`);
      }
      url = next.toString();
      hopHost = next.hostname;
      res = await send(url, hopHost, effectiveDelayMs(null), 'text/plain');
    }

    if (res.status >= 400 && res.status < 500) {
      robotsByHost.set(host, null);
      return null;
    }
    if (res.status !== 200) {
      throw new AdapterError(`robots.txt for ${host} is unreadable (HTTP ${res.status})`);
    }
    const rules = parseRobots(res.body);
    robotsByHost.set(host, rules);
    return rules;
  }

  async function hop(url: string, accept: string) {
    const gate = checkHost(url);
    if (!gate.allowed) throw new AdapterError(`blocked by policy: ${gate.reason}`);

    const host = hostOf(url);
    const origin = new URL(url).origin;

    return enqueue(host, async () => {
      const rules = await robotsFor(host, origin);
      const verdict = robotsAllows(rules ?? EMPTY_ROBOTS, url);
      if (!verdict.allowed) throw new AdapterError(`blocked by policy: ${verdict.reason}`);
      return send(url, host, effectiveDelayMs(rules), accept);
    });
  }

  async function fetchWithPolicy(startUrl: string, accept: string): Promise<string> {
    let url = startUrl;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const res = await hop(url, accept);
      if (res.status >= 300 && res.status < 400 && res.location !== null) {
        url = new URL(res.location, url).toString();
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new AdapterError(`GET ${url} → HTTP ${res.status}`);
      }
      return res.body;
    }
    throw new AdapterError(`too many redirects from ${startUrl}`);
  }

  return {
    fetchText: (url) => fetchWithPolicy(url, 'text/html,text/plain;q=0.9,*/*;q=0.8'),
    async fetchJson(url) {
      const body = await fetchWithPolicy(url, 'application/json');
      try {
        return JSON.parse(body) as unknown;
      } catch (error) {
        // Annuls upstream, and says so: an HTML error page served with HTTP 200
        // is the commonest way a JSON endpoint "succeeds".
        throw new AdapterError(`${url} did not return JSON: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    },
  };
}

const EMPTY_ROBOTS: RobotsRules = { disallow: [], allow: [], crawlDelayMs: null };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/* ── the context ────────────────────────────────────────────────────────── */

export interface ResolverContextOptions {
  /** `false` omits the capability entirely, and sql resolvers then annul. */
  readonly query?: ResolverQueryOptions | false;
  /** `false` omits BOTH fetch capabilities — http_json and scrape_assert annul. */
  readonly http?: ResolverFetchOptions | false;
  readonly now?: () => Date;
}

/**
 * The context the weekly resolution run is given.
 *
 * A capability that is omitted is ABSENT, not a stub that throws: `kinds.ts`
 * tests `if (!ctx.query)` and annuls with a reason naming the missing
 * capability, which is a far better record than an exception caught by
 * `runDueResolvers` and stored as "resolver threw".
 */
export function createResolverContext(options: ResolverContextOptions = {}): ResolverContext {
  const ctx: ResolverContext = { now: options.now ?? (() => new Date()) };

  if (options.query !== false) ctx.query = createResolverQuery(options.query ?? {});
  if (options.http !== false) {
    const { fetchText, fetchJson } = createResolverFetchers(options.http ?? {});
    ctx.fetchText = fetchText;
    ctx.fetchJson = fetchJson;
  }
  return ctx;
}
