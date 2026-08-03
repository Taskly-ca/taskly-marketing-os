/**
 * The prediction ledger.
 *
 * Storage sits behind a port so the whole ledger is testable without a database
 * — which matters because the TMOS Supabase project does not exist yet, and
 * because deterministic keyless tests are the house rule.
 */
import { createHash } from 'node:crypto';
import type { ResolverSpec } from '../resolver/types.js';

export interface PredictionRecord {
  id: string;
  claim: string;
  p: number;
  /** `human:<id>` or `agent:<model>@<version>`. Scored SEPARATELY, always —
   *  the human-vs-agent comparison on one question set is the most valuable
   *  output this system produces. */
  author: string;
  created_at: string;
  resolve_at: string;
  resolver: ResolverSpec;
  /** Frozen at write time (see leakage.ts). */
  evidence_snapshot_hash: string;
  decision_id: string | null;
  belief_ids: string[];
  outcome: 0 | 1 | 'annulled' | null;
  observed: unknown;
  resolved_at: string | null;
  annul_reason: string | null;
}

export interface PredictionStore {
  insert(p: PredictionRecord): Promise<void>;
  due(now: Date): Promise<PredictionRecord[]>;
  resolve(
    id: string,
    r: { outcome: 0 | 1 | 'annulled'; observed: unknown; resolvedAt: string; annulReason?: string },
  ): Promise<void>;
  all(): Promise<PredictionRecord[]>;
}

/** In-memory adapter — used by tests and by the seed script. */
export function createMemoryStore(seed: PredictionRecord[] = []): PredictionStore {
  const rows = new Map(seed.map((r) => [r.id, { ...r }]));
  return {
    async insert(p) {
      if (rows.has(p.id)) throw new Error(`duplicate prediction id: ${p.id}`);
      rows.set(p.id, { ...p });
    },
    async due(now) {
      return [...rows.values()].filter((r) => r.outcome === null && new Date(r.resolve_at) <= now);
    },
    async resolve(id, r) {
      const row = rows.get(id);
      if (!row) throw new Error(`unknown prediction: ${id}`);
      if (row.outcome !== null) return; // idempotent: resolving twice is a no-op
      row.outcome = r.outcome;
      row.observed = r.observed;
      row.resolved_at = r.resolvedAt;
      row.annul_reason = r.annulReason ?? null;
    },
    async all() {
      return [...rows.values()].map((r) => ({ ...r }));
    },
  };
}

export const AUTHOR_RE = /^(human:[\w.-]+|agent:[\w./-]+@[\w.-]+)$/;

export class PredictionRejected extends Error {}

/** Validation applied before anything reaches the store. */
export function validate(input: {
  claim: string;
  p: number;
  author: string;
  created_at: string;
  resolve_at: string;
}): void {
  if (input.claim.trim().length < 10) {
    throw new PredictionRejected('claim too short to be falsifiable');
  }
  if (!(input.p >= 0.01 && input.p <= 0.99)) {
    throw new PredictionRejected(`p must be within [0.01, 0.99], got ${input.p}`);
  }
  if (!AUTHOR_RE.test(input.author)) {
    throw new PredictionRejected(`author must be human:<id> or agent:<model>@<version>`);
  }
  if (new Date(input.resolve_at) <= new Date(input.created_at)) {
    throw new PredictionRejected('resolve_at must be in the future relative to created_at');
  }
}

/** Stable hash of the evidence a forecaster was shown. */
export function hashEvidence(evidence: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(evidence ?? null))
    .digest('hex');
}
