/**
 * DOMAIN-NEUTRAL CORE.
 *
 * Nothing in this file may mention marketing. These eight types are the seam
 * that lets TMOS become a Company Intelligence Platform: a new domain (product,
 * support, competitive) is added as a DomainPack that registers subject types,
 * metrics, sources and investigation templates — with zero changes here.
 *
 * `Finding` is the load-bearing abstraction: push, pull, chat and briefs are all
 * RENDERINGS of Findings. If the digest and the feed are separate pipelines,
 * the thing that fails has already been built.
 */
import { z } from 'zod';

export const regionSchema = z.enum(['ca', 'in', 'global']);
export type Region = z.infer<typeof regionSchema>;

/** Source tier — a scored rubric dimension, because agents left alone prefer
 *  SEO content farms over primary sources, and automated judges miss it. */
export const sourceTierSchema = z.enum(['first_party', 'primary', 'trade', 'aggregator', 'farm']);

export const sourceSchema = z.object({
  id: z.uuid(),
  kind: z.string(), // 'rss' | 'hn' | 'gdelt' | ... — open, registered by a DomainPack
  name: z.string().min(1),
  tier: sourceTierSchema,
  region: regionSchema.nullable(),
  /** Freshness cursor. This is what makes delta-research possible — investigate
   *  changes, never re-investigate steady state. */
  cursor: z.string().nullable(),
  etag: z.string().nullable(),
  last_ok_at: z.iso.datetime().nullable(),
  consecutive_failures: z.number().int().nonnegative(),
  /** ACL inherited by every Signal this Source yields. Retrofitting permissions
   *  is a rewrite, so it exists from day one even while everything is internal. */
  visibility: z.enum(['internal', 'restricted']),
  derives_from: z.uuid().nullable(), // copy-chain: 3 blogs quoting 1 release = 1 observation
});
export type Source = z.infer<typeof sourceSchema>;

/** A raw observation. Immutable. Hashed so unchanged content costs nothing. */
export const signalSchema = z.object({
  id: z.uuid(),
  source_id: z.uuid(),
  observed_at: z.iso.datetime(),
  url: z.url().nullable(),
  canonical_url: z.url().nullable(),
  content_hash: z.string(),
  simhash: z.string(), // 64-bit, stored as bigint text
  payload: z.record(z.string(), z.unknown()),
  subject_refs: z.array(z.string()).default([]),
});
export type Signal = z.infer<typeof signalSchema>;

/** The entity registry. Subject TYPES are pluggable; the registry is one table. */
export const subjectRefSchema = z.string().regex(/^[a-z_]+:[a-zA-Z0-9._-]+$/, 'expected `type:id`');

/** How much a claim can be trusted, shown to humans INSTEAD of a confidence
 *  number. LLM self-reported confidence is mechanistically disconnected from
 *  correctness, so we never render it. A basis is checkable; a 0.82 is not. */
export const basisSchema = z.enum([
  'verified_metric',
  'governed_query',
  'inferred_from_sources',
  'exploratory_unverified',
]);
export type Basis = z.infer<typeof basisSchema>;

/** Causal rung. Rung 0 = no control group => the word "caused" is BANNED in any
 *  rendered text. Observational methods routinely fail to recover experimental
 *  effects, so this is enforced by a lint, not by good intentions. */
export const causalRungSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

export const evidenceRefSchema = z.object({
  signal_id: z.uuid().nullable(),
  fact_id: z.uuid().nullable(),
  source_url: z.url(),
  /** The span that supports the claim. L0 asserts every number and date in the
   *  claim appears VERBATIM in this text — that check catches most real damage
   *  and never drifts. */
  span: z.string().min(1),
  observed_at: z.iso.datetime(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/** THE unit of intelligence. Everything a human sees is a rendering of this. */
export const findingSchema = z.object({
  id: z.uuid(),
  claim: z.string().min(1),
  so_what: z.string().min(1), // a Finding without a consequence is a fact, not intelligence
  subject_refs: z.array(subjectRefSchema).min(1),
  evidence: z.array(evidenceRefSchema).min(1), // no claim ships without a source
  basis: basisSchema,
  causal_rung: causalRungSchema,
  stakes: z.enum(['low', 'medium', 'high']),
  region: regionSchema,
  domain_score: z.number().min(0).max(1),
  generated_by: z.string(), // 'agent:model@version' | 'human:<id>'
  reviewed_by: z.string().nullable(),
  superseded_by: z.uuid().nullable(), // corrections supersede; nothing is deleted
  supersede_reason: z.string().nullable(), // causal attribution — required for trust repair
  created_at: z.iso.datetime(),
});
export type Finding = z.infer<typeof findingSchema>;

/** A budgeted research plan. Scheduled monitoring, an ad-hoc question and a deep
 *  research run are all Investigations at different budget tiers. */
export const investigationSchema = z.object({
  id: z.uuid(),
  question: z.string().min(1),
  budget_tier: z.enum(['t0_gate', 't1_skim', 't2_correlate', 't3_deep']),
  max_cost_cents: z.number().int().positive(),
  tools: z.array(z.string()),
  cadence: z.string().nullable(), // cron, or null for one-shot
  materiality_gate: z.number().min(0).max(1),
  region: regionSchema,
});
export type Investigation = z.infer<typeof investigationSchema>;

/** Rendering only. No analysis logic may live here. */
export const briefSchema = z.object({
  id: z.uuid(),
  audience: z.string(),
  channel: z.enum(['slack', 'email', 'web']),
  finding_ids: z.array(z.uuid()),
  rendered_at: z.iso.datetime(),
});
export type Brief = z.infer<typeof briefSchema>;
