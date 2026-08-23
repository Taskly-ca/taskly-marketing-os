/**
 * MARKETING · CANADA — the pack the whole system was built around, now declared
 * rather than scattered.
 *
 * Nothing in this file is new. Every source, question, competitor and page was
 * already in `apps/worker`, spread across `watchlist.ts`, `measures.ts` and
 * `watch.ts`, and the comments that come with them are carried over verbatim
 * because they are the record of why each one is here — the robots.txt canary
 * that is supposed to fail, the two measures demoted after they drifted, the
 * homepage that flattens to twenty-nine characters.
 *
 * What IS new is that this is now the only file that has to change to point the
 * system at a different market, which is the claim Part 10 makes and which was
 * unfalsifiable while these lived in the worker.
 */
import {
  createGdeltCollector,
  createHnCollector,
  createRssCollector,
} from '@tmos/collectors';
import { GTA_CORRIDOR, DEFAULT_COMPETITORS } from '@tmos/reason';

import { UNSTATED, type DomainPack, type Measure, type PackSource, type WatchTarget } from './types.js';

const YES_NO = ['yes', 'no', UNSTATED] as const;

const COMMON: readonly Measure[] = [
  {
    predicate: 'service_categories_count',
    datatype: 'num',
    unit: 'count',
    question: 'How many distinct service categories does this page list? Count them.',
    // Proven to drift on an unchanged page, 2026-08-22. Recorded, never published.
    answer: 'open',
  },
  {
    predicate: 'serves_canada',
    datatype: 'text',
    unit: null,
    question: 'Does the page indicate service in Canada? Answer exactly yes, no, or unstated.',
    answer: 'bounded',
    allowed: YES_NO,
  },
  {
    predicate: 'cities_listed',
    datatype: 'text',
    unit: null,
    question:
      'Which cities does the page name, comma-separated and alphabetised? If none, answer none.',
    // A free list: order, spelling and inclusion all drift. Same class as a count.
    answer: 'open',
  },
  {
    predicate: 'lowest_advertised_price',
    datatype: 'text',
    unit: null,
    question:
      'What is the lowest price the page advertises, with its currency and unit exactly as written? If no price is shown, answer unstated.',
    answer: 'quoted',
  },
  {
    predicate: 'offers_snow_removal',
    datatype: 'text',
    unit: null,
    question: 'Does the page list snow removal? Answer exactly yes, no, or unstated.',
    answer: 'bounded',
    allowed: YES_NO,
  },
  {
    predicate: 'offers_cleaning',
    datatype: 'text',
    unit: null,
    question: 'Does the page list house or home cleaning? Answer exactly yes, no, or unstated.',
    answer: 'bounded',
    allowed: YES_NO,
  },
];

const SOURCES: readonly PackSource[] = [
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

const TARGETS: readonly WatchTarget[] = [
  {
    company: 'TaskRabbit',
    domain: 'taskrabbit.ca',
    url: 'https://www.taskrabbit.ca/services',
    reading_for: 'Which services they offer in Canada, and in which cities.',
    measures: COMMON,
  },
  {
    company: 'Jiffy',
    domain: 'jiffyondemand.com',
    url: 'https://jiffyondemand.com/',
    reading_for: 'Which services they offer, how they price, and which cities they name.',
    measures: COMMON,
    /**
     * The homepage flattens to 29 characters — it is assembled in the browser —
     * so Jiffy contributed nothing at all until this. Their sitemap lists every
     * service they sell as a URL, is server-rendered, and `robots.txt` allows
     * everything except `/admin` and `/jobs/new`. Verified 2026-08-23.
     */
    sitemap: {
      url: 'https://jiffyondemand.com/sitemap.xml',
      prefix: 'https://jiffyondemand.com/service/',
    },
  },
  {
    company: 'Handy',
    domain: 'handy.com',
    url: 'https://www.handy.com/',
    reading_for: 'Whether they serve Canada at all, what they offer, and how they price.',
    measures: COMMON,
  },
];

export const marketingCanada: DomainPack = {
  id: 'marketing-ca',
  region: 'ca',
  /**
   * The sentence a triage model is given.
   *
   * Declarative, not a persona: a persona changes the voice and leaves the
   * criteria unchanged, which is precisely the specification failure that makes
   * a multi-agent system score confidently against the wrong thing.
   */
  subject:
    'Taskly: a home-services task marketplace in the Greater Toronto Area. ' +
    'Customers post a task, Taskers make offers, and the money is held until ' +
    'the customer confirms the work is done.',
  sources: SOURCES,
  targets: TARGETS,
  scoring: { corridor: GTA_CORRIDOR, competitors: DEFAULT_COMPETITORS },
};
