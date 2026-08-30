/**
 * The evaluation harness, as one door.
 *
 * Re-exported from `@tmos/research` so a console route, a script or a live test
 * reaches the same scoring code. The split inside is the contract: `metrics`
 * and `harness` are deterministic and free; `judge` is a model with an opinion
 * and says so in its own type.
 */
export * from './types.js';
export * from './metrics.js';
export * from './cases.js';
export * from './harness.js';
export * from './judge.js';
