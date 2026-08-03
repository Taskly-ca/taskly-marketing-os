/**
 * THE INTELLIGENCE SPINE.
 *
 * These four types are the durable asset. Collection and drafting are
 * commodities that get cheaper every quarter; a calibrated track record is not
 * copyable. The loop closes WITHOUT revenue data because predictions resolve
 * against the observable world.
 */
import { z } from 'zod';
import { evidenceRefSchema, regionSchema } from './core.js';

/* ── Beliefs ──────────────────────────────────────────────────────────────── */

export const beliefSchema = z.object({
  id: z.uuid(),
  statement: z.string().min(1), // ONE falsifiable claim, present tense
  p: z.number().min(0.01).max(0.99),
  prior_p: z.number().min(0.01).max(0.99),
  status: z.enum(['active', 'weakened', 'falsified', 'retired']),
  region: regionSchema.nullable(),
  valid_from: z.iso.datetime(),
  valid_to: z.iso.datetime().nullable(),
  supports: z.array(evidenceRefSchema).default([]),
  contradicts: z.array(evidenceRefSchema).default([]),
  /** ATMS-style justification edges. When a belief falsifies, a recursive CTE
   *  over this column mechanically enumerates the blast radius — every
   *  downstream belief and decision that inherited it. */
  derived_from: z.array(z.uuid()).default([]),
  /** NOT NULL, deliberately. A belief with no stated falsifier is not a belief,
   *  it is a mood. Rejected at the schema level, not in review. */
  falsifier: z.string().min(1),
  last_confirmed_at: z.iso.datetime().nullable(),
});
export type Belief = z.infer<typeof beliefSchema>;

/** A belief update. The model may PROPOSE a delta; the write goes through a
 *  deterministic rule in TypeScript, because LLMs drift toward whatever was
 *  last asserted. The arithmetic never lives in the model. */
export const beliefUpdateSchema = z.object({
  belief_id: z.uuid(),
  from_p: z.number().min(0.01).max(0.99),
  to_p: z.number().min(0.01).max(0.99),
  evidence: evidenceRefSchema, // conversational assertion alone is not evidence
  rationale: z.string().min(1),
  at: z.iso.datetime(),
});
export const MAX_BELIEF_DELTA = 0.2 as const; // sycophancy cap, per evidence item

/* ── Predictions — the calibration engine ─────────────────────────────────── */

/** The resolver MUST dry-run at write time. If it cannot execute today against
 *  past data and return a value, the prediction is not machine-scoreable and is
 *  rejected. This is what separates "will X gain traction" from
 *  "will X's category count exceed 40 on 2026-11-01 per the weekly snapshot". */
export const resolverSchema = z.object({
  kind: z.enum(['sql', 'http_json', 'scrape_assert', 'manual']),
  spec: z.string().min(1),
  source_url: z.url(),
  fallback: z.literal('annul'), // ambiguity annuls; it never guesses
});

export type ResolverSpec = z.infer<typeof resolverSchema>;

export const predictionSchema = z.object({
  id: z.uuid(),
  decision_id: z.uuid().nullable(),
  belief_ids: z.array(z.uuid()).default([]),
  claim: z.string().min(1), // binary or thresholded ONLY
  p: z.number().min(0.01).max(0.99), // clamped — never 0 or 1
  /** Humans and agents are scored on the same question set, always separately.
   *  That comparison is the most valuable output the system produces. */
  author: z.string().regex(/^(human|agent):/),
  created_at: z.iso.datetime(),
  resolve_at: z.iso.datetime(),
  resolver: resolverSchema,
  /** Frozen at write time so the resolver's data can never reach the
   *  forecaster — that is temporal leakage, and it silently inflates skill. */
  evidence_snapshot_hash: z.string(),
});
export type Prediction = z.infer<typeof predictionSchema>;

export const resolutionSchema = z.object({
  prediction_id: z.uuid(),
  outcome: z.union([z.literal(0), z.literal(1), z.literal('annulled')]),
  observed: z.unknown(),
  resolved_at: z.iso.datetime(),
});

export const scoreSchema = z.object({
  prediction_id: z.uuid(),
  brier: z.number(), // insensitive to rare events
  log: z.number(), // punishes confident wrongness
  baseline: z.number(), // vs always-50%; raw Brier is uninterpretable alone
  peer: z.number().nullable(),
});

/* ── Decisions ────────────────────────────────────────────────────────────── */

