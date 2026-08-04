/**
 * Entity identity — hard keys first, fuzzy matching only as a fallback.
 *
 * The ordering is the whole design. A registrable domain, a social handle or a
 * store bundle id IS the entity: two records carrying the same one are the same
 * company, and merging them needs no score, no threshold and no LLM. The unique
 * index on `entity_identifier (kind, value_norm)` makes that a database
 * guarantee rather than a policy we remember to apply.
 *
 * Names are the fallback, and names are where entity resolution goes wrong.
 */
import { registrableDomain } from '@tmos/gate';

/** Kinds that auto-merge on exact match. Anything else is a scored candidate. */
export const HARD_KEY_KINDS = ['domain', 'social', 'bundle_id', 'linkedin_id'] as const;
export type HardKeyKind = (typeof HARD_KEY_KINDS)[number];

export interface HardKey {
  kind: HardKeyKind;
  valueNorm: string;
}

/**
 * Hosts where the registrable domain identifies the PLATFORM, not the company.
 * Every tasker with a Facebook page would otherwise merge into one entity whose
 * hard key is `facebook.com` — a single index collision silently fusing an
 * entire market. Hard keys are only safe where the key is genuinely unique to
 * the entity, so on these we fall back to the handle in the path.
 */
const PLATFORM_HOSTS = new Set([
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'youtube.com',
  'medium.com',
  'substack.com',
  'wordpress.com',
  'blogspot.com',
  'wixsite.com',
  'squarespace.com',
  'shopify.com',
  'myshopify.com',
  'godaddysites.com',
  'business.site',
  'sites.google.com',
  'linktr.ee',
  'notion.site',
  'github.io',
]);

/**
 * Checked against every suffix of the HOSTNAME, not against the registrable
 * domain.
 *
 * `sites.google.com` reduces to `google.com`, so a registrable-domain check
 * would let a Google Sites page through — and `google.com` cannot go in the
 * list, because Google is itself a legitimate entity. Walking the suffixes
 * matches `sites.google.com` while leaving `google.com` alone.
 */
