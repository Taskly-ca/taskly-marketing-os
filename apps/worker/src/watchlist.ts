/**
 * WHAT THE ENGINE LOOKS AT — the source registry, as data.
 *
 * `source` (migration 001) has no column for a feed URL or a query string, so a
 * row in that table cannot say what it points at; it can only carry
 * `(kind, name)` plus collection state. The locator therefore lives here, and
 * `(kind, name)` is the join key between this list and the table. That is a
 * gap, not a design — see the report for the `source.config jsonb` that would
 * let a DomainPack (Part 10) add a feed without a deploy.
 *
 * ── HOW THESE FOUR RSS ENTRIES WERE CHOSEN ──────────────────────────────────
 *
 * `apps/smoke/src/watchlist.ts` proposes four Google News RSS queries and calls
 * them "the highest-value free source for this market". They are not
 * collectable. `news.google.com/robots.txt` is `Disallow: /` for `*` with
 * allows only for `/$`, `/home`, `/topics/`, `/publications/`, `/stories/`,
 * `/swg/` and `/about` — `/rss/search` is not among them. robots.txt is a hard
 * gate in this system, so every one of those queries is refused before a byte
 * moves. Verified against the live file, 2026-08-22. Nothing here routes around
 * it; the smoke watchlist simply cannot go on a schedule as written.
 *
 * What replaced them was picked on three criteria, in this order: robots.txt
 * permits the feed path; the publisher's own terms do not forbid commercial
 * reading (which ruled out two otherwise-perfect GTA feeds whose robots.txt
 * carries an explicit no-data-mining notice); and the feed answers a question
 * this business actually has.
 */
import {
  createGdeltCollector,
  createHnCollector,
  createRssCollector,
  credentialedCollectors,
  type Collector,
} from '@tmos/collectors';
import type { Region } from '@tmos/contracts';

/** `source.tier` — the rubric dimension that stops an agent preferring a farm. */
export type SourceTier = 'first_party' | 'primary' | 'trade' | 'aggregator' | 'farm';

export interface WatchEntry {
  readonly collector: Collector;
  readonly tier: SourceTier;
  readonly region: Region;
  /** The question this source is FOR — not the terms it uses. */
  readonly question: string;
}

const KEYLESS: WatchEntry[] = [
  {
    collector: createRssCollector('https://globalnews.ca/toronto/feed/', 'rss:globalnews-toronto'),
    tier: 'aggregator',
    region: 'ca',
    question: 'Is anything moving in the GTA that a home-services marketplace would respond to?',
  },
  {
    collector: createRssCollector('https://financialpost.com/feed', 'rss:financial-post'),
    tier: 'aggregator',
    region: 'ca',
    question: 'Is the Canadian consumer-spending and housing picture shifting under us?',
  },
  {
    collector: createRssCollector('https://betakit.com/feed/', 'rss:betakit'),
    tier: 'trade',
    region: 'ca',
    question: 'Has a Canadian marketplace competitor raised, launched, pivoted or died?',
  },
  {
    /**
     * THE CANARY, AND IT IS SUPPOSED TO FAIL.
     *
     * HPAC is the Canadian heating/plumbing/air-conditioning trade press — on
     * relevance alone it is the best source on this list. Its robots.txt
     * disallows `/feed/`, `/*feed/*` and `/*rss/*`. It stays in the registry
     * precisely because it is the one entry that proves, on every single pass
     * against the live web rather than against a fixture, that the hard gate is
     * a gate: it is refused before the feed is requested, and the refusal is
     * recorded as `blocked_by_policy` rather than as a network error.
     *
     * Delete this row if the noise is not worth the proof; the DELETE is in the
     * report. Do NOT "fix" it by fetching anyway.
     */
    collector: createRssCollector('https://www.hpacmag.com/feed/', 'rss:hpac-magazine'),
    tier: 'trade',
    region: 'ca',
    question: 'What is the plumbing/HVAC trade itself saying? (robots.txt canary — expected to be refused)',
  },
  {
    collector: createHnCollector('home services marketplace', 'hn:home-services-marketplace'),
    tier: 'aggregator',
    region: 'global',
    question: 'Is anyone building, funding or writing post-mortems on this exact model?',
  },
  {
    collector: createHnCollector('gig economy', 'hn:gig-economy'),
    tier: 'aggregator',
    region: 'global',
    question: 'Is the ground shifting under two-sided labour marketplaces?',
  },
  {
    collector: createGdeltCollector('"home services" Toronto', 'gdelt:home-services-toronto'),
    tier: 'aggregator',
    region: 'ca',
    question: 'Worldwide coverage breadth on the GTA home-services market.',
  },
];

/**
 * Tier and region for the credentialed collectors, keyed by `Collector.kind`.
 *
 * They are not listed above because `credentialedCollectors(env)` constructs
 * them — the registry must not build a second, divergent copy — but a `source`
 * row still needs a tier and a region, and neither is on the `Collector`
 * interface. First-party by definition: Search Console is our own data and
 * Product Hunt is a launch registry read through its own API.
 */
const CREDENTIALED_META: Record<string, { tier: SourceTier; region: Region; question: string }> = {
  gsc: {
    tier: 'first_party',
    region: 'ca',
    question: 'What is search actually sending us, and for what?',
  },
  product_hunt: {
    tier: 'primary',
    region: 'global',
    question: 'Has a competitor or an adjacent tool launched?',
  },
};

const FALLBACK_META = { tier: 'aggregator' as const, region: 'global' as const, question: 'unclassified source' };

/**
 * The whole registry for one run.
 *
 * The credentialed half is bound to `env` here and nowhere else, so a missing
 * key is decided in exactly one place. It is NOT filtered here: an unconfigured
 * source must be reported as skipped, and a list that quietly omitted it would
 * make a missing credential indistinguishable from a source nobody added.
 */
export function watchlist(env: Record<string, string | undefined>): WatchEntry[] {
  const credentialed = credentialedCollectors(env).map((collector) => {
    const meta = CREDENTIALED_META[collector.kind] ?? FALLBACK_META;
    return { collector, tier: meta.tier, region: meta.region, question: meta.question };
  });
  return [...KEYLESS, ...credentialed];
}
