/**
 * The feed — findings in reverse-chronological order, as a data structure a UI
 * renders and a test can hold in one hand.
 *
 * Four properties are load-bearing, and each is here because the obvious
 * implementation gets it wrong:
 *
 * 1. A corrected claim must not quietly come back. Superseded findings are
 *    excluded by DEFAULT and reachable only through an explicit filter. The
 *    correction history is worth having; a corrected claim resurfacing with a
 *    fresh timestamp is worse than never publishing the correction.
 * 2. Nothing here renders confidence as a number, and `domain_score` — which
 *    exists for RANKING — never reaches a row. See basis.ts for why a number
 *    that looks like evidence and cannot be audited is worse than silence.
 * 3. Ordering is TOTAL. Equal `created_at` values are broken by id, so the same
 *    set produces the same page whatever order it arrives in. Relying on sort
 *    stability instead would make the feed a function of upstream row order.
 * 4. Pagination cannot truncate silently: the page states the total, whether
 *    more exist, and how many rows the superseded rule removed.
 */
import type { Basis, EvidenceRef, Finding } from '@tmos/contracts';
import { assertNoConfidenceNumber, basisDisplay, mayQuoteAsFact, renderBasis } from '../basis.js';
import { ALL_DISMISS_REASONS, dismissMeaning } from '../feedback.js';
import type { DismissMeaning, DismissReason, FeedbackAction } from '../feedback.js';

export type Stakes = Finding['stakes'];
export type Region = Finding['region'];

/** Basis as a reader sees it: a label, what it means, what they may do with it.
 *  Shared by every view in this folder so one surface cannot drift from another. */
export interface RenderedBasis {
  basis: Basis;
  label: string;
  meaning: string;
  action: string;
  /** Whether this may be quoted as fact, or only used to decide where to look. */
  quotableAsFact: boolean;
}

export function renderedBasis(basis: Basis, independentSources?: number): RenderedBasis {
  const d = basisDisplay(basis);
  return {
    basis,
    label: renderBasis(basis, independentSources),
    meaning: d.meaning,
    action: d.action,
    quotableAsFact: mayQuoteAsFact(basis),
  };
}

export interface FeedbackAffordance {
  findingId: string;
  actions: readonly FeedbackAction[];
  dismissOptions: ReadonlyArray<{
    reason: DismissReason;
    label: string;
    blames: DismissMeaning['blames'];
  }>;
  /** `recordFeedback` refuses an unreasoned dismissal, so the surface must not
   *  offer a bare dismiss button. Stated here rather than left to the UI. */
  dismissRequiresReason: true;
}

const FEEDBACK_ACTIONS: readonly FeedbackAction[] = ['viewed', 'saved', 'dismissed', 'acted_on'];

export const feedbackAffordance = (findingId: string): FeedbackAffordance => ({
  findingId,
  actions: FEEDBACK_ACTIONS,
  dismissOptions: ALL_DISMISS_REASONS.map((reason) => {
    const m = dismissMeaning(reason);
    return { reason, label: m.label, blames: m.blames };
  }),
  dismissRequiresReason: true,
});

export interface FeedRow {
  id: string;
  claim: string;
  soWhat: string;
  subjects: readonly string[];
  stakes: Stakes;
  region: Region;
  createdAt: string;
  /** INDEPENDENT sources after copy-chain collapse — never the evidence count. */
  sourceCount: number;
  basis: RenderedBasis;
  superseded: { by: string; reason: string | null } | null;
  feedback: FeedbackAffordance;
}

export type SupersededMode = 'exclude' | 'include' | 'only';

export interface FeedFilter {
  /** Matches a row carrying ANY of these subject refs. */
  subjects?: readonly string[];
  stakes?: readonly Stakes[];
  basis?: readonly Basis[];
  region?: readonly Region[];
  /** Inclusive lower bound on `created_at`. */
  since?: string;
  /** Exclusive upper bound on `created_at`. */
  until?: string;
  /** Default `exclude`. See the file header. */
  superseded?: SupersededMode;
}

export type FeedOrder = 'recent' | 'ranked';

