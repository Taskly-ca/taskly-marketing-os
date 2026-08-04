/**
 * The LLM adjudicator — the only stage that costs money, so it runs on the only
 * pairs where money buys anything: the 0.75–0.95 band, where the scorer is
 * genuinely undecided. Above the band we merge without asking; below it we
 * reject without asking. A model called outside that band is pure spend.
 *
 * **In-context clustering.** The naive shape is one call per pair, which is
 * O(N²) calls per target and — worse — lets the model contradict itself: it can
 * say A=B and B=C and A≠C, because it never saw the three together. Instead we
 * hand it the target plus its candidates in ONE call and ask for a partition.
 * A partition is internally consistent by construction.
 *
 * The candidate list is ordered by DESCENDING similarity, which does two jobs:
 * the strongest evidence lands early, where attention is reliably highest, and
 * truncation then drops the WEAKEST candidates rather than an arbitrary subset.
 * Truncating an unsorted list silently discards the best match sometimes.
 *
 * No provider SDK is imported here. `AdjudicatorPort` is a narrow interface the
 * caller supplies, which is what keeps the LLM budget ceiling in one place and
 * these tests keyless.
 */
import { AUTO_MERGE, AUTO_REJECT, bandFor } from './blocking.js';
import type { ErRecord } from './blocking.js';
import { identityVerdict } from '../identity.js';

/**
 * Nine candidates plus the target.
 *
 * Accuracy on a set-partition task degrades as the set grows — more pairwise
 * relations to hold at once, and the middle of a long list is where items get
 * dropped. Nine keeps the whole cluster in the region where the task stays
 * reliable while still collapsing almost every real GTA candidate set into a
 * single call. If a target genuinely has more than nine candidates in the band,
 * that is a signal about the pool (a generic name like "Toronto Cleaning"), and
 * the tail belongs in human review, not in a bigger prompt.
 */
export const MAX_CLUSTER_SIZE = 9;

/** Only fields the decision needs. Never raw scraped text — see AGENTS.md #4. */
export interface AdjudicationEntity {
  id: string;
  /** The NORMALIZED name. */
  name: string;
  region: string | null;
  /** `kind:value`, sorted, so the payload is byte-stable. */
  hardKeys: string[];
}

export interface AdjudicationCandidate extends AdjudicationEntity {
  /** Rounded to 3dp so the same pair produces the same cache key every run. */
  score: number;
}

export interface AdjudicationRequest {
  target: AdjudicationEntity;
  /** Descending by score, ties by id. Never longer than MAX_CLUSTER_SIZE. */
  candidates: AdjudicationCandidate[];
}

/** What the model is asked to return: a partition of the ids it was given. */
export interface AdjudicationResponse {
  groups: { ids: string[] }[];
  rationale?: string;
}

export interface AdjudicatorPort {
  partition(req: AdjudicationRequest): Promise<AdjudicationResponse>;
}

export type AdjudicationOutcome =
  | { decision: 'merge'; targetId: string; mergeWith: string[]; rationale: string }
  | { decision: 'no_match'; targetId: string; rationale: string }
  /** Nothing was in the band — there was no question to ask. */
  | { decision: 'skip'; reason: string }
  /** Something was wrong with the answer. Falls through to human review. */
  | { decision: 'abstain'; reason: string };

export interface ScoredCandidate {
  record: ErRecord;
  score: number;
}

const RATIONALE_MAX = 500;

const entityOf = (rec: ErRecord): AdjudicationEntity => ({
  id: rec.id,
  name: rec.name.norm,
  region: rec.region?.trim().toLowerCase() || null,
  hardKeys: [...(rec.keys ?? [])].map((k) => `${k.kind}:${k.valueNorm}`).sort(),
});

