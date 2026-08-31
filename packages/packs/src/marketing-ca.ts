/**
 * MARKETING · CANADA — the pack the whole system was built around, now declared
 * rather than scattered.
 *
 * Nothing in this file is new. Every source, question, competitor and page was
 * already in `apps/worker`, spread across `watchlist.ts`, `measures.ts` and
 * `watch.ts`, and the comments that come with them are carried over verbatim
 * because they are the record of why each one is here — the two measures
 * demoted after they drifted, the homepage that flattens to twenty-nine
 * characters, and the trade feed removed once its robots.txt refusal stopped
 * being a proof and started being noise on an operator's list.
 *
 * What IS new is that this is now the only file that has to change to point the
 * system at a different market, which is the claim Part 10 makes and which was
 * unfalsifiable while these lived in the worker.
 */
import {
  createGdeltCollector,
  createHnCollector,
  createRssCollector,
  createTrendsCollector,
} from '@tmos/collectors';
import { GTA_CORRIDOR, DEFAULT_COMPETITORS } from '@tmos/reason';

import {
  UNSTATED,
  type DomainPack,
  type Measure,
  type PackSource,
  type SeasonWindow,
  type WatchTarget,
} from './types.js';

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

/**
 * THE TERMS. They live here because a pack answers WHERE we look; the collector
 * answers HOW. Swapping a market means swapping this list and the geo, and
 * nothing in `packages/collectors` moves.
 *
 * Split in two because they are two different questions, not one list cut in
 * half. The seasonal set is asked to catch a window OPENING while there is
 * still lead time to recruit for it; the core set is asked whether the demand
 * we already serve is moving under us. A single source would have had to pick
 * one question, and `PackSource.question` is the field that would have had to
 * lie.
 *
 * Every term below was run against the live endpoint on 2026-08-31 before being
 * registered, because a term Google has no data for is a source that reports
 * nothing forever and looks healthy doing it. Weeks-with-data out of 52, as
 * measured: snow removal 52, lawn care 52, eavestrough cleaning 34, moving help
 * 52, house cleaning 52, handyman 52, furniture assembly 27, tv mounting 49 —
 * all clear of the collector's coverage floor of 8, `furniture assembly` by the
 * least. `eavestrough` is the Canadian word and is deliberately not `gutter`.
 */
const SEASONAL_TERMS = [
  'snow removal',
  'lawn care',
  'eavestrough cleaning',
  'moving help',
] as const;

const CORE_TERMS = [
  'house cleaning',
  'handyman',
  'furniture assembly',
  'tv mounting',
] as const;

/**
 * HIRING — the roadmap leak, and the two measure kinds it forces apart.
 *
 * Two forecasts have sat open in the prediction ledger with nothing observing
 * them: "Jiffy lists at least 3 engineering roles" and "Jiffy lists a growth or
 * performance-marketing role". Both are COUNTS, and a count is the one thing
 * this system has proven it cannot publish — `service_categories_count` read 4,
 * then 5, then 4, on a page nobody edited. So the counts below are `measured`:
 * computed off a machine-readable board with no model in the loop, recorded
 * every run, and never published, because no span on any document contains the
 * number 6 and L0 is right to refuse a claim that says it.
 *
 * The catalogue is the measure that CAN publish. A change in the SET of role
 * titles is real, and "Taskrabbit's job board now lists "Staff Machine Learning
 * Engineer"" is a sentence whose every value came off a board line — the claim
 * and its proof are the same words. `apps/worker/src/careers.ts` writes it, the
 * same way the sitemap catalogue publishes and the sitemap count does not.
 *
 * These predicates are filled by that reader, not by a model, which is why
 * every one of them is `measured` and why the questions read "(computed)".
 */