export interface FeedQuery {
  filter?: FeedFilter;
  order?: FeedOrder;
  offset?: number;
  limit?: number;
  /**
   * Copy-chain collapse. Ten outlets republishing one press release are ONE
   * source; counting them as ten is the mechanism by which a single fabricated
   * claim becomes "widely reported". The default collapses by host, which is
   * the honest floor — a real chain map is the caller's to inject.
   */
  independentSourceKey?: (evidence: EvidenceRef) => string;
}

export interface FeedPage {
  rows: readonly FeedRow[];
  /** Matching rows BEFORE the page window — so the reader knows what is behind. */
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  /** Rows that passed every other filter and were removed for being superseded.
   *  A non-zero count is the affordance that makes the history discoverable. */
  supersededHidden: number;
  order: FeedOrder;
}

const DEFAULT_LIMIT = 20;

function defaultSourceKey(e: EvidenceRef): string {
  try {
    return new URL(e.source_url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return e.source_url;
  }
}

/** Shared by every view: the number rendered next to `inferred_from_sources`
 *  must be INDEPENDENT sources, never the length of the evidence array. */
export function independentSourceCount(
  evidence: readonly EvidenceRef[],
  keyOf: (e: EvidenceRef) => string = defaultSourceKey,
): number {
  return new Set(evidence.map(keyOf)).size;
}

export function feedRow(f: Finding, keyOf: (e: EvidenceRef) => string = defaultSourceKey): FeedRow {
  // The guard runs on what a human will read. A finding that states its own
  // confidence as a number must not reach a surface, and failing loudly here is
  // the only way that stays true — a check whose result can be ignored will be.
  assertNoConfidenceNumber(`${f.claim} ${f.so_what}`);
  const sourceCount = independentSourceCount(f.evidence, keyOf);
  return {
    id: f.id,
    claim: f.claim,
    soWhat: f.so_what,
    subjects: [...f.subject_refs],
    stakes: f.stakes,
    region: f.region,
    createdAt: f.created_at,
    sourceCount,
    basis: renderedBasis(f.basis, sourceCount),
    superseded: f.superseded_by ? { by: f.superseded_by, reason: f.supersede_reason } : null,
    feedback: feedbackAffordance(f.id),
  };
}

const at = (iso: string): number => Date.parse(iso);

function matches(f: Finding, filter: FeedFilter): boolean {
  if (filter.subjects && !f.subject_refs.some((s) => filter.subjects?.includes(s))) return false;
  if (filter.stakes && !filter.stakes.includes(f.stakes)) return false;
  if (filter.basis && !filter.basis.includes(f.basis)) return false;
  if (filter.region && !filter.region.includes(f.region)) return false;
  if (filter.since && at(f.created_at) < at(filter.since)) return false;
  if (filter.until && at(f.created_at) >= at(filter.until)) return false;
  return true;
}

/** Total order. The id tie-break is what makes two calls agree. */
function compare(a: Finding, b: Finding, order: FeedOrder): number {
  if (order === 'ranked' && a.domain_score !== b.domain_score) {
    return b.domain_score - a.domain_score;
  }
  const byTime = at(b.created_at) - at(a.created_at);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildFeed(findings: readonly Finding[], query: FeedQuery = {}): FeedPage {
  const filter = query.filter ?? {};
  const mode: SupersededMode = filter.superseded ?? 'exclude';
  const order: FeedOrder = query.order ?? 'recent';

  const passed = findings.filter((f) => matches(f, filter));
  const kept = passed.filter((f) => {
    const isSuperseded = f.superseded_by !== null;
    if (mode === 'only') return isSuperseded;
    if (mode === 'include') return true;
    return !isSuperseded;
  });
  const supersededHidden = mode === 'exclude' ? passed.length - kept.length : 0;

  const sorted = [...kept].sort((a, b) => compare(a, b, order));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT));
  const window = sorted.slice(offset, offset + limit);
  const consumed = offset + window.length;

  return {
    rows: window.map((f) => feedRow(f, query.independentSourceKey)),
    total: sorted.length,
    offset,
    limit,
    hasMore: consumed < sorted.length,
    nextOffset: consumed < sorted.length ? consumed : null,
    supersededHidden,
    order,
  };
}
