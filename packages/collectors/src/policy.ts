/**
 * LEGAL POLICY, COMPILED IN.
 *
 * These are not guidelines in a doc — they are functions the fetch path calls,
 * because the legal ground moved hard in the last year:
 *
 *   • Reddit v. Perplexity/SerpApi/Oxylabs — DMCA §1201 claims SURVIVED
 *     dismissal, so circumventing rate limits or anti-bot is now statutory
 *     risk, not merely contractual.
 *   • Meta v. Bright Data protects only LOGGED-OFF collection; hiQ lost on
 *     breach of contract precisely because it held accounts.
 *   • CNIL fined KASPR €240k for storing scraped contact data, and PIPEDA does
 *     NOT treat scraped personal information as "publicly available" — which
 *     applies directly to us as a Canadian company.
 */

/** Hosts we never fetch, at any volume, including via a third-party actor —
 *  liability follows the data, not the fetcher. */
const BANNED_HOSTS = [
  'linkedin.com',
  'instagram.com',
  'tiktok.com',
  'facebook.com',
  'threads.net',
  'x.com',
  'twitter.com',
];

export const USER_AGENT = 'TasklyBot/1.0 (+https://taskly.ca/bot; care@taskly.ca)';

/** Self-imposed and stricter than what targets tolerate. */
export const MIN_INTERVAL_MS = 2_000;
export const MAX_CONCURRENT_PER_HOST = 1;

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Hard host gate. Checked before robots.txt, because for these hosts the
 *  answer is no regardless of what their robots.txt says. */
export function checkHost(url: string): PolicyVerdict {
  const host = hostOf(url);
  if (!host) return { allowed: false, reason: `unparseable url: ${url}` };
  const banned = BANNED_HOSTS.find((b) => host === b || host.endsWith(`.${b}`));
  if (banned) {
    return {
      allowed: false,
      reason: `${banned} is on the never-scrape list — use an official API or a manual resolver`,
    };
  }
  return { allowed: true };
}

/** Minimal robots.txt evaluation. Treated as a HARD gate, not advisory —
 *  including Crawl-delay. */
export interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelayMs: number | null;
}

export function parseRobots(text: string, ua = 'TasklyBot'): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], crawlDelayMs: null };
  let applies = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = (rawKey ?? '').trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      applies = value === '*' || value.toLowerCase() === ua.toLowerCase();
    } else if (applies && key === 'disallow' && value) {
      rules.disallow.push(value);
    } else if (applies && key === 'allow' && value) {
      rules.allow.push(value);
    } else if (applies && key === 'crawl-delay') {
      const n = Number(value);
      if (!Number.isNaN(n)) rules.crawlDelayMs = n * 1000;
    }
  }
  return rules;
}

export function robotsAllows(rules: RobotsRules, url: string): PolicyVerdict {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return { allowed: false, reason: `unparseable url: ${url}` };
  }
  // Longest match wins; an explicit Allow beats a Disallow of equal length.
  const longest = (list: string[]) =>
    list.filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0] ?? null;

  const dis = longest(rules.disallow);
  const allow = longest(rules.allow);
  if (dis && (!allow || allow.length < dis.length)) {
    return { allowed: false, reason: `robots.txt disallows ${dis}` };
  }
  return { allowed: true };
}

/** The delay we will actually honour: the stricter of theirs and ours. */
export function effectiveDelayMs(rules: RobotsRules | null): number {
  return Math.max(MIN_INTERVAL_MS, rules?.crawlDelayMs ?? 0);
}

/* ── PII ────────────────────────────────────────────────────────────────────
 * Store aggregate signals — topic, sentiment, volume — never people. Emails,
 * phone numbers and @handles are stripped at ingest rather than at query time,
 * because retention is what the KASPR fine actually turned on.
 */

const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const HANDLE_RE = /(^|\s)@[\w.]{2,30}\b/g;

/**
 * Phone detection is deliberately two-stage: a loose candidate match, then a
 * validity check.
 *
 * A single regex tight enough to catch every real phone format is also loose
 * enough to eat things that merely look like one. `2026-07-25` and `10.15.7
 * (19H2)` are digit runs built from exactly the same separator characters as
 * `416-555-0199`, and a one-stage regex redacts them — silently corrupting
 * every date and version string we ingest. That is worse than missing a phone
 * number: it destroys the analysable signal we collect the data for.
 */
const PHONE_CANDIDATE_RE = /\+?\d[\d\s().-]{7,}\d/g;

/** E.164 caps a subscriber number at 15 digits; NANP uses 10, 11 with country. */
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

/** The classic false positive — an ISO date is a phone-shaped digit run. */
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/;

function looksLikePhone(candidate: string): boolean {
  if (ISO_DATE_RE.test(candidate)) return false;
  const digits = candidate.replace(/\D/g, '').length;
  return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS;
}

const redactPhones = (text: string): string =>
  text.replace(PHONE_CANDIDATE_RE, (m) => (looksLikePhone(m) ? '[phone]' : m));

export function stripPii(text: string): string {
  return redactPhones(text.replace(EMAIL_RE, '[email]')).replace(HANDLE_RE, '$1[handle]');
}

export function containsPii(text: string): boolean {
  if (new RegExp(EMAIL_RE.source).test(text)) return true;
  if (new RegExp(HANDLE_RE.source).test(text)) return true;
  return (text.match(PHONE_CANDIDATE_RE) ?? []).some(looksLikePhone);
}

/** Raw bodies expire; derived signals persist. */
export const RAW_RETENTION_DAYS = 180;
