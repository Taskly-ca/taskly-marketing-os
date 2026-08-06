/**
 * The GTA watchlist — what the engine actually looks at.
 *
 * Google News RSS is the highest-value free source for this market: it is a
 * targeted query rather than a firehose, it is licensed for reading, and it
 * costs nothing. The queries below are the questions a GTA home-services
 * marketplace needs answered continuously.
 *
 * This belongs in a DomainPack (Part 10) once packs exist. It lives here for
 * now because there is no scheduler and no database to hold it, and pretending
 * otherwise by putting it in a package would imply infrastructure that does not
 * exist yet.
 *
 * NOTE on overlap: these queries deliberately overlap. The same story about
 * Jiffy will surface under both `competitors` and `home-services-toronto`, and
 * collapsing that is the T0 gate's job. Non-overlapping queries would mean
 * choosing in advance which lens matters, which is the thing we do not know.
 */

interface WatchQuery {
  id: string;
  /** What this query is FOR — the question it answers, not the terms it uses. */
  question: string;
  url: string;
}

const gnews = (q: string): string =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-CA&gl=CA&ceid=CA:en`;

export const GTA_WATCHLIST: WatchQuery[] = [
  {
    id: 'competitors',
    question: 'Are the named competitors doing anything we would respond to?',
    url: gnews('Jiffy OR TaskRabbit OR Thumbtack OR Handy home services'),
  },
  {
    id: 'home-services-toronto',
    question: 'Is the GTA home-services market itself moving?',
    url: gnews('"home services" Toronto'),
  },
  {
    id: 'gig-economy-ontario',
    question: 'Is the regulatory ground shifting under a two-sided labour marketplace?',
    url: gnews('"gig economy" Ontario'),
  },
  {
    id: 'trades-ontario',
    question: 'What is happening to the supply side — the trades themselves?',
    url: gnews('cleaning OR handyman OR "snow removal" business Ontario'),
  },
];

/**
 * Google News titles carry a ` - Publisher` suffix and the link is a Google
 * redirect. The publisher is real signal (source tiering depends on it), so it
 * is split out rather than discarded.
 */
export function splitGoogleNewsTitle(raw: string): { title: string; publisher: string | null } {
  const idx = raw.lastIndexOf(' - ');
  if (idx === -1 || idx < raw.length / 2) return { title: raw, publisher: null };
  return { title: raw.slice(0, idx).trim(), publisher: raw.slice(idx + 3).trim() };
}

/* ── event clustering ───────────────────────────────────────────────────────
 * Three publishers writing their own headline about ONE acquisition is
 * paraphrase, and SimHash scores paraphrase near zero — `simhash.ts` says so
 * and has a test pinning it. Measured on the real Intact/Jiffy story:
 *
 *   same event, different publisher : 27, 30, 33 bits apart
 *   unrelated story                 : 38 bits apart
 *
 * At 5-9 shingles a headline simply does not carry enough signal; the margin
 * that makes near-dup safe on article bodies (4 vs 35) is gone. Raising the
 * threshold to catch 33 would merge unrelated stories at 38.
 *
 * So event identity uses the thing that actually distinguishes a story: the
 * rare proper nouns in it. "Intact" + "Jiffy" appear in all three headlines and
 * in nothing else. This is a stopgap for the digest — the real answer is T2
 * entity correlation, which is what that tier exists for.
 */

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'from',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'new',
  'up',
  'out',
  'how',
  'why',
  'what',
  'who',
  'when',
  'where',
  'has',
  'have',
  'had',
  'will',
  'would',
  'can',
  'could',
  'no',
  'not',
  'after',
  'before',
  'into',
  'over',
  'under',
  'more',
  'most',
  'best',
  'top',
  'you',
  'your',
  'we',
  'our',
  'they',
  'their',
]);

/** The distinctive tokens in a headline — proper nouns and rare terms. */
function eventKeyTokens(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
    ),
  ].sort();
}

/**
 * Two headlines describe the same event when they share enough distinctive
 * tokens. Overlap coefficient, not Jaccard: a terse headline and a long one
 * about the same story score near zero on Jaccard purely from length.
 */
export function sameEvent(a: string, b: string, threshold = 0.6): boolean {
  const ta = eventKeyTokens(a);
  const tb = eventKeyTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const shared = ta.filter((t) => tb.includes(t)).length;
  return shared / Math.min(ta.length, tb.length) >= threshold;
}