const CAREERS_BOARD: readonly Measure[] = [
  {
    predicate: 'careers_role_catalogue',
    datatype: 'text',
    unit: null,
    question: '(computed) the sorted list of distinct role titles the board lists',
    answer: 'measured',
  },
  {
    predicate: 'careers_role_count',
    datatype: 'num',
    unit: 'count',
    question: '(computed) how many distinct roles the board lists',
    answer: 'measured',
  },
  {
    // The series the "at least 3 engineering roles" forecast is resolved
    // against. Recorded weekly; a forecast reads history, a Finding cannot.
    predicate: 'careers_engineering_role_count',
    datatype: 'num',
    unit: 'count',
    question: '(computed) how many of those titles match the engineering rule',
    answer: 'measured',
  },
  {
    predicate: 'careers_growth_role_count',
    datatype: 'num',
    unit: 'count',
    question: '(computed) how many of those titles match the growth/paid-marketing rule',
    answer: 'measured',
  },
  {
    // Local ops headcount precedes local marketing spend — the one count here
    // that is about OUR corridor rather than about their roadmap.
    predicate: 'careers_canada_role_count',
    datatype: 'num',
    unit: 'count',
    question: '(computed) how many roles name Canada or a Canadian city',
    answer: 'measured',
  },
];

/**
 * A CAREERS PAGE WITH NO BOARD BEHIND IT.
 *
 * Jiffy's `/careers` is server-rendered and allowed, and it lists no roles at
 * all: it delegates to an AngelList embed backed by
 * `wellfound.com/job_profiles/embed`, and Wellfound's robots.txt carries a
 * literal `Disallow: /job_profiles/embed`. The gate refuses it, correctly, so
 * their role LIST is not observable by us and no catalogue measure can exist
 * here. What is left is what the page itself states, and the honest way to ask
 * it is BOUNDED — "is there a named opening on this page, yes or no" cannot
 * drift by a word, so a difference between two runs is a difference on the page.
 *
 * That is the whole taxonomy in one target: the count the forecast wants is
 * unpublishable, and the yes/no underneath it is publishable and is the thing
 * that actually changes when a company starts hiring.
 *
 * TWO FAILURE MODES TO KNOW ABOUT.
 * The page flattens to ~426 characters — barely over `readPage`'s 400-character
 * floor. One nav change and it reads as unreadable rather than as empty, and
 * the difference will not be obvious in the log.
 * And if it ever does fall through, the renderer would execute the page's own
 * AngelList embed, which fetches the Wellfound path robots.txt disallows. We do
 * not request that URL and a browser running a page's own scripts is the page's
 * behaviour rather than ours, but it is worth knowing before anyone points the
 * renderer at a careers page on purpose.
 */
