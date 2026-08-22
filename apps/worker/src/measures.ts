/**
 * THE INSTRUMENT — and the rule that an instrument which drifts is not one.
 *
 * `watch.ts` already fixed the question set, because a change detector whose
 * measures drift cannot detect change. The first run against a real ledger
 * showed that fixing the QUESTIONS is not enough: the first Finding this system
 * ever minted said "Handy's service categories count is now 5", and the page
 * had not changed. Yesterday the extractor quoted `Home Cleaning · Furniture
 * Assembly · TV Mounting · Wall Hanging` and answered 4. Today it quoted a
 * wider slice of the same page, including the nav chrome `All Services` and
 * `Cleaning & Handyman Tasks`, and answered 5. Same four categories named in
 * both spans. The difference was the span, not the world.
 *
 * A fixed question with an unbounded answer is still a drifting instrument. So
 * every measure now declares HOW its answer relates to the page, and only two
 * of the three kinds are allowed to say that something changed:
 *
 *   BOUNDED  the answer comes from a small enumerated set. `yes | no |
 *            unstated` cannot drift by a word, so a difference between two runs
 *            is a difference on the page. Publishes.
 *
 *   QUOTED   the answer is text lifted off the page, and it must appear in the
 *            span we cite for it. A price the page does not contain is not a
 *            price the page advertises. Publishes.
 *
 *   OPEN     a count, a list, anything the model composes rather than copies.
 *            Recorded as a fact — it is still the history of what we read — but
 *            it never mints a Finding, because a drift and a change are
 *            indistinguishable in it and we cannot tell a reader which one they
 *            are looking at.
 *
 * WHY OPEN MEASURES ARE KEPT AT ALL. Deleting them would be tidier and would
 * throw away the only evidence that they drift. They stay, they are recorded,
 * and the stability we do not have is a fact about the instrument rather than a
 * blank in the table. If `service_categories_count` turns out to be stable over
 * a month of runs, promoting it to a publishing measure is a one-word change
 * backed by data instead of by hope.
 *
 * L0 DOES NOT COVER THIS, and it is worth being precise about why, since the
 * gate looked like it should have caught the bad Finding. `BARE_INTEGER_FLOOR`
 * is 10: integers below it are treated as prose, because demanding that "the
 * top 3 reasons" appear verbatim in a span is the fastest way to get a gate
 * ignored. That is the right call for prose and it means a small count is never
 * checked against its span. Small counts are exactly what this instrument
 * produces, so the check has to live here, in the instrument, not in L0.
 */

/**
 * How a measure's answer relates to the document it was read from.
 *
 * `measured` is the fourth and the only one with no model in it: the value is
 * computed from a machine-readable document — counting `<loc>` entries in a
 * sitemap — so there is no span to choose and no judgement to drift. It is the
 * answer to the problem `open` records, and it still does not publish yet, for
 * a reason that is L0 rather than trust: the claim template renders the value
 * ("…is now 61") and L0 requires every number in a claim to appear verbatim in
 * a cited span, which a count derived from a document never does. The honest
 * change-Finding for a sitemap names the added services instead — values that
 * ARE in the span — and needs a purpose-built claim.
 */
export type AnswerKind = 'bounded' | 'quoted' | 'open' | 'measured';

export interface Measure {
  readonly predicate: string;
  readonly datatype: 'num' | 'text';
  readonly unit: string | null;
  /** Asked verbatim. Must have one answer the page either states or does not. */
  readonly question: string;
  readonly answer: AnswerKind;
  /** `bounded` only: the complete answer set, lower-case. */
  readonly allowed?: readonly string[];
}

/**
 * The one word a `quoted` measure may answer without quoting anything.
 *
 * "The page shows no price" is a real answer and there is no span for the
 * absence of a thing. Without a sentinel the model would have to invent one, so
 * it is named, it is the only exemption, and the transition between `unstated`
 * and a real price is precisely the change worth publishing.
 */
export const UNSTATED = 'unstated';

const YES_NO = ['yes', 'no', UNSTATED] as const;

export const COMMON: readonly Measure[] = [
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
 * True when a change in this measure may be published as a Finding.
 *
 * The two exclusions are excluded for opposite reasons and it is worth not
 * blurring them: `open` cannot be published because it is not trustworthy, and
 * `measured` cannot be published YET because T2's claim template cannot cite it.
 */
export const publishes = (m: Measure): boolean => m.answer === 'bounded' || m.answer === 'quoted';

/* ── the deterministic measures ───────────────────────────────────────────── */

/** How many services the competitor's own sitemap lists. Counted, not judged. */
export const SITEMAP_COUNT: Measure = {
  predicate: 'sitemap_service_count',
  datatype: 'num',
  unit: 'count',
  question: '(computed) how many service URLs the sitemap lists',
  answer: 'measured',
};

/** Which ones, sorted — so a reordered sitemap is not a changed catalogue. */
export const SITEMAP_CATALOGUE: Measure = {
  predicate: 'sitemap_service_catalogue',
  datatype: 'text',
  unit: null,
  question: '(computed) the sorted list of service slugs the sitemap lists',
  answer: 'measured',
};

/* ── accepting an answer ──────────────────────────────────────────────────── */

type AnswerVerdict =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly why: string };

const normalize = (raw: unknown): string => String(raw).trim().toLowerCase();

/**
 * Decide whether an extracted answer may be recorded at all.
 *
 * `page` is the flattened page text and `span` the evidence the model returned;
 * `watch.ts` has already checked that the span is genuinely on the page, so
 * what is left is whether the ANSWER is supported by the span it was given. The
 * two failures this catches are different in kind and both were live:
 *
 *  - a bounded measure answered off-menu ("partially", "yes for Toronto") turns
 *    a two-state signal into free text, and the next run's rewording of the
 *    same state reads as a change;
 *  - a quoted measure answered with a price that is not in its own span is a
 *    number with no source, which is the one thing this system exists not to
 *    publish.
 */
export function acceptAnswer(measure: Measure, rawValue: unknown, span: string): AnswerVerdict {
  const value = normalize(rawValue);
  if (value === '') return { ok: false, why: 'empty answer' };

  if (measure.answer === 'bounded') {
    const allowed = measure.allowed ?? [];
    if (!allowed.includes(value)) {
      return {
        ok: false,
        why: `answered "${value}", which is not one of ${allowed.join(' | ')} — an off-menu answer turns a two-state signal into free text`,
      };
    }
    return { ok: true, value };
  }

  // `measured` never reaches here in practice — nothing extracted it, so there
  // is nothing to hold to a span — but a kind that fell through to the `open`
  // branch by accident would be silently downgraded, so it is named.
  if (measure.answer === 'measured') return { ok: true, value };

  if (measure.answer === 'quoted') {
    if (value === UNSTATED) return { ok: true, value };
    if (!span.toLowerCase().includes(value)) {
      return {
        ok: false,
        why: `answered "${value}", which does not appear in the span cited for it — a quoted measure may only report what the page says`,
      };
    }
    return { ok: true, value };
  }

  return { ok: true, value };
}
