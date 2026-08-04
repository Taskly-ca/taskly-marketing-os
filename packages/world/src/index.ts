/**
 * The world model — what we know about the outside world, and when we knew it.
 *
 * Three layers, and the order is the design:
 *
 *   identity  — who an entity IS. Hard keys auto-merge with no score; names are
 *               the fallback, and the fallback is where ER goes wrong.
 *   fact      — bitemporal claims. `valid` (true in the world) and `asserted`
 *               (believed by us) are separate axes, because a competitor
 *               changing their price and us noticing are different events.
 *   golden    — the current best value per attribute, DERIVED on read. Never a
 *               table: a materialized golden record is a second source of truth
 *               that drifts from the facts beneath it.
 *
 * Everything here is pure and port-driven. No package in this repo reaches a
 * database or a network directly.
 */
export * from './identity.js';

export * from './fact/types.js';
export * from './fact/write.js';
export * from './fact/query.js';
export * from './fact/memory-store.js';
export * from './fact/conflict.js';
export * from './fact/reliability.js';
export * from './fact/predicates.js';

export * from './er/blocking.js';
export * from './er/vector.js';
export * from './er/adjudicate.js';
export * from './er/labels.js';

export * from './golden.js';
export * from './query/tools.js';
