/**
 * THE FETCH PATH — where `packages/collectors/src/policy.ts` stops being a
 * module and starts being a gate.
 *
 * Every rule enforced here comes from that file and none is re-implemented:
 * `checkHost` (the never-scrape list), `parseRobots` + `robotsAllows`
 * (robots.txt as a HARD gate, including on every redirect hop),
 * `effectiveDelayMs` (the stricter of their Crawl-delay and our 2s floor),
 * `USER_AGENT` (honest, with a contact address), `MAX_CONCURRENT_PER_HOST`.
 *
 * WHY THIS IS NOT `createResolverFetchers`. `@tmos/adapters` already ships a
 * policy-enforcing fetcher with exactly this shape, and it was the first thing
 * tried. It cannot serve a collector, for three reasons that are all about the
 * CONDITIONAL GET the collectors were built around:
 *
 *   its signature is `fetchText(url) => Promise<string>` — there is no way to
 *   send `If-None-Match`, which is the entire mechanism;
 *   it returns a string — there is no way to read the `ETag` back, so the next
 *   cursor could never be captured;
 *   it THROWS on any non-2xx — so a 304, the cheapest and most desirable
 *   outcome in the system, would arrive as an error.
 *
 * The right fix is to generalise that fetcher and have both callers use it;
 * that is a change to `packages/adapters`, which this task does not own. It is
 * in the report as the duplication it is.
 *
 * ── HOW A POLICY REFUSAL GETS ITS REAL NAME ─────────────────────────────────
 *
 * A collector calls `ctx.fetchText` inside its own try/catch and turns any
 * throw into `fail('network', …)`. So a robots.txt refusal thrown from here
 * would reach the runner labelled a network error — and "the site forbids this"
 * would be recorded, and retried, as "the network hiccuped". Rather than invent
 * a status code the collectors would misread anyway, denials are RECORDED here
 * and drained by the runner, which relabels a failed collection as
 * `blocked_by_policy` when one is present. The refusal itself is still a throw,
 * so a collector that ignored the result would still not get the bytes.
 */
import {
  MAX_CONCURRENT_PER_HOST,
  USER_AGENT,
  checkHost,
  effectiveDelayMs,
  hostOf,
  parseRobots,
  robotsAllows,
  type CollectorContext,
  type FetchTextResult,
  type RobotsRules,
} from '@tmos/collectors';

export type FetchText = CollectorContext['fetchText'];

/** The subset of `fetch` this module uses. Injected so tests need no network. */
export type FetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect: 'manual';
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null; forEach(fn: (value: string, key: string) => void): void };
  text(): Promise<string>;
}>;

