/**
 * Retrieval over the Brain index, with the trust ladder enforced STRUCTURALLY.
 *
 * The ladder itself is not defined here — it lives once, in
 * `@tmos/contracts/brain`, and this module asks it. Re-deriving "drafts are
 * context only" in a retrieval filter is exactly the drift the contract exists
 * to prevent: two copies of a rule disagree eventually, and the copy that is
 * wrong is always the one nobody re-reads.
 *
 * What is enforced here, rather than requested of a model:
 *
 *   - A `superseded` document is ABSENT from the result set. Not ranked lower,
 *     not returned with a flag a prompt might overlook. The filter runs on
 *     whatever the port returned, because the port may be a naive `select` and
 *     a defence that depends on the caller is not a defence.
 *   - A `draft` may inform phrasing but can never enter `groundingSet`, so a
 *     factual claim cannot rest on unreviewed thinking.
 *   - `supporting` documents corroborate; `canSupportClaim` refuses a claim
 *     whose entire backing is corroboration.
 *   - Caveats are attached to the hit AT RETRIEVAL TIME. A caveat that lives
 *     only in the source file is a caveat nobody reads at the moment it matters.
 */
import {
  effectiveCaveats,
  groundingRightFor,
  isRetrievable,
  isStale,
  mayGroundFact,
} from '@tmos/contracts';
import type { Basis, BrainChunk, BrainDoc, BrainStatus, GroundingRight } from '@tmos/contracts';

/** `brain_doc` as the index stores it: a document minus its chunk bodies. */
export type BrainDocMeta = Omit<BrainDoc, 'chunks'>;

export interface BrainQuery {
  /** Query embedding, when the caller has one. */
  vector?: readonly number[];
  /** Keyword query — the fallback when embeddings are unavailable. */
  text?: string;
  /** Candidate budget. The result may be SHORTER once the ladder has run. */
  limit: number;
}

export interface BrainIndexCandidate {
  chunk: BrainChunk;
  doc: BrainDocMeta;
  /** Distance from the query — SMALLER is closer, matching pgvector's `<=>`. */
  distance: number;
}

/**
 * The narrow read port. A real implementation is a query against `brain_chunk`
 * joined to `brain_doc`; this module never touches a database, so retrieval
 * policy stays testable without one.
 */
export interface BrainIndexPort {
  search(query: BrainQuery): Promise<readonly BrainIndexCandidate[]>;
}

export interface RetrievedHit {
  chunk: BrainChunk;
  doc: BrainDocMeta;
  distance: number;
  /** What this document is allowed to do in an answer. From the contract. */
  right: GroundingRight;
  /** True when a canonical document's review has lapsed. It still grounds; it
   *  just no longer proves anyone checked it against the code recently. */
  stale: boolean;
  /** Everything that must ride along with a citation of this hit. */
  caveats: string[];
  citation: string;
}

export interface ExcludedCandidate {
  path: string;
  chunkId: string;
  status: BrainStatus;
  reason: string;
}

export interface RetrievalResult {
  hits: RetrievedHit[];
  /** What the port returned and the ladder refused. Reported, not swallowed:
   *  a silent filter is indistinguishable from a broken index. */
  excluded: ExcludedCandidate[];
}

/** The contract's helpers take a whole `BrainDoc` but read only metadata.
 *  Widen for the call; the empty chunk list is never surfaced to a caller. */
const asDoc = (meta: BrainDocMeta): BrainDoc => ({ ...meta, chunks: [] });

/**
 * Path + heading, e.g. `20-architecture/SYSTEM.md § Roles`.
 *
 * "It says so in SYSTEM.md" is not checkable by the person reading the answer;
 * a section is. Chunks that sit above the first heading cite the file alone
 * rather than inventing a section that does not exist.
 */