const CAREERS_PAGE: readonly Measure[] = [
  {
    predicate: 'careers_page_lists_openings',
    datatype: 'text',
    unit: null,
    question:
      'Does this page itself list one or more specific named job openings — a job title someone could apply to? Answer exactly yes, no, or unstated.',
    answer: 'bounded',
    allowed: YES_NO,
  },
  {
    // The publishable form of "Jiffy lists at least 3 engineering roles". The
    // count cannot be cited; the boolean underneath it can, and the flip from
    // no to yes is the event the forecast is actually about.
    predicate: 'careers_page_names_engineering_role',
    datatype: 'text',
    unit: null,
    question:
      'Does the page name an engineering, developer or other technical role? Answer exactly yes, no, or unstated.',
    answer: 'bounded',
    allowed: YES_NO,
  },
  {
    predicate: 'careers_page_names_growth_role',
    datatype: 'text',
    unit: null,
    question:
      'Does the page name a growth, performance-marketing or paid-acquisition role? Answer exactly yes, no, or unstated.',
    answer: 'bounded',
    allowed: YES_NO,
  },
  {
    // Quoted, so the answer must appear in the span cited for it. A company
    // that swaps "we are always looking for talented people" for "we are not
    // hiring right now" has told us something, in its own words.
    predicate: 'careers_hiring_statement',
    datatype: 'text',
    unit: null,
    question:
      'Quote, exactly as written, the single sentence on the page that says whether they are hiring. If the page has no such sentence, answer unstated.',
    answer: 'quoted',
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
  /**
   * ── REMOVED 2026-08-31: `rss:hpac-magazine` — https://www.hpacmag.com/feed/
   *
   * HPAC is the Canadian heating/plumbing/air-conditioning trade press and on
   * relevance alone it was the best source on this list. **Its robots.txt
   * disallows `/feed/`, `/*feed/*` and `/*rss/*`.** So we do not read it.
   *
   * THAT PART IS NOT NEGOTIABLE AND NOTHING BELOW REOPENS IT. A host that says
   * no has said no; there is no workaround on the table and none was
   * considered — not a different user-agent, not a render service, not the
   * sitemap, not "just this one path". The hard gate in
   * `packages/collectors/src/policy.ts` is the promise, and a promise with an
   * exception for the source we happen to want most is not a promise.
   *
   * WHAT CHANGED IS ONLY WHETHER WE KEEP ASKING. The row was kept as a live
   * canary — the one entry proving on every pass, against the real web rather
   * than a fixture, that the gate refuses before the request. It cost 7
   * refusals over 9 days (`source` table, 2026-08-30: `consecutive_failures` 7,
   * `last_ok_at` null — it has never once returned an item) and a
   * `blocked_by_policy` line in every report. With source health now surfaced
   * to a human, that line lands on a list of sources needing attention, where
   * it would sit forever with nothing anyone could ever do about it. **A
   * permanent entry on an attention list is how an operator learns to skim the
   * list**, which is the same argument `ingest.ts` makes for not reporting the
   * competitor watcher's rows as orphans — a report that cries wolf on every
   * run is one nobody reads to the bottom of.
   *
   * The canary is not lost. The gate is still proven by
   * `policy.test.ts`/`transport.test.ts` on every CI run; by
   * `gdelt:home-services-toronto`, refused live and fail-closed while
   * `api.gdeltproject.org` serves no robots.txt; and by `packages/research`,
   * which is refused by Reddit and Facebook on essentially every question it
   * asks. Live proof of the gate is abundant; this row was not carrying it
   * alone.
   *
   * ITS `source` ROW IS DELIBERATELY LEFT IN THE DATABASE. `ingest.ts` reports
   * a registered source with no watchlist entry as an `orphan`, so removing it
   * here is recorded rather than silent, and the console still shows its last
   * refusal. Dropping the row would erase the evidence of why it went.
   *
   * TO RESTORE IT: re-read https://www.hpacmag.com/robots.txt. If `/feed/` is
   * no longer disallowed, put the entry back exactly as it was — the feed URL
   * and name are above, and the `source` row is still there to collect into.
   */
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
    /**
     * SEARCH DEMAND, WHICH IS THE ONLY SOURCE HERE THAT CANNOT GO STALE.
     *
     * News was measured over four runs and failed: roughly half the signals
     * were more than a year old and materiality was near zero. This reads the
     * week that just closed, every time, and it reads the thing this business
     * actually turns on — a GTA marketplace whose demand is weather- and
     * calendar-driven. It is also the only source that OBSERVES an open
     * prediction: the ledger already carries a forecast that resolves against
     * Google Trends interest in snow removal, and until now nothing watched it.
     *
     * Paired with `calendar` below, which is where the lead time lives. The
     * calendar says the snow window opens in November and needs eight weeks of
     * warning; this says whether the search behaviour agrees, and when.
     */
    collector: createTrendsCollector([...SEASONAL_TERMS], 'trends:gta-seasonal'),
    tier: 'primary',
    region: 'ca',
    question:
      'Is a weather- or calendar-driven demand window in Ontario opening earlier or later than the calendar assumes, while there is still lead time to recruit for it?',
  },
  {
    collector: createTrendsCollector([...CORE_TERMS], 'trends:gta-core'),
    tier: 'primary',
    region: 'ca',
    question:
      'Which of the everyday task categories we already serve is search demand in Ontario actually moving on, up or down?',
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
  {
    /**
     * The JSON board, not the careers page.
     *
     * `www.taskrabbit.com/careers` is assembled in the browser and its roles
     * arrive from Greenhouse. Greenhouse serves the same board as JSON for
     * machines, and `boards-api.greenhouse.io/robots.txt` disallows only
     * `/embed/`. Verified through this repo's transport on 2026-08-31: 200,
     * `application/json`, 17 postings with titles and locations.
     *
     * Reading the API rather than the page removes the model from the loop
     * entirely — which is the whole reason the sitemap reader exists, applied
     * to the one other document a competitor publishes for machines.
     *
     * Same `domain` as the services target ON PURPOSE: the domain is the hard
     * identity key, so these facts land on the TaskRabbit entity we already
     * hold rather than opening a second one. Two documents, one company.
     */
    company: 'TaskRabbit',
    domain: 'taskrabbit.ca',
    url: 'https://boards-api.greenhouse.io/v1/boards/taskrabbit/jobs',
    reading_for: 'Which roles they are hiring for, where those roles are based, and what that says about what they intend to ship next.',
    measures: CAREERS_BOARD,
  },
  {
    /**
     * Readable, allowed, and empty — which is itself the reading.
     *
     * Handy is NOT here for the opposite reason: `www.handy.com/careers`
     * redirects into `angi.com` and answers a Cloudflare 403. A target we
     * cannot fetch contributes nothing, so it is not declared. Unlike the HPAC
     * canary above, this is not a robots refusal worth proving — a 403 from a
     * bot wall teaches us nothing about the gate.
     */
    company: 'Jiffy',
    domain: 'jiffyondemand.com',
    url: 'https://jiffyondemand.com/careers',
    reading_for: 'Whether they have started hiring again, and for what — the page names no roles today.',
    measures: CAREERS_PAGE,
  },
];

const SEASONS: readonly SeasonWindow[] = [
  {
    name: 'snow removal and winter maintenance',
    startsMonth: 11, endsMonth: 3, leadWeeks: 8,
    why: 'The GTA winter is the one season where demand is weather-triggered and supply must already exist. A crew recruited in December is a crew that missed November.',
  },
  {
    name: 'spring cleaning and yard reset',
    startsMonth: 3, endsMonth: 5, leadWeeks: 4,
    why: 'The largest recurring cleaning spike of the year, and the entry point most first-time posters use.',
  },
  {
    name: 'moving season',
    startsMonth: 5, endsMonth: 9, leadWeeks: 4,
    why: 'Toronto leases turn over heavily on 1 May and 1 July. Moving help, furniture assembly and junk removal move together.',
  },
  {
    name: 'lawn, garden and outdoor work',
    startsMonth: 5, endsMonth: 9, leadWeeks: 3,
    why: 'Long, steady and low-urgency — the window that rewards being listed rather than being fast.',
  },
  {
    name: 'back to school and student moves',
    startsMonth: 8, endsMonth: 9, leadWeeks: 5,
    why: 'A concentrated student influx across the GTA campuses, buying small moves, assembly and cleaning in the same fortnight.',
  },
  {
    name: 'holiday preparation and hosting',
    startsMonth: 11, endsMonth: 12, leadWeeks: 5,
    why: 'Deep cleaning, light installation and decorating, compressed into weeks and highly deadline-driven.',
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
  /**
   * The GTA year, as a marketplace experiences it.
   *
   * `leadWeeks` is the number that earns this its place. Every one of these
   * windows is obvious the week it opens and useless by then — supply has to
   * be recruited before demand arrives, and the whole point of putting a
   * calendar in front of a reasoner is that it can say "eight weeks out" while
   * there is still time to act.
   */
  calendar: SEASONS,
};
