/**
 * L0 — the deterministic assertions.
 *
 * Three checks, no model, no cost, no drift:
 *
 *   1. every claim carries at least one evidence reference
 *   2. every cited URL is one we actually retrieved
 *   3. every number and date in the claim appears VERBATIM in a cited span
 *
 * The third is the one that earns its place. The characteristic fabrication is
 * not an invented sentence — it is a real sentence with a moved decimal:
 * "Jiffy raised prices 23%" where the source says 12%. A judge model reads that
 * as fluent and plausible; a string comparison does not. It costs nothing, runs
 * on every finding, and cannot degrade as models change.
 *
 * L0 is a floor, not a ceiling. It says nothing about whether the claim follows
 * from the span — that is L1's job. A finding can pass L0 and still be wrong.
 */
import type { EvidenceRef, Finding } from '@tmos/contracts';

export type L0Code =
  'no_evidence' | 'url_not_retrieved' | 'empty_span' | 'number_not_in_span' | 'date_not_in_span';

export interface L0Violation {
  code: L0Code;
  detail: string;
  /** The offending token, when the failure is about one. */
  token?: string;
}

export interface L0Result {
  ok: boolean;
  violations: L0Violation[];
}

/* ── numeric extraction ───────────────────────────────────────────────────── */

/**
 * Numbers as a reader would say them: currency, percentages, decimals, and
 * thousands-separated integers.
 *
 * Bare small integers are deliberately EXCLUDED. "three of the five listings"
 * and "in 2 weeks" are prose, not quantities lifted from a source, and
 * demanding they appear verbatim produces constant false failures — the fastest
 * way to get a gate ignored. The threshold is stated below and tested.
 */
const NUMERIC_RE = /\$?\d[\d,]*(?:\.\d+)?%?/g;

/** Integers below this are treated as prose unless they carry $ or %. */
export const BARE_INTEGER_FLOOR = 10;

/** Digits only — so `$1,200`, `1200` and `1,200.00` compare equal. */
export function normalizeNumeric(raw: string): string {
  const negative = /^-/.test(raw);
  const digits = raw.replace(/[^\d.]/g, '');
  if (!digits) return '';
  // Trailing zeros after a decimal point carry no value: 1200.00 === 1200.
  const trimmed = digits.includes('.') ? digits.replace(/\.?0+$/, '') : digits;
  return `${negative ? '-' : ''}${trimmed || '0'}`;
}

/** True when the token is worth demanding verbatim support. */
function isMaterialNumber(raw: string): boolean {
  if (raw.includes('$') || raw.includes('%')) return true;
  if (raw.includes('.') || raw.includes(',')) return true;
  const n = Number(normalizeNumeric(raw));
  return Number.isFinite(n) && Math.abs(n) >= BARE_INTEGER_FLOOR;
}

export function extractNumbers(text: string): string[] {
  // Dates are masked first. Otherwise the year in "August 3, 2026" is also
  // demanded as a standalone number, and a date failure reports twice — once
  // correctly as a date, once misleadingly as a number, pointing a reviewer at
  // the wrong problem.
  return [...maskDates(text).matchAll(NUMERIC_RE)].map((m) => m[0]).filter(isMaterialNumber);
}

/* ── date extraction ──────────────────────────────────────────────────────── */

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const DATE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  new RegExp(`\\b(${MONTHS.join('|')})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}\\s+(${MONTHS.join('|')})\\.?\\s+\\d{4}\\b`, 'gi'),
  new RegExp(`\\b(${MONTHS.join('|')})\\.?\\s+\\d{4}\\b`, 'gi'),
];

export function extractDates(text: string): string[] {
  const out = new Set<string>();
  const seen: Array<[number, number]> = [];
  for (const re of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // Patterns are ordered most-specific first, so a later, looser pattern
      // must not also claim text a more specific one already matched — that is
      // what would make "August 1, 2026" yield "August 2026" as well.
      if (seen.some(([a, b]) => start < b && a < end)) continue;
      seen.push([start, end]);
      out.add(m[0]);
    }
  }
  return [...out];
}

