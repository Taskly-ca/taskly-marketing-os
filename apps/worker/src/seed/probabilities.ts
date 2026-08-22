/**
 * The agent's opening forecast for each seed question.
 *
 * `SEED_QUESTIONS` deliberately ships without a `p`, and its header says why: a
 * seeded probability would be a fabricated forecast, and a fabricated forecast
 * in the ledger is worse than an empty ledger because it looks like a track
 * record. So these are authored as `agent:…`, and the founder's own `p` for the
 * same question is a SEPARATE row with the same claim and resolver — scored
 * independently. That comparison is the whole point of the ledger.
 *
 * Two rules held while writing these:
 *
 *  1. **Spread.** Twenty forecasts clustered at 0.9 produce a calibration curve
 *     with no resolution — you cannot tell a good forecaster from a confident
 *     one. These run 0.12 to 0.93 because the questions genuinely differ in how
 *     knowable they are, not to decorate the histogram.
 *
 *  2. **Status quo is the strong prior.** Most "will X still be true" questions
 *     resolve yes, and most "will Y newly happen by date D" questions resolve
 *     no, because institutions move slower than roadmaps. The confident numbers
 *     here are nearly all continuation claims; the genuinely uncertain ones are
 *     about our own execution, which is where a forecast is worth having.
 */
interface AgentForecast {
  p: number;
  because: string;
}

export const AGENT_FORECASTS: Readonly<Record<string, AgentForecast>> = {
  // ── Competitor surface ────────────────────────────────────────────────────
  jiffy_category_count: {
    p: 0.25,
    because: 'A curated operator earns margin by NOT sprawling. 40+ categories is Airtasker shape, not Jiffy shape, and nothing observed suggests that pivot.',
  },
  jiffy_toronto_snow: {
    p: 0.85,
    because: 'Snow is the default GTA winter service and mid-November is inside every operator listing window. Predicting otherwise means predicting they skip a season.',
  },
  taskrabbit_ca_expansion: {
    p: 0.2,
    because: 'TaskRabbit has held Toronto/Vancouver for years without widening. A quiet third city inside one quarter would break that pattern.',
  },
  handy_ca_presence: {
    p: 0.88,
    because: 'A continuation claim about the largest possible competitive shift. Market entries are visible months ahead and none is visible; the tail risk is exactly why this question earns a slot.',
  },
  jiffy_pricing_public: {
    p: 0.75,
    because: 'Upfront pricing is already their stated differentiator, so this mostly asks whether the page keeps saying what it says.',
  },

  // ── Hiring as leading indicator ───────────────────────────────────────────
  jiffy_hiring_eng: {
    p: 0.3,
    because: 'Three simultaneous engineering openings implies a funded push at a company this size. Possible, not the base rate.',
  },
  jiffy_hiring_growth: {
    p: 0.35,
    because: 'A single growth role is a far lower bar than three engineers, but paid-growth hiring tends to follow a raise, and no raise is public.',
  },
  taskrabbit_ca_ops_hire: {
    p: 0.25,
    because: 'Local ops headcount precedes local spend, which is what makes this worth watching — but it is a specific posting in a specific quarter.',
  },
  jiffy_headcount_linkedin: {
    p: 0.4,
    because: 'Genuinely uncertain: self-reported headcount drifts upward on its own, and the threshold sits near where they plausibly already are.',
  },

  // ── Market and seasonality ────────────────────────────────────────────────
  gta_snow_seasonality: {
    p: 0.7,
    because: 'Late November is normally when GTA snow interest breaks out, but the index is relative within the year — a late first snowfall pushes the peak into December and resolves this no.',
  },

  // ── Our own SEO trajectory ────────────────────────────────────────────────
  taskly_indexed_pages: {
    p: 0.35,
    because: 'Indexation depends on us shipping the SEO plan, which is written and NOT started. Forecasting our own unstarted work optimistically is the classic planning-fallacy failure.',
  },
  cleaning_serp_position: {
    p: 0.15,
    because: 'A flagship commercial term against entrenched aggregators on a domain with little authority. Top 20 inside a quarter would be a genuine surprise, which is what makes it a good test of the plan’s core claim.',
  },
  ai_answer_citation: {
    p: 0.12,
    because: 'Answer engines lean on established citations. We have no baseline at all, and "a major engine" is a high bar — but we also cannot measure this without asking.',
  },

  // ── Platform and regulatory ground ────────────────────────────────────────
  reddit_api_terms: {
    p: 0.93,
    because: 'Reddit monetised the API deliberately and has only tightened since. Our entire source strategy assumes this stays closed, which is precisely why it should be checked rather than assumed.',
  },
  cloudflare_crawler_default: {
    p: 0.8,
    because: 'Cloudflare has already moved default-block for AI crawlers and the direction is one-way; the uncertainty is over what "mixed-use" ends up covering.',
  },
  x_api_link_surcharge: {
    p: 0.7,
    because: 'Link suppression serves X’s own retention interest, so the surcharge persisting is the status quo — but their pricing has changed abruptly and repeatedly.',
  },
  dpdp_enforcement_date: {
    p: 0.45,
    because: 'Below even odds purely on base rates: regulatory commencement dates slip more often than they hold, and nothing indicates this one is unusual.',
  },

  // ── Our own launch reality ────────────────────────────────────────────────
  tasker_supply_gta: {
    p: 0.55,
    because: 'Supply is the binding launch constraint. From single-digit approvals this needs sustained recruiting to clear 25 — reachable, and squarely dependent on work not yet done.',
  },
  first_task_fill_rate: {
    p: 0.3,
    because: 'A 70% 48-hour fill rate is a mature-marketplace number. Early liquidity is thin and lumpy, and this is the metric that falsifies the launch thesis rather than flattering it.',
  },
  uc_flag_still_off: {
    p: 0.9,
    because: 'The curated lane was deliberately retired and its entry points closed. Reopening would be a reversal nobody has proposed — a cheap check that it did not come back quietly.',
  },
};
