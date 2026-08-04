/**
 * The surfaces — everything a human actually sees.
 *
 * One rule governs all of them, and it is in `basis.ts`: a surface shows what
 * an answer RESTS ON, never how confident a model feels. Self-reported
 * confidence is close to uncorrelated with correctness, so a percentage is a
 * number that looks like evidence, cannot be checked, and moves trust without
 * earning it. Provenance can be audited; a feeling cannot.
 *
 *   basis     — the four bases, and the guard that refuses a confidence number
 *   feedback  — the dismissal taxonomy: each reason blames one component
 *   digest    — what earns an interruption, and the quiet-week state
 *   views     — feed, entity page, grid (view models; no UI framework)
 *   interact  — scoped chat and deep-research cost acceptance
 *
 * Nothing here sends, fetches or spends. Delivery and generation are ports the
 * caller wires, so a surface can be tested completely without a network, a
 * workspace, or a key.
 */
export * from './basis.js';
export * from './feedback.js';

export * from './digest/select.js';
export * from './digest/format.js';
export * from './digest/slack.js';

export * from './views/feed.js';
export * from './views/entity-page.js';
export * from './views/grid.js';

export * from './interact/chat.js';
export * from './interact/deep-research.js';
