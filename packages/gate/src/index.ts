/**
 * T0 — the gate: everything that runs on the raw firehose before an LLM sees a
 * single item. Cheap, deterministic, and the reason the LLM bill stays roughly
 * flat as source count grows.
 *
 * Order matters: canonical URL (free) → SimHash near-dup (cheap) → statistical
 * detectors (still free) → FDR across the whole panel → only survivors go on.
 */
export * from './canonical.js';
export * from './simhash.js';
export * from './events.js';

export * from './detectors/types.js';
export * from './detectors/robust-z.js';
export * from './detectors/count-tails.js';
export * from './detectors/drift.js';
export * from './detectors/fdr.js';
