/**
 * The guardrails: the checks that run on generated text before a human sees it.
 *
 *   causal   — a claim below rung 2 may not use causal language
 *   honesty  — Taskly's trust-claim boundary, surface-aware and fail-closed
 */
export * from './causal.js';
export * from './honesty.js';
