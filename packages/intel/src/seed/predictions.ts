/**
 * The opening question set.
 *
 * Every one of these is (a) about the OBSERVABLE WORLD, so it resolves without
 * any revenue data of ours, and (b) machine-resolvable, so scoring never waits
 * on a human's memory. That combination is what lets the calibration loop start
 * in week one instead of after launch.
 *
 * `p` is deliberately NOT filled in here. A seeded probability would be a
 * fabricated forecast, and a fabricated forecast in the ledger is worse than an
 * empty ledger — it looks like a track record. The founder and the agent each
 * supply their own `p` for the same question, and they are scored separately.
 * That comparison is the point.
 */
import type { ResolverSpec } from '../resolver/types.js';

export interface SeedQuestion {
  key: string;
  claim: string;
  resolve_at: string;
  resolver: ResolverSpec;
  /** Why this question is worth a slot — questions are a scarce resource. */
  rationale: string;
}

const q = (
  key: string,
  claim: string,
  resolve_at: string,
  resolver: ResolverSpec,
  rationale: string,
): SeedQuestion => ({ key, claim, resolve_at, resolver, rationale });

const page = (url: string, spec: string): ResolverSpec => ({
  kind: 'scrape_assert',
  spec,
  source_url: url,
  fallback: 'annul',
});

/**
 * 20 questions across five classes. Question-selection bias is a real trap —
 * hand-picking easy questions inflates apparent skill — so these are fixed in
 * advance and rotate on a schedule rather than being chosen when convenient.
 */