export function isPlatformHost(hostOrDomain: string): boolean {
  const host = hostOrDomain.toLowerCase().replace(/^www\./, '');
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (PLATFORM_HOSTS.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A website URL → a hard key, or null when the URL cannot identify a company.
 *
 * Returning null is the load-bearing behaviour: a null forces the record down
 * the scored path, where a wrong answer is reviewable. A wrong hard key is not
 * reviewable — it auto-merges, with no threshold and no human in the loop.
 */
export function domainKey(url: string): HardKey | null {
  const host = hostnameOf(url);
  if (host && isPlatformHost(host)) return null;
  const domain = registrableDomain(url);
  if (!domain || isPlatformHost(domain)) return null;
  return { kind: 'domain', valueNorm: domain };
}

/** `@Handle`, `handle`, or a profile URL → one normalized handle key. */
export function socialKey(platform: string, raw: string): HardKey | null {
  const plat = platform.trim().toLowerCase();
  if (!plat) return null;

  let handle = raw.trim();
  if (handle.includes('/')) {
    const parts = handle
      .replace(/[?#].*$/, '')
      .split('/')
      .filter(Boolean);
    handle = parts[parts.length - 1] ?? '';
  }
  handle = handle.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._-]{2,}$/.test(handle)) return null;
  return { kind: 'social', valueNorm: `${plat}:${handle}` };
}

/* ── names ──────────────────────────────────────────────────────────────────
 * Everything below is the fallback path, and it is where ER earns its
 * reputation for being harder than it looks.
 */

/** Stripped before comparison — they carry no identifying information. */
const LEGAL_SUFFIXES = [
  'incorporated',
  'inc',
  'llc',
  'llp',
  'lp',
  'ltd',
  'limited',
  'plc',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'ag',
  'bv',
  'nv',
  'sa',
  'srl',
  'spa',
  'oy',
  'ab',
  'as',
  'aps',
  'pty',
  'pte',
  'pvt',
  'private limited',
  'sdn bhd',
  'kk',
  'kft',
  'doo',
  'sro',
  'zoo',
  'ou',
  'holdings',
  'group',
  'the',
];

/**
 * Names whose normalized form is a trap. Two separate failure modes:
 *
 *  - **Punctuation is load-bearing.** `AT&T` normalizes to `at t`, which is
 *    two stopword-ish tokens; `E*TRADE` loses the star that distinguishes it.
 *  - **The name collides with a common word or a suffix rule.** `The Gap`
 *    loses `the` and becomes `gap`; `Co-op` is eaten by the `co` suffix rule;
 *    `Next` and `Three` are ordinary English words.
 *
 * Matching these requires an exact normalized equality or a hard key — never a
 * similarity score. The list is small on purpose: it is a list of *known*
 * traps, not an attempt to enumerate every brand.
 */
export const PROTECTED_BRANDS = new Set([
  '3m',
  'at&t',
  'e*trade',
  'ebay',
  'etrade',
  'gap',
  'the gap',
  'next',
  'three',
  'co-op',
  'coop',
  'orange',
  'shell',
  'apple',
  'square',
  'stripe',
  'x',
  'meta',
  'block',
  'oracle',
  'sun',
  'amazon',
  'alphabet',
  'visa',
  'mastercard',
  'jio',
  'tata',
  'wipro',
  'infosys',
  'zoom',
  'slack',
  'notion',
  'linear',
  'monday',
]);

/**
 * Below this many characters a trigram score is noise, not evidence.
 *
 * `pg_trgm` on `3m` produces a handful of padded trigrams, so its similarity to
 * unrelated short strings is both high and unstable. Short names therefore never
 * fuzzy-match — they need an exact normalized equality or a hard key.
 */
export const MIN_FUZZY_LENGTH = 5;

export interface NormalizedName {
  /** Comparison key: lowercase, unaccented, de-suffixed, punctuation-free. */
  norm: string;
  /** Same but with punctuation preserved — the key for protected brands. */
  tight: string;
  /** True when a similarity score must NOT be used to match this name. */
  exactOnly: boolean;
  /** Why, so a reviewer reading an ER decision can see the reason. */
  reason: 'protected_brand' | 'too_short' | null;
}

const stripDiacritics = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

function stripLegalSuffixes(tokens: string[]): string[] {
  const out = [...tokens];
  // Repeatedly, because "Foo Holdings Ltd" carries two.
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    const last = out[out.length - 1];
    if (last && LEGAL_SUFFIXES.includes(last)) {
      out.pop();
      changed = true;
    }
  }
  // A leading "the" carries nothing either — but only if something remains.
  if (out.length > 1 && out[0] === 'the') out.shift();
  return out;
}

export function normalizeName(raw: string): NormalizedName {
  const tight = stripDiacritics(raw.trim().toLowerCase()).replace(/\s+/g, ' ');

  if (PROTECTED_BRANDS.has(tight)) {
    return { norm: tight, tight, exactOnly: true, reason: 'protected_brand' };
  }

  const tokens = tight
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const norm = stripLegalSuffixes(tokens).join(' ');

  if (PROTECTED_BRANDS.has(norm)) {
    return { norm, tight, exactOnly: true, reason: 'protected_brand' };
  }
  if (norm.replace(/\s/g, '').length < MIN_FUZZY_LENGTH) {
    return { norm, tight, exactOnly: true, reason: 'too_short' };
  }
  return { norm, tight, exactOnly: false, reason: null };
}

/** True when the pair may be compared by similarity at all. */
export const mayFuzzyMatch = (a: NormalizedName, b: NormalizedName): boolean =>
  !a.exactOnly && !b.exactOnly;

/**
 * The auto-merge decision, before any scoring runs.
 *
 * `merge` here means "these are the same entity, no review" — so it is only
 * ever returned for a shared hard key or an exact match on a protected name.
 */
export type IdentityVerdict =
  | { decision: 'merge'; via: 'hard_key'; key: HardKey }
  | { decision: 'merge'; via: 'exact_protected_name'; name: string }
  | { decision: 'score' }
  | { decision: 'reject'; reason: string };

export function identityVerdict(
  left: { keys: HardKey[]; name: NormalizedName },
  right: { keys: HardKey[]; name: NormalizedName },
): IdentityVerdict {
  for (const lk of left.keys) {
    const hit = right.keys.find((rk) => rk.kind === lk.kind && rk.valueNorm === lk.valueNorm);
    if (hit) return { decision: 'merge', via: 'hard_key', key: hit };
  }

  if (left.name.exactOnly || right.name.exactOnly) {
    if (left.name.tight === right.name.tight && left.name.tight.length > 0) {
      return { decision: 'merge', via: 'exact_protected_name', name: left.name.tight };
    }
    const which = left.name.reason ?? right.name.reason;
    return { decision: 'reject', reason: `exact-only name (${which}) did not match exactly` };
  }

  return { decision: 'score' };
}
