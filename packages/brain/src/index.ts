/**
 * The Brain bridge — taskly.ca's documentation, mirrored for retrieval.
 *
 * The direction of this package is the point. Facts flow Brain → TMOS; the only
 * thing that flows back is a pull request a human approves. TMOS never stores a
 * company fact of its own, so there is exactly one place where "what Taskly
 * charges" is defined, and it is the vault in the marketplace repo.
 *
 *   ingest   — pull a snapshot, validate it, diff by content hash
 *   embed    — vectorise only what actually changed, versioned by model
 *   retrieve — enforce the trust ladder structurally, not by prompting
 *   contradiction — notice when the Brain and the world disagree, and propose
 *                   an edit for a human to accept or reject
 *
 * The trust ladder itself lives in `@tmos/contracts`, deliberately: it is the
 * kind of rule that gets re-implemented slightly differently in three places
 * and then disagrees with itself.
 *
 * NOTE for whoever writes the Postgres adapter: `ingest.ts` defines a write-side
 * port and `retrieve.ts` a read-side one, over the same two tables. That split
 * is intentional (the read path must not be able to write), but ONE adapter will
 * implement both, and it must honour `contentChanged: true` by clearing the
 * vector columns. If it does not, a stale vector survives an edit silently —
 * the single riskiest untested assumption in this package.
 */
export * from './ingest.js';
export * from './embed.js';
export * from './retrieve.js';
export * from './contradiction.js';
