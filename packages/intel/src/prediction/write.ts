/**
 * The write path — the only sanctioned way a prediction enters the ledger.
 *
 * It enforces the two properties that make the calibration loop trustworthy:
 *   1. the resolver DRY-RUNS successfully at write time, and
 *   2. the evidence the forecaster saw is frozen and hashed (temporal-leakage
 *      guard: the resolver's own data must never be inside that snapshot, or
 *      apparent skill is inflated for free).
 */
import { randomUUID } from 'node:crypto';
import { resolverSchema } from '@tmos/contracts';
import { dryRun } from '../resolver/kinds.js';
import type { ResolverContext, ResolverSpec } from '../resolver/types.js';
import {
  hashEvidence,
  validate,
  PredictionRejected,
  type PredictionRecord,
  type PredictionStore,
} from './store.js';

export interface WritePredictionInput {
  claim: string;
  p: number;
  author: string;
  resolve_at: string;
  resolver: ResolverSpec;
  /** Exactly what the forecaster was shown. Hashed, never re-read for scoring. */
  evidence: unknown;
  decision_id?: string | null;
  belief_ids?: string[];
  now?: Date;
  id?: string;
}

export async function writePrediction(
  store: PredictionStore,
  input: WritePredictionInput,
  ctx: ResolverContext,
): Promise<PredictionRecord> {
  const now = input.now ?? new Date();
  const created_at = now.toISOString();

  // Validate the resolver shape at the boundary before we try to execute it —
  // a malformed spec should fail with a schema error, not a confusing dry-run one.
  const specParse = resolverSchema.safeParse(input.resolver);
  if (!specParse.success) {
    throw new PredictionRejected(`invalid resolver spec: ${specParse.error.issues[0]?.message}`);
  }

  validate({
    claim: input.claim,
    p: input.p,
    author: input.author,
    created_at,
    resolve_at: input.resolve_at,
  });

  // THE GATE. A prediction whose resolver cannot execute today is not
  // machine-scoreable, and an unscoreable prediction is worse than none —
  // it looks like a track record without being one.
  const dry = await dryRun(input.resolver, ctx);
  if (!dry.ok) {
    throw new PredictionRejected(
      `resolver failed its dry-run, so this claim is not machine-scoreable: ${dry.error}`,
    );
  }

  const record: PredictionRecord = {
    id: input.id ?? randomUUID(),
    claim: input.claim,
    p: input.p,
    author: input.author,
    created_at,
    resolve_at: input.resolve_at,
    resolver: input.resolver,
    evidence_snapshot_hash: hashEvidence(input.evidence),
    decision_id: input.decision_id ?? null,
    belief_ids: input.belief_ids ?? [],
    outcome: null,
    observed: null,
    resolved_at: null,
    annul_reason: null,
  };

  await store.insert(record);
  return record;
}
