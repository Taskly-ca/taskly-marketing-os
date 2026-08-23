/**
 * PLATFORM — the second pack, and the reason it is not a second marketing pack.
 *
 * Part 10 asks for proof that the seam is real: "add a non-marketing pack
 * (product or support intelligence) with **zero core changes**". The tempting
 * version is India — copy `marketing-ca`, change the cities — which proves
 * nothing, because a copy of a pack exercises exactly the fields the original
 * did. And it would have meant inventing competitors, robots-checking pages and
 * writing questions for a market this business has not entered, all of which
 * would be fabrication dressed as configuration.
 *
 * This watches the services Taskly is BUILT ON. Not a market: an infrastructure
 * dependency, whose questions are about breakage rather than about rivals, and
 * whose relevance has no geography at all. If the contract can express that
 * without an edit outside this directory, the seam holds.
 *
 * WHAT IT PROVED, WHICH IS THE ONLY INTERESTING PART OF WRITING IT:
 *
 *   · `subject` is not a persona. Triage for this pack scores "would this break
 *     us in 90 days", not "would this change what we do" — and the sentence
 *     carries that without a new field, because the criteria are in the prompt
 *     the core owns and the subject only says whose interests are at stake.
 *   · `region: 'global'` needed no new region. A dependency has no corridor, so
 *     `home` is empty and every finding scores `unknown` on geography — which
 *     is the honest weight, not a special case.
 *   · The measures are all `bounded` or `measured`. That was not planned; it is
 *     what happens when the questions are about presence and absence rather
 *     than about wording, and it means this pack cannot mint a drift Finding.
 *
 * NOT SCHEDULED. `run:pass` runs the default pack; this one runs when asked, by
 * id. A second pack on the timer is a decision about spend and attention, and
 * the point here was the seam.
 *
 * Every page below was checked against its own robots.txt, 2026-08-23.
 */
import { createRssCollector } from '@tmos/collectors';

import { UNSTATED, type DomainPack, type Measure, type PackSource, type WatchTarget } from './types.js';

const YES_NO = ['yes', 'no', UNSTATED] as const;

/**
 * Presence and absence, not wording.
 *
 * A status page and a pricing page are written by people who change their
 * phrasing constantly and their POLICY rarely. Asking "does this page say X"
 * with a two-word answer space survives a rewrite; asking "what does it say"
 * would report every copy edit as an incident.
 */
const DEPENDENCY: readonly Measure[] = [
  {
    predicate: 'free_tier_offered',
    datatype: 'text',
    unit: null,
    question: 'Does the page offer a free tier or free plan? Answer exactly yes, no, or unstated.',
    answer: 'bounded',
    allowed: YES_NO,
  },
  {
    predicate: 'lowest_paid_plan_price',
    datatype: 'text',
    unit: null,
    question:
      'What is the lowest paid plan price on the page, with its currency and period exactly as written? If no price is shown, answer unstated.',
    answer: 'quoted',
  },
  {
    predicate: 'announces_deprecation',
    datatype: 'text',
    unit: null,
    question:
      'Does the page announce a deprecation, sunset or end-of-life for anything? Answer exactly yes, no, or unstated.',
    answer: 'bounded',
    allowed: YES_NO,
  },
];

/**
 * The four things whose disappearance would stop the product.
 *
 * Supabase is the database and auth, Stripe is every payment, Groq is every AI
 * feature and Resend is every email. A price change on any of them is a line in
 * the financial model; a deprecation on any of them is a migration.
 */
const TARGETS: readonly WatchTarget[] = [
  {
    company: 'Supabase',
    domain: 'supabase.com',
    url: 'https://supabase.com/pricing',
    reading_for: 'Whether the tier we run on still exists, and what the next one costs.',
    measures: DEPENDENCY,
  },
  {
    company: 'Stripe',
    domain: 'stripe.com',
    url: 'https://stripe.com/en-ca/pricing',
    reading_for: 'Canadian card and Connect pricing — every fee in the model comes from here.',
    measures: DEPENDENCY,
  },
  {
    company: 'Groq',
    domain: 'groq.com',
    url: 'https://groq.com/pricing',
    reading_for:
      'Model pricing and availability. Groq retired both models this system was built on, silently, between one week and the next.',
    measures: DEPENDENCY,
  },
  {
    company: 'Resend',
    domain: 'resend.com',
    url: 'https://resend.com/pricing',
    reading_for: 'Sending limits and price, which decide whether the digest can be an email.',
    measures: DEPENDENCY,
  },
];

const SOURCES: readonly PackSource[] = [
  {
    collector: createRssCollector('https://supabase.com/rss.xml', 'rss:supabase'),
    tier: 'first_party',
    region: 'global',
    question: 'Has the platform we run on changed something we depend on?',
  },
  {
    collector: createRssCollector('https://stripe.com/blog/feed.rss', 'rss:stripe'),
    tier: 'first_party',
    region: 'global',
    question: 'Has anything changed in payments, Connect or Canadian availability?',
  },
];

export const platform: DomainPack = {
  id: 'platform',
  /**
   * Global, and that is not a placeholder. A dependency has no corridor: the
   * scorer's `home` list is empty for this pack, so every finding lands on
   * `unknown` geography — the honest weight for "this is not about a market".
   */
  region: 'global',
  subject:
    'Taskly, a home-services marketplace, and the four services it is built on: ' +
    'Supabase for the database and auth, Stripe for every payment, Groq for every ' +
    'AI feature, and Resend for email. A change to any of them is a change to the ' +
    'product, not to the market.',
  sources: SOURCES,
  targets: TARGETS,
  scoring: {
    // No home corridor, and no rivals — these are suppliers. Naming them as
    // competitors would inflate the score of every routine changelog entry.
    corridor: { home: [], elsewhere: [] },
    competitors: [],
  },
};