export const SEED_QUESTIONS: readonly SeedQuestion[] = [
  // ── Competitor surface (5) ────────────────────────────────────────────────
  q(
    'jiffy_category_count',
    'Jiffy lists more than 40 service categories on its categories page on 2026-11-01',
    '2026-11-01T00:00:00.000Z',
    page('https://www.jiffyondemand.com/services', 'count:<a[^>]*service-card > 40'),
    'Category breadth is the clearest public signal of a competitor widening scope.',
  ),
  q(
    'jiffy_toronto_snow',
    'Jiffy advertises at least one snow-removal service on its services page on 2026-11-15',
    '2026-11-15T00:00:00.000Z',
    page('https://www.jiffyondemand.com/services', 'count:snow[-\\s]?removal >= 1'),
    'Directly contested: our Snow Squad recruiting window is Aug–Nov.',
  ),
  q(
    'taskrabbit_ca_expansion',
    'TaskRabbit lists at least one Canadian city outside Toronto/Vancouver on 2026-12-01',
    '2026-12-01T00:00:00.000Z',
    page('https://www.taskrabbit.ca/locations', 'count:Calgary|Ottawa|Edmonton|Montreal >= 1'),
    'Geographic expansion by an incumbent changes our corridor strategy.',
  ),
  q(
    'handy_ca_presence',
    'Handy still shows no Canadian location page on 2026-12-01',
    '2026-12-01T00:00:00.000Z',
    page('https://www.handy.com/locations', 'count:Toronto|Canada == 0'),
    'A Handy entry would be the single largest competitive shift available.',
  ),
  q(
    'jiffy_pricing_public',
    'Jiffy publishes an upfront price or price range on its pricing page on 2026-10-15',
    '2026-10-15T00:00:00.000Z',
    page('https://www.jiffyondemand.com/pricing', '\\$[0-9]+ contains $'),
    'Price transparency by a competitor resets the honesty bar we compete on.',
  ),

  // ── Hiring / capacity signals (4) ─────────────────────────────────────────
  q(
    'jiffy_hiring_eng',
    'Jiffy lists at least 3 engineering roles on 2026-10-01',
    '2026-10-01T00:00:00.000Z',
    page('https://www.jiffyondemand.com/careers', 'count:Engineer|Developer >= 3'),
    'Hiring is the earliest public leading indicator of a product push.',
  ),
  q(
    'jiffy_hiring_growth',
    'Jiffy lists a growth or performance-marketing role on 2026-10-01',
    '2026-10-01T00:00:00.000Z',
    page('https://www.jiffyondemand.com/careers', 'count:Growth|Performance Marketing >= 1'),
    'A paid-growth hire predicts a paid-acquisition push we would feel in CPCs.',
  ),
  q(
    'taskrabbit_ca_ops_hire',
    'TaskRabbit posts a Canada-based operations role before 2026-12-01',
    '2026-12-01T00:00:00.000Z',
    page('https://www.taskrabbit.com/careers', 'count:Canada|Toronto >= 1'),
    'Local ops headcount precedes local marketing spend.',
  ),
  q(
    'jiffy_headcount_linkedin',
    'Jiffy shows more than 60 employees on its public LinkedIn on 2026-12-01',
    '2026-12-01T00:00:00.000Z',
    {
      kind: 'manual',
      spec: 'Record the employee count shown on the public company page.',
      source_url: 'https://www.linkedin.com/company/jiffy-on-demand/',
      fallback: 'annul',
    },
    'Manual by design: LinkedIn scraping is banned in this system (§13).',
  ),

  // ── Search / demand (4) ───────────────────────────────────────────────────
  q(
    'gta_snow_seasonality',
    'Google Trends interest for "snow removal toronto" exceeds 50 in the week of 2026-11-24',
    '2026-12-01T00:00:00.000Z',
    {
      kind: 'manual',
      spec: 'Weekly interest value for the term, GTA region.',
      source_url: 'https://trends.google.com/trends/explore?q=snow%20removal%20toronto',
      fallback: 'annul',
    },
    'Calibrates our seasonal timing assumption, which the supply campaign depends on.',
  ),
  q(
    'taskly_indexed_pages',
    'Google indexes more than 200 taskly pages by 2026-11-01',
    '2026-11-01T00:00:00.000Z',
    {
      kind: 'sql',
      spec: 'select count(*) > 200 from gsc_pages where indexed = true',
      source_url: 'https://search.google.com/search-console',
      fallback: 'annul',
    },
    'Our own SEO trajectory — the one place we have first-party ground truth today.',
  ),
  q(
    'cleaning_serp_position',
    'taskly ranks in the top 20 for "house cleaning toronto" on 2026-12-01',
    '2026-12-01T00:00:00.000Z',
    {
      kind: 'sql',
      spec: "select min(position) <= 20 from gsc_queries where query = 'house cleaning toronto'",
      source_url: 'https://search.google.com/search-console',
      fallback: 'annul',
    },
    'Tests the SEO master plan’s core winnability claim on a flagship term.',
  ),
  q(
    'ai_answer_citation',
    'A major AI answer engine cites taskly for a GTA home-services query by 2027-01-15',
    '2027-01-15T00:00:00.000Z',
    {
      kind: 'manual',
      spec: 'Run the standard 10-query GEO check and record any citation.',
      source_url: 'https://taskly.ca',
      fallback: 'annul',
    },
    'Answer-engine visibility is the newest acquisition surface; we have no baseline.',
  ),

  // ── Platform / regulatory (4) ─────────────────────────────────────────────
  q(
    'reddit_api_terms',
    'Reddit still forbids free-tier commercial API use on 2026-12-01',
    '2026-12-01T00:00:00.000Z',
    page('https://redditinc.com/policies/data-api-terms', 'commercial contains commercial'),
    'Our entire source strategy assumes this stays closed. Worth checking, not assuming.',
  ),
  q(
    'cloudflare_crawler_default',
    'Cloudflare’s mixed-use AI-crawler block is live by default on 2026-09-30',
    '2026-09-30T00:00:00.000Z',
    {
      kind: 'manual',
      spec: 'Confirm from the Cloudflare changelog whether the default landed.',
      source_url: 'https://blog.cloudflare.com/',
      fallback: 'annul',
    },
    'Directly shrinks our reachable crawl surface — a budgeted coverage risk.',
  ),
  q(
    'x_api_link_surcharge',
    'X still charges a higher per-post rate for posts containing links on 2026-11-01',
    '2026-11-01T00:00:00.000Z',
    {
      kind: 'manual',
      spec: 'Check the developer pricing page for the link-post rate.',
      source_url: 'https://developer.x.com/en/portal/products',
      fallback: 'annul',
    },
    'If wrong, X re-enters the channel mix we cut on cost grounds.',
  ),
  q(
    'dpdp_enforcement_date',
    'India’s DPDP consent-manager registration opens on schedule in November 2026',
    '2026-12-01T00:00:00.000Z',
    {
      kind: 'manual',
      spec: 'Confirm from MeitY notifications.',
      source_url: 'https://www.meity.gov.in/',
      fallback: 'annul',
    },
    'Sets the deadline for our consent architecture in the India pack.',
  ),

  // ── Our own operating assumptions (3) ─────────────────────────────────────
  q(
    'tasker_supply_gta',
    'Taskly has more than 25 approved Taskers by 2026-11-01',
    '2026-11-01T00:00:00.000Z',
    {
      kind: 'sql',
      spec: "select count(*) > 25 from provider_profiles where status = 'approved'",
      source_url: 'internal://marketplace',
      fallback: 'annul',
    },
    'The binding constraint on launch. Our own forecast of it should be scored.',
  ),
  q(
    'first_task_fill_rate',
    'At least 70% of posted tasks receive an offer within 48h during November 2026',
    '2026-12-01T00:00:00.000Z',
    {
      kind: 'sql',
      spec:
        "select (count(*) filter (where first_offer_at - created_at < interval '48 hours')::numeric " +
        "/ nullif(count(*), 0)) > 0.7 from tasks where created_at >= date_trunc('month', date '2026-11-01')",
      source_url: 'internal://marketplace',
      fallback: 'annul',
    },
    'Liquidity is the launch thesis; this is the number that falsifies it.',
  ),
  q(
    'uc_flag_still_off',
    'UC_ENABLED is still false in production on 2026-12-01',
    '2026-12-01T00:00:00.000Z',
    {
      kind: 'manual',
      spec: 'Check the Railway env for the production service.',
      source_url: 'internal://railway',
      fallback: 'annul',
    },
    'A cheap check on whether the curated lane quietly came back.',
  ),
];

/** Sanity: the ledger is only meaningful if the question set is fixed up front. */
export const SEED_COUNT = SEED_QUESTIONS.length;
