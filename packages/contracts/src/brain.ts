/**
 * The Brain snapshot contract — the boundary between taskly.ca and TMOS.
 *
 * TMOS does not own company truth and never stores a company fact. The Brain
 * (`taskly-brain/` in the marketplace repo) is authoritative for what Taskly
 * charges, ships and has decided; TMOS is authoritative for what the outside
 * world is doing. This file is the seam, and it is deliberately one-way: facts
 * flow Brain → TMOS, and the only thing that flows back is a pull request a
 * human reviews.
 *
 * **The consumer owns the schema.** The exporter lives in the other repo and
 * cannot import this file. That is the point: if the exporter drifts, parsing
 * fails loudly here instead of silently ingesting a shape we no longer expect.
 * A snapshot that does not validate is a broken sync, never an empty one.
 */
import { z } from 'zod';

/** Mirrors `TYPES` in taskly.ca `scripts/check-brain.mjs`. */
export const brainTypeSchema = z.enum([
  'map',
  'overview',
  'spec',
  'runbook',
  'decision',
  'policy',
  'research',
  'tracker',
  'reference',
  'standard',
  'incident',
  'plan',
]);
export type BrainType = z.infer<typeof brainTypeSchema>;

/** Mirrors `STATUSES` in taskly.ca `scripts/check-brain.mjs`. */
export const brainStatusSchema = z.enum(['canonical', 'supporting', 'draft', 'superseded']);
export type BrainStatus = z.infer<typeof brainStatusSchema>;

/**
 * What a document of a given status is ALLOWED to do in a generated answer.
 *
 * This is the trust ladder, and it exists as one function because it is the
 * kind of rule that gets re-implemented slightly differently in three places
 * and then disagrees with itself. Everything downstream — retrieval filters,
 * grounding checks, citation rendering — asks here.
 *
 *   grounds          a claim may rest on this document alone
 *   corroborates     may support a claim, may not be its sole basis
 *   context_only     may inform phrasing; may NEVER be cited as evidence
 *   never_retrieved  excluded from the index entirely
 */
export type GroundingRight = 'grounds' | 'corroborates' | 'context_only' | 'never_retrieved';

const GROUNDING: Record<BrainStatus, GroundingRight> = {
  // Reviewed, dated, and the designated answer for its question.
  canonical: 'grounds',
  // True as far as it goes, but not the designated answer. Enough to corroborate
  // a canonical source; not enough to carry a claim by itself.
  supporting: 'corroborates',
  // Unreviewed. A draft is somebody thinking out loud, and the single fastest
  // way to launder a guess into a stated fact is to let one be cited.
  draft: 'context_only',
  // Explicitly replaced. Retrieving it at all risks answering from a document
  // the company has already decided is wrong.
  superseded: 'never_retrieved',
};

export const groundingRightFor = (status: BrainStatus): GroundingRight => GROUNDING[status];

export const mayGroundFact = (status: BrainStatus): boolean =>
  groundingRightFor(status) === 'grounds';

export const isRetrievable = (status: BrainStatus): boolean =>
  groundingRightFor(status) !== 'never_retrieved';

/**
 * Days after which a `canonical` document's review has gone stale.
 *
 * Matches `STALE_DAYS` in taskly.ca's brain gate. A stale canonical still
 * grounds — it is the designated answer and demoting it silently would be worse
 * than citing it — but it MUST carry a staleness caveat, so the reader sees the
 * document has not been checked against the code in three months.
 */
export const BRAIN_STALE_DAYS = 90;

export const brainChunkSchema = z.object({
  /** Stable within a document: `${docSha}:${ordinal}`. */
  chunkId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  /** The heading path, so a citation can name a section and not just a file. */
  heading: z.string(),
  text: z.string().min(1),
  /** Content hash of THIS chunk. Re-embedding is keyed on it, so an edit to one
   *  section does not re-embed the other forty. */
  chunkSha: z.string().min(1),
});
export type BrainChunk = z.infer<typeof brainChunkSchema>;

export const brainDocSchema = z.object({
  /** Vault-relative, e.g. `20-architecture/SYSTEM.md`. The stable identity. */
  path: z.string().min(1),
  title: z.string(),
  type: brainTypeSchema,
  status: brainStatusSchema,
  /** `YYYY-MM-DD`. Required by the gate whenever status is canonical. */
  reviewed: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /**
   * Known limits on the document's body, authored in its frontmatter.
   *
   * These are injected into any answer that cites the document — not stored and
   * forgotten. A caveat that lives only in the source file is a caveat nobody
   * reads at the moment it matters.
   */
  caveats: z.array(z.string()).default([]),
  /** Code paths the document's numbers must be checked against. */
  verify: z.array(z.string()).default([]),
  /** Set when status is superseded; the document that replaced it. */
  supersededBy: z.array(z.string()).default([]),
  /** Hash of the whole file. The diff key: unchanged sha ⇒ skip entirely. */
  docSha: z.string().min(1),
  chunks: z.array(brainChunkSchema),
});
export type BrainDoc = z.infer<typeof brainDocSchema>;

export const brainSnapshotSchema = z.object({
  /** Bumped when the SHAPE changes, so an old TMOS refuses a new snapshot
   *  rather than misreading it. */
  schemaVersion: z.literal(1),
  /** The taskly.ca commit this was generated from — makes a sync auditable. */
  commit: z.string().min(1),
  generatedAt: z.string().datetime(),
  docs: z.array(brainDocSchema),
});
export type BrainSnapshot = z.infer<typeof brainSnapshotSchema>;

/**
 * Is a canonical document overdue for review, as of `now`?
 *
 * Returns false for every other status: staleness is only meaningful for the
 * documents that claim to be the designated answer.
 */
export function isStale(doc: BrainDoc, now: Date): boolean {
  if (doc.status !== 'canonical' || !doc.reviewed) return false;
  const reviewed = new Date(`${doc.reviewed}T00:00:00.000Z`).getTime();
  if (Number.isNaN(reviewed)) return false;
  return now.getTime() - reviewed > BRAIN_STALE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Every caveat that must ride along with a citation of this document —
 * the authored ones, plus any the snapshot itself implies.
 */
export function effectiveCaveats(doc: BrainDoc, now: Date): string[] {
  const out = [...doc.caveats];
  if (isStale(doc, now)) {
    out.push(
      `Reviewed ${doc.reviewed}, more than ${BRAIN_STALE_DAYS} days ago — verify against ${
        doc.verify.length > 0 ? doc.verify.join(', ') : 'the code'
      } before relying on any number here.`,
    );
  }
  if (doc.status === 'supporting') {
    out.push('Supporting document — corroborates, but should not be the sole basis for a claim.');
  }
  if (doc.status === 'draft') {
    out.push('DRAFT — unreviewed thinking. Must not be cited as evidence for a factual claim.');
  }
  return out;
}