interface TransportOptions {
  readonly fetchImpl?: FetchImpl;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface Transport {
  readonly fetchText: FetchText;
  /** Policy refusals since the last drain, newest last. Draining clears them. */
  drainDenials(): string[];
  /** Requests actually put on the wire, robots.txt included. The crawl budget. */
  requestCount(): number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** A feed is text. Anything past this is a mistake or an attack, not a feed. */
const DEFAULT_MAX_BYTES = 8_000_000;
/** http → https → canonical is three; more is a loop we should not follow. */
const MAX_REDIRECTS = 3;

/** `parseRobots('')` is the "no rules" value — an allow-everything ruleset. */
const NO_RULES: RobotsRules = parseRobots('');

class PolicyDenied extends Error {}

export function createTransport(options: TransportOptions = {}): Transport {
  const doFetch: FetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const denials: string[] = [];
  let requests = 0;

  /** One in-flight request per host. A queue of one is a promise chain, which is
   *  also why MAX_CONCURRENT_PER_HOST is asserted rather than parameterised. */
  const queues = new Map<string, Promise<unknown>>();
  const lastRequestAt = new Map<string, number>();
  const robotsByHost = new Map<string, RobotsRules>();

  function enqueue<T>(host: string, run: () => Promise<T>): Promise<T> {
    const prior = queues.get(host) ?? Promise.resolve();
    // `.then(run, run)`: a failed request must not wedge the host forever.
    const next = prior.then(run, run);
    queues.set(
      host,
      next.catch(() => undefined),
    );
    return next;
  }

  function deny(reason: string): never {
    denials.push(reason);
    throw new PolicyDenied(reason);
  }

  /** The only place bytes move. Waits out the host's interval first, always. */
  async function send(
    url: string,
    host: string,
    delayMs: number,
    headers: Record<string, string>,
    method: 'GET' | 'POST',
    body?: string,
  ): Promise<FetchTextResult> {
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = last + delayMs - clock();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, clock());
    requests += 1;

    const response = await doFetch(url, {
      method,
      // The honest UA is forced here rather than trusted from the caller: it is
      // a legal position, not a preference, and a collector that forgot it must
      // not be able to make an anonymous request through this transport.
      headers: { ...headers, 'user-agent': USER_AGENT },
      ...(body === undefined ? {} : { body }),
      // Manual: `follow` would hide a hop into a banned host or a disallowed
      // path. Every hop is re-checked below.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    if (text.length > maxBytes) {
      throw new Error(`body from ${url} exceeds ${maxBytes} bytes (${text.length})`);
    }

    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return { status: response.status, body: text, headers: out };
  }

  /**
   * robots.txt, once per host per run, as a HARD gate.
   *
   * RFC 9309 §2.3.1: 4xx means there is no file to obey and the host is open;
   * 5xx or unreachable means the rules are UNKNOWN, and unknown is refused
   * rather than assumed permissive — "we could not read the rules" is not
   * "there are no rules". A parse failure is impossible by construction:
   * `parseRobots` cannot throw and returns an empty ruleset for garbage.
   */
  async function robotsFor(host: string, origin: string): Promise<RobotsRules> {
    const cached = robotsByHost.get(host);
    if (cached !== undefined) return cached;

    // The first request to a host has no Crawl-delay to honour yet, so it uses
    // our own floor; every later one uses the stricter of the two.
    let res: FetchTextResult;
    try {
      res = await send(`${origin}/robots.txt`, host, effectiveDelayMs(null), { accept: 'text/plain' }, 'GET');
    } catch (error) {
      deny(`robots.txt for ${host} is unreachable (${error instanceof Error ? error.message : String(error)})`);
    }

    // A redirected robots.txt is followed to its destination by re-entering
    // here only if it stays on the same host; cross-host is treated as absent,
    // which is what a crawler that cannot verify the rules should assume ONLY
    // when the response was itself a 3xx to elsewhere. Simpler and stricter:
    // anything that is not 2xx and not 4xx is a refusal.
    if (res.status >= 400 && res.status < 500) {
      robotsByHost.set(host, NO_RULES);
      return NO_RULES;
    }
    if (res.status < 200 || res.status >= 300) {
      deny(`robots.txt for ${host} is unreadable (HTTP ${res.status})`);
    }

    const rules = parseRobots(res.body);
    robotsByHost.set(host, rules);
    return rules;
  }

  async function hop(
    url: string,
    headers: Record<string, string>,
    method: 'GET' | 'POST',
    body?: string,
  ): Promise<FetchTextResult> {
    const allowed = checkHost(url);
    if (!allowed.allowed) deny(`${url}: ${allowed.reason}`);
    // `checkHost` already refused anything `new URL` cannot parse.
    const host = hostOf(url);
    const origin = new URL(url).origin;

    return enqueue(host, async () => {
      const rules = await robotsFor(host, origin);
      const verdict = robotsAllows(rules, url);
      if (!verdict.allowed) deny(`${url}: ${verdict.reason}`);
      return send(url, host, effectiveDelayMs(rules), headers, method, body);
    });
  }

  const fetchText: FetchText = async (url, headers = {}, init = {}) => {
    if (MAX_CONCURRENT_PER_HOST !== 1) {
      throw new Error('transport assumes MAX_CONCURRENT_PER_HOST === 1 (promise-chain queue)');
    }
    const method = init.method ?? 'GET';

    let target = url;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const res = await hop(target, headers, method, init.body);
      const location = res.headers.location;
      // A 304 is not a redirect even though it is 3xx, and it has no Location.
      if (res.status >= 300 && res.status < 400 && res.status !== 304 && location !== undefined) {
        target = new URL(location, target).toString();
        continue;
      }
      return res;
    }
    throw new Error(`too many redirects (> ${MAX_REDIRECTS}) starting at ${url}`);
  };

  return {
    fetchText,
    drainDenials: () => denials.splice(0, denials.length),
    requestCount: () => requests,
  };
}
