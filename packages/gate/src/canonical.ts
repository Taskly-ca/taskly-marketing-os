/**
 * T0 — canonical URL.
 *
 * The cheapest stage in the whole pipeline and the one that removes the most
 * duplicates: strip tracking parameters, normalise the host, sort what remains,
 * and hash it. Everything downstream keys off this, so a sloppy implementation
 * here silently doubles the cost of every later stage.
 */
import { createHash } from 'node:crypto';

/** Parameters that never change what a page IS. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^ga_/i,
  /^hsa_/i,
  /^mc_/i,
  /^pk_/i,
  /^ref$/i,
  /^referrer$/i,
  /^source$/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^igshid$/i,
  /^mkt_tok$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^vero_id$/i,
  /^yclid$/i,
  /^s_cid$/i,
];

const isTracking = (key: string): boolean => TRACKING_PARAMS.some((re) => re.test(key));

export interface CanonicalizeOptions {
  /** A `<link rel="canonical">` the page declared, if we parsed one. It wins
   *  over our own normalisation — the site is the authority on its own identity. */
  declaredCanonical?: string | null;
}

export function canonicalizeUrl(input: string, opts: CanonicalizeOptions = {}): string | null {
  const target = opts.declaredCanonical?.trim() || input;
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  // https is the canonical scheme; http and https of the same page are one page.
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  if ((u.port === '80' || u.port === '443') && u.port) u.port = '';

  // Trailing slash on a directory path is not a distinct page.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !isTracking(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  return u.toString();
}

/** Primary dedup key. */
export function urlHash(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Registrable-ish domain (eTLD+1 approximation). Used as a hard identity key
 *  for entity resolution, where it is close to perfect for company matching.
 *  Handles the common two-part public suffixes we actually encounter. */
const TWO_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.in',
  'net.in',
  'org.in',
  'co.jp',
  'com.br',
  'com.mx',
  'com.sg',
]);

export function registrableDomain(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  const parts = host.split('.');
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join('.');
  if (TWO_PART_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}
