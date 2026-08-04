/**
 * The reasoning layer — signals in, verified Findings out.
 *
 * Four tiers, cheapest first, because the cost of being thorough about
 * everything is being thorough about nothing:
 *
 *   T0  the gate (packages/gate) — free, deterministic, drops the firehose
 *   T1  skim — small model, cached by content hash, scores materiality
 *   T2  correlate — is this actually new, and does anyone independent say it?
 *   T3  deep — expensive, hard daily quota, candidates rank competitively in
 *
 * And a verification ladder that also runs cheapest-first:
 *
 *   L0  deterministic — numbers and dates must appear verbatim in a cited span
 *   L1  groundedness — does the claim follow, given ONLY that span?
 *   L2  rubric — one call per digest, temperature 0, pinned model version
 *
 * The ordering is the design. There is no point paying a model to judge whether
 * a fabricated number is meaningful, so L0 short-circuits the ladder. And the
 * whole point of tiering is that T3 refuses to degrade: when its quota is gone
 * it stops promoting and says so, rather than quietly producing worse answers.
 */
export * from './finding/store.js';

export * from './tier/t1-skim.js';
export * from './tier/t2-correlate.js';
export * from './tier/t3-orchestrator.js';
export * from './tier/workers.js';

export * from './synthesis.js';

export * from './verify/l0.js';
export * from './verify/adversarial.js';
export * from './verify/judges.js';

export * from './scoring/domain.js';