/** Blank out date text so numeric extraction cannot see inside a date. */
function maskDates(text: string): string {
  let out = text;
  for (const d of extractDates(text)) {
    const at = out.indexOf(d);
    if (at !== -1) out = out.slice(0, at) + ' '.repeat(d.length) + out.slice(at + d.length);
  }
  return out;
}

/**
 * Compare dates by their parts, so `2026-08-01`, `August 1, 2026` and `1 August
 * 2026` are the same date written three ways.
 *
 * A claim that says "August 2026" when the source says "August 1, 2026" is
 * fine — the claim is less precise, not different. The reverse is NOT fine, and
 * that asymmetry is the point: a claim may lose precision, never invent it.
 */
export function dateParts(raw: string): { y: string; m: string; d: string | null } | null {
  const s = raw.toLowerCase().replace(/[.,]/g, '');
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { y: m[1]!, m: m[2]!, d: String(Number(m[3])) };

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return { y, m: String(Number(m[1])).padStart(2, '0'), d: String(Number(m[2])) };
  }

  const monthIdx = MONTHS.findIndex((mo) => s.includes(mo));
  if (monthIdx === -1) return null;
  const year = /\b(\d{4})\b/.exec(s)?.[1];
  if (!year) return null;
  const dayMatch = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(s.replace(year, ''));
  return {
    y: year,
    m: String(monthIdx + 1).padStart(2, '0'),
    d: dayMatch ? String(Number(dayMatch[1])) : null,
  };
}

function dateSupported(claimDate: string, spanDates: string[]): boolean {
  const c = dateParts(claimDate);
  if (!c) return false;
  return spanDates.some((sd) => {
    const s = dateParts(sd);
    if (!s || s.y !== c.y || s.m !== c.m) return false;
    // The claim may be less precise than the source, never more.
    return c.d === null || c.d === s.d;
  });
}

/* ── the assertions ───────────────────────────────────────────────────────── */

export interface L0Input {
  claim: string;
  evidence: EvidenceRef[];
  /** Every URL the retrieval step actually returned this run. */
  retrievedUrls: Iterable<string>;
}

/**
 * A URL matches the retrieved set on its canonical form, so a tracking
 * parameter added between retrieval and citation is not treated as a
 * fabricated source.
 */
function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    return `${u.protocol}//${u.hostname}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim();
  }
}

export function assertL0(input: L0Input): L0Result {
  const violations: L0Violation[] = [];
  const { claim, evidence } = input;

  if (evidence.length === 0) {
    return {
      ok: false,
      violations: [{ code: 'no_evidence', detail: 'claim ships with no source' }],
    };
  }

  const retrieved = new Set([...input.retrievedUrls].map(canonical));
  for (const ref of evidence) {
    if (!retrieved.has(canonical(ref.source_url))) {
      violations.push({
        code: 'url_not_retrieved',
        detail: `cited a URL that was never retrieved this run: ${ref.source_url}`,
        token: ref.source_url,
      });
    }
    if (ref.span.trim().length === 0) {
      violations.push({
        code: 'empty_span',
        detail: `evidence for ${ref.source_url} has an empty span`,
        token: ref.source_url,
      });
    }
  }

  const spans = evidence.map((e) => e.span).join('\n');
  const spanNumbers = new Set(extractNumbers(spans).map(normalizeNumeric));
  const spanDates = extractDates(spans);

  for (const raw of extractNumbers(claim)) {
    if (!spanNumbers.has(normalizeNumeric(raw))) {
      violations.push({
        code: 'number_not_in_span',
        detail: `"${raw}" appears in the claim but in no cited span — a derived or invented number, either way it must be quoted or the claim rewritten`,
        token: raw,
      });
    }
  }

  for (const raw of extractDates(claim)) {
    if (!dateSupported(raw, spanDates)) {
      violations.push({
        code: 'date_not_in_span',
        detail: `"${raw}" appears in the claim but in no cited span`,
        token: raw,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Convenience for a whole Finding. `so_what` is deliberately NOT checked: it is
 *  our interpretation, not a quotation, and demanding it be sourced would push
 *  authors to strip the consequence — the one part that makes it intelligence. */
export const assertFindingL0 = (finding: Finding, retrievedUrls: Iterable<string>): L0Result =>
  assertL0({ claim: finding.claim, evidence: finding.evidence, retrievedUrls });
