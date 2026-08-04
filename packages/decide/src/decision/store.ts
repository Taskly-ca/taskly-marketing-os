/**
 * The decision record, and the writes it refuses.
 *
 * `decisionRecordSchema` already demands ≥2 alternatives and ≥1 prediction. That
 * is necessary and not sufficient, because both are trivially satisfiable by a
 * writer who wants them to be: two alternatives that are the same option in
 * different words, or a prediction whose outcome is already known. This module
 * enforces what the shape cannot.
 *
 * The point of the whole record is to make a decision auditable LATER, when it
 * has gone wrong and everyone remembers having had doubts. Three properties do
 * that work:
 *
 *   alternatives   — proof that something else was actually considered
 *   predictions    — a falsifiable statement made BEFORE the outcome
 *   luck_attribution — the anti-*resulting* field: judging decisions by their
 *                    outcomes destroys learning, because a good decision with a
 *                    bad outcome then looks identical to a bad one.
 */
import { decisionRecordSchema } from '@tmos/contracts';
import type { DecisionRecord } from '@tmos/contracts';

export type RejectCode =
  | 'schema'
  | 'duplicate_alternatives'
  | 'alternative_is_the_decision'
  | 'unresolved_prediction_required'
  | 'prediction_missing'
  | 'kill_criteria_in_the_past'
  | 'immutable'
  | 'not_found';

export interface Rejection {
  code: RejectCode;
  detail: string;
}

export type WriteResult =
  { ok: true; record: DecisionRecord } | { ok: false; rejection: Rejection };

/** Normalised for comparison — "Do nothing" and "do nothing." are one option. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * What the caller must be able to tell us about a cited prediction.
 *
 * Deliberately narrow: the decision layer does not own predictions, it only
 * refuses to accept ones that cannot do their job.
 */
export interface PredictionFacts {
  exists: boolean;
  /** True once the resolver has run. A decision may not cite one. */
  resolved: boolean;
  /** When the prediction was recorded. Must precede the decision. */
  recordedAt: string;
}

export interface DecisionStore {
  put(record: DecisionRecord): Promise<void>;
  get(id: string): Promise<DecisionRecord | null>;
  all(): Promise<DecisionRecord[]>;
}

export interface WriteDeps {
  store: DecisionStore;
  /** Looked up per cited prediction id. */
  predictionFacts(id: string): Promise<PredictionFacts | null>;
  now: string;
}

/**
 * Write a decision, or refuse with a reason.
 *
 * Every refusal below corresponds to a way of satisfying the letter of the
 * contract while defeating its purpose.
 */
export async function writeDecision(input: unknown, deps: WriteDeps): Promise<WriteResult> {
  const parsed = decisionRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      rejection: {
        code: 'schema',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
    };
  }
  const record = parsed.data;

  const existing = await deps.store.get(record.id);
  if (existing && existing.status !== 'proposed') {
    // An accepted decision is the historical record of what was decided and
    // why. Editing it turns the audit trail into a story about the present.
    return {
      ok: false,
      rejection: {
        code: 'immutable',
        detail: `${record.id} is ${existing.status} — supersede it with a new record instead of rewriting it`,
      },
    };
  }

  // Two alternatives that are the same option in different words are one.
  const seen = new Set<string>();
  for (const alt of record.alternatives) {
    const key = norm(alt.option);
    if (seen.has(key)) {
      return {
        ok: false,
        rejection: {
          code: 'duplicate_alternatives',
          detail: `"${alt.option}" appears twice — that is one alternative, not two`,
        },
      };
    }
    seen.add(key);
  }

  // Listing the chosen course as its own alternative is the commonest way to
  // fill the field without considering anything.
  const decisionKey = norm(record.decision);
  const selfListed = record.alternatives.find((a) => norm(a.option) === decisionKey);
  if (selfListed) {
    return {
      ok: false,
      rejection: {
        code: 'alternative_is_the_decision',
        detail: `"${selfListed.option}" is the decision itself — an alternative is something you did NOT do`,
      },
    };
  }

  for (const pid of record.predictions) {
    const facts = await deps.predictionFacts(pid);
    if (!facts || !facts.exists) {
      return {
        ok: false,
        rejection: { code: 'prediction_missing', detail: `prediction ${pid} does not exist` },
      };
    }
    if (facts.resolved) {
      // Citing a prediction you already know the answer to is retroactive
      // justification wearing the costume of forecasting.
      return {
        ok: false,
        rejection: {
          code: 'unresolved_prediction_required',
          detail: `prediction ${pid} is already resolved — a decision must cite a forecast whose outcome is still open`,
        },
      };
    }
    if (new Date(facts.recordedAt).getTime() > new Date(record.decided_at).getTime()) {
      return {
        ok: false,
        rejection: {
          code: 'unresolved_prediction_required',
          detail: `prediction ${pid} was recorded after the decision — it cannot have informed it`,
        },
      };
    }
  }

  for (const k of record.kill_criteria) {
    if (new Date(`${k.by}T23:59:59.999Z`).getTime() < new Date(deps.now).getTime()) {
      return {
        ok: false,
        rejection: {
          code: 'kill_criteria_in_the_past',
          detail: `kill criterion "${k.metric}" is due ${k.by}, already past — a kill date that cannot arrive is not a kill criterion`,
        },
      };
    }
  }

  await deps.store.put(record);
  return { ok: true, record };
}

/**
 * Record an outcome. Separate from the write, because the whole design depends
 * on the outcome being unknown when the decision is made.
 */
export async function recordDecisionOutcome(
  id: string,
  outcome: NonNullable<DecisionRecord['outcome']>,
  deps: { store: DecisionStore },
): Promise<WriteResult> {
  const record = await deps.store.get(id);
  if (!record) return { ok: false, rejection: { code: 'not_found', detail: `no decision ${id}` } };
  const updated: DecisionRecord = { ...record, outcome };
  await deps.store.put(updated);
  return { ok: true, record: updated };
}

/**
 * Decisions whose process was sound but whose outcome was bad.
 *
 * This query is the reason `luck_attribution` exists. In a system that only
 * tracks outcomes these are indistinguishable from mistakes, and the lesson
 * learned from them is the wrong one — you stop making a good bet because it
 * lost once.
 */
export const goodProcessBadOutcome = (records: readonly DecisionRecord[]): DecisionRecord[] =>
  records.filter((r) => r.outcome?.result === 'bad' && r.outcome.luck_attribution === 'luck');

/** The mirror, and the more dangerous one: it worked, and we still do not know
 *  whether the reasoning was any good. */
export const badProcessGoodOutcome = (records: readonly DecisionRecord[]): DecisionRecord[] =>
  records.filter((r) => r.outcome?.result === 'good' && r.outcome.luck_attribution === 'luck');

export function createMemoryDecisionStore(): DecisionStore {
  const rows = new Map<string, DecisionRecord>();
  return {
    async put(r) {
      rows.set(r.id, structuredClone(r));
    },
    async get(id) {
      const r = rows.get(id);
      return r ? structuredClone(r) : null;
    },
    async all() {
      return [...rows.values()].map((r) => structuredClone(r));
    },
  };
}