export function citationFor(hit: Pick<RetrievedHit, 'doc' | 'chunk'>): string {
  const heading = hit.chunk.heading.trim();
  return heading.length > 0 ? `${hit.doc.path} § ${heading}` : hit.doc.path;
}

/** Distance first, then a stable tie-break so two identical queries against an
 *  unordered index can never render two different answers. */
function byRank(a: RetrievedHit, b: RetrievedHit): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.doc.path !== b.doc.path) return a.doc.path < b.doc.path ? -1 : 1;
  if (a.chunk.ordinal !== b.chunk.ordinal) return a.chunk.ordinal - b.chunk.ordinal;
  if (a.chunk.chunkId === b.chunk.chunkId) return 0;
  return a.chunk.chunkId < b.chunk.chunkId ? -1 : 1;
}

export async function retrieve(
  port: BrainIndexPort,
  request: BrainQuery,
  now: Date,
): Promise<RetrievalResult> {
  const candidates = await port.search(request);
  const hits: RetrievedHit[] = [];
  const excluded: ExcludedCandidate[] = [];

  for (const candidate of candidates) {
    const { doc, chunk } = candidate;
    if (!isRetrievable(doc.status)) {
      excluded.push({
        path: doc.path,
        chunkId: chunk.chunkId,
        status: doc.status,
        reason:
          doc.supersededBy.length > 0
            ? `superseded by ${doc.supersededBy.join(', ')} — answering from it would re-publish a corrected error`
            : 'superseded — the company has already decided this document is wrong',
      });
      continue;
    }

    const full = asDoc(doc);
    hits.push({
      chunk,
      doc,
      distance: candidate.distance,
      right: groundingRightFor(doc.status),
      stale: isStale(full, now),
      caveats: effectiveCaveats(full, now),
      citation: citationFor(candidate),
    });
  }

  return { hits: hits.sort(byRank).slice(0, request.limit), excluded };
}

/**
 * The subset a factual claim may actually rest on.
 *
 * Everything else in `hits` is still useful — it can shape phrasing, supply
 * vocabulary, or corroborate — but nothing outside this set may be offered as
 * the reason a claim is true.
 */
export function groundingSet(result: RetrievalResult): RetrievedHit[] {
  return result.hits.filter((hit) => mayGroundFact(hit.doc.status));
}

/**
 * May a claim be made from these hits at all?
 *
 * False when the entire backing is `corroborates`-level. A supporting document
 * is true as far as it goes but is not the designated answer to its question;
 * letting one carry a claim alone quietly promotes "someone wrote this down
 * once" to "this is what Taskly charges". Corroboration needs something to
 * corroborate, so at least one grounding document must be present.
 */
export function canSupportClaim(hits: readonly RetrievedHit[]): boolean {
  return hits.some((hit) => hit.right === 'grounds');
}

/**
 * Map a retrieved set onto the `Basis` shown to humans.
 *
 * Deliberately conservative — when in doubt this returns the weaker basis,
 * because an overstated basis is a claim of rigour we did not perform.
 *
 * `verified_metric` is NEVER returned. A Brain document is prose: even a
 * canonical one restates a number that lives in code, and only a generated
 * fact sheet or an instrumented metric may claim to have measured anything.
 */
export function basisFor(hits: readonly RetrievedHit[]): Basis {
  const grounding = hits.filter((hit) => hit.right === 'grounds');

  if (grounding.length === 0) {
    // Real documents, but none of them the designated answer: whatever we say
    // is inferred from them rather than read off the record.
    return hits.some((hit) => hit.right === 'corroborates')
      ? 'inferred_from_sources'
      : 'exploratory_unverified';
  }

  // A lapsed canonical still GROUNDS — that is the contract's call, and
  // demoting the designated answer silently would be worse. But its review no
  // longer evidences that anyone checked it against the code, so the basis we
  // render to a human drops a rung even though the grounding right does not.
  return grounding.some((hit) => !hit.stale) ? 'governed_query' : 'inferred_from_sources';
}