export const decisionRecordSchema = z.object({
  id: z.string().regex(/^DEC-\d{4}-\d{3}$/),
  status: z.enum(['proposed', 'accepted', 'reversed', 'superseded']),
  door: z.enum(['one_way', 'two_way']), // reversibility sets required rigor
  context: z.string().min(1),
  decision: z.string().min(1),
  /** ≥2 or the record is invalid. With ≥1 prediction below, this single
   *  constraint is the whole mechanism — everything else is metadata. */
  alternatives: z.array(z.object({ option: z.string(), why_rejected: z.string() })).min(2),
  beliefs_relied_on: z.array(z.uuid()).default([]),
  predictions: z.array(z.uuid()).min(1),
  kill_criteria: z
    .array(z.object({ metric: z.string(), threshold: z.number(), by: z.iso.date() }))
    .min(1),
  expected_cost_cents: z.number().int().nonnegative(),
  decided_at: z.iso.datetime(),
  decided_by: z.string(),
  outcome: z
    .object({
      result: z.enum(['good', 'bad', 'mixed']),
      /** The anti-*resulting* field. Judging decisions by outcomes destroys
       *  learning, so good-process/bad-outcome must stay queryable. */
      luck_attribution: z.enum(['process', 'luck', 'unknown']),
      notes: z.string(),
    })
    .nullable(),
});
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

/* ── Playbooks ────────────────────────────────────────────────────────────── */

/** Typed and machine-evaluable — NOT prose. Selection filters deterministically
 *  with zero LLM calls before anything is loaded into context. */
export const predicateSchema = z.object({
  field: z.string(),
  op: z.enum(['=', '!=', '<', '<=', '>', '>=', 'in', 'not_in']),
  value: z.unknown(),
});

export const playbookSchema = z.object({
  id: z.string().regex(/^pb_[a-z0-9_]+$/),
  version: z.number().int().positive(), // append-only; a shipped version never mutates
  title: z.string().min(1),
  intent: z.string().min(1),
  /** Earned from the run ledger, never declared. */
  status: z.enum(['candidate', 'proven', 'retired']),
  applies_when: z.array(predicateSchema),
  /** Hard negatives learned from failures — the highest-value field here. */
  excludes_when: z.array(predicateSchema).default([]),
  params: z.record(
    z.string(),
    z.object({
      type: z.enum(['money_cents', 'int', 'enum', 'text', 'duration_days', 'ref']),
      /** e.g. 'facts.COMMISSION_RATE' — binds to the generated FACT-SHEET, not
       *  to a memory of it. The INC-001 defence, applied to playbooks. */
      derive_from: z.string().optional(),
      required: z.boolean(),
    }),
  ),
  steps: z.array(
    z.object({
      n: z.number().int().positive(),
      do: z.string(),
      owner: z.enum(['agent', 'human']),
      gate: predicateSchema.optional(),
    }),
  ),
  hypothesis: z.object({
    metric: z.string(),
    direction: z.enum(['up', 'down']),
    expected_effect: z.tuple([z.number(), z.number()]),
    horizon_days: z.number().int().positive(),
    min_n: z.number().int().positive(),
  }),
  kill_criteria: z.array(predicateSchema).min(1),
  assumptions: z.array(z.string()).default([]), // each becomes a pre-mortem target
  decay_after_days: z.number().int().positive(),
});
export type Playbook = z.infer<typeof playbookSchema>;

export const playbookRunSchema = z.object({
  run_id: z.uuid(),
  playbook_id: z.string(),
  playbook_version: z.number().int().positive(),
  situation_snapshot: z.record(z.string(), z.unknown()), // enables held-out replay
  params_bound: z.record(z.string(), z.unknown()),
  /** Recorded BEFORE the outcome. This one mechanic is worth more than the rest
   *  of the memory system combined — it is what kills self-serving history. */
  prediction: z.object({
    metric: z.string(),
    point: z.number(),
    ci80: z.tuple([z.number(), z.number()]),
    recorded_at: z.iso.datetime(),
  }),
  outcome: z
    .object({
      metric_actual: z.number().nullable(),
      verdict: z.enum(['win', 'loss', 'inconclusive', 'aborted']),
      measured_at: z.iso.datetime(),
      confounds: z.array(z.string()).default([]),
    })
    .nullable(),
  lessons: z
    .array(z.object({ kind: z.enum(['do', 'dont', 'precondition']), text: z.string() }))
    .default([]),
});
export type PlaybookRun = z.infer<typeof playbookRunSchema>;