/**
 * The request payload, built deterministically.
 *
 * Two caps, both hard:
 *  - band: only `AUTO_REJECT ≤ score < AUTO_MERGE` survives.
 *  - identity: a pair `identityVerdict` already settled (shared hard key, or an
 *    exact-only name that did not match exactly) is NEVER sent. Asking a model
 *    to re-open a decision the index already made is how a deterministic
 *    guarantee turns into a probabilistic one.
 */
export function buildRequest(
  target: ErRecord,
  candidates: readonly ScoredCandidate[],
): AdjudicationRequest {
  const eligible = candidates.filter((c) => {
    if (c.record.id === target.id) return false;
    if (bandFor(c.score) !== 'adjudicate') return false;
    const verdict = identityVerdict(
      { keys: [...(target.keys ?? [])], name: target.name },
      { keys: [...(c.record.keys ?? [])], name: c.record.name },
    );
    return verdict.decision === 'score';
  });

  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
  });

  return {
    target: entityOf(target),
    candidates: eligible.slice(0, MAX_CLUSTER_SIZE).map((c) => ({
      ...entityOf(c.record),
      score: Math.round(c.score * 1000) / 1000,
    })),
  };
}

/**
 * Defensive validation of the partition.
 *
 * A model can return a plausible-looking object that is not a partition at all:
 * ids we never sent, candidates silently dropped, or the same id in two groups.
 * Every one of those is ambiguous about what to merge, and a wrong merge is not
 * reversible in practice. So each of them ABSTAINS — the pair falls through to
 * human review, which is the outcome we would have had without the model.
 * Repairing a malformed partition by guessing is the one thing not allowed.
 */
export function validatePartition(
  req: AdjudicationRequest,
  res: AdjudicationResponse | null | undefined,
): AdjudicationOutcome {
  const rationale = (res?.rationale ?? '').slice(0, RATIONALE_MAX);
  const abstain = (reason: string): AdjudicationOutcome => ({ decision: 'abstain', reason });

  if (!res || !Array.isArray(res.groups)) return abstain('response has no groups array');

  const known = new Set<string>([req.target.id, ...req.candidates.map((c) => c.id)]);
  const seen = new Set<string>();
  const groups: string[][] = [];

  for (const group of res.groups) {
    if (!group || !Array.isArray(group.ids)) return abstain('a group has no ids array');
    if (group.ids.length === 0) return abstain('a group is empty');
    for (const id of group.ids) {
      if (typeof id !== 'string' || !known.has(id)) return abstain(`unknown id "${String(id)}"`);
      if (seen.has(id)) return abstain(`id "${id}" appears in more than one group`);
      seen.add(id);
    }
    groups.push([...group.ids]);
  }

  for (const id of known) {
    if (!seen.has(id)) return abstain(`id "${id}" was omitted from the partition`);
  }

  const cluster = groups.find((g) => g.includes(req.target.id));
  if (!cluster) return abstain('the target is not in any group');

  const mergeWith = cluster.filter((id) => id !== req.target.id).sort();
  return mergeWith.length === 0
    ? { decision: 'no_match', targetId: req.target.id, rationale }
    : { decision: 'merge', targetId: req.target.id, mergeWith, rationale };
}

/**
 * One target, one call, one validated outcome.
 *
 * A throwing port is treated exactly like a malformed answer: abstain. A
 * timeout or a 500 is not evidence about the entities, so it must not become a
 * merge or a rejection.
 */
export async function adjudicate(
  target: ErRecord,
  candidates: readonly ScoredCandidate[],
  port: AdjudicatorPort,
): Promise<AdjudicationOutcome> {
  const req = buildRequest(target, candidates);
  if (req.candidates.length === 0) {
    return {
      decision: 'skip',
      reason: `no candidate in the adjudication band [${AUTO_REJECT}, ${AUTO_MERGE})`,
    };
  }
  let res: AdjudicationResponse;
  try {
    res = await port.partition(req);
  } catch (err) {
    return { decision: 'abstain', reason: `adjudicator failed: ${(err as Error).message}` };
  }
  return validatePartition(req, res);
}
