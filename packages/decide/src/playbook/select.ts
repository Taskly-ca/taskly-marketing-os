/**
 * Playbook selection — pure data, ZERO LLM calls.
 *
 * A playbook is selected when `applies_when ∧ ¬excludes_when` holds, evaluated
 * as data over a situation snapshot. No model is consulted, so selection is
 * reproducible (the same inputs give the same answer forever), auditable (every
 * verdict carries the predicates that produced it) and free — it runs BEFORE
 * anything is loaded into a context window, and it is what decides what gets
 * loaded.
 *
 * The design turns on one distinction a boolean cannot carry:
 *
 *   matched    the context answered, and the answer satisfies the predicate
 *   unmatched  the context answered, and the answer does not
 *   unknown    the context could not answer at all — missing field, wrong type,
 *              or a malformed predicate
 *
 * Collapsing `unknown` into `unmatched` is the failure this module exists to
 * prevent: a misspelled key ("budget_cent") would read as a clean negative and
 * the playbook would silently never fire, with nothing anywhere saying why.
 *
 * The rule for unknowns, applied in `evaluatePlaybook` below:
 *   - unknown in `applies_when` FAILS the match (it never selects) and is
 *     surfaced as `needs_context` naming the field, so a typo is visible.
 *   - unknown in `excludes_when` is NOT "not excluded". A veto list is a set of
 *     hard negatives learned from failures; assuming safety on missing
 *     information is exactly backwards. It surfaces as `needs_context` too.
 */
import type { Playbook } from '@tmos/contracts';

export type Predicate = NonNullable<Playbook['applies_when'][number]>;
export type SituationContext = Readonly<Record<string, unknown>>;

export type PredicateOutcome = 'matched' | 'unmatched' | 'unknown';
/** `ok` accompanies matched/unmatched; the rest are the shapes of an unknown. */
export type PredicateReason = 'ok' | 'field_missing' | 'type_mismatch' | 'malformed_predicate';

export interface PredicateVerdict {
  field: string;
  op: Predicate['op'];
  expected: unknown;
  /** Only present when the context answered. */
  actual?: unknown;
  outcome: PredicateOutcome;
  reason: PredicateReason;
  detail: string;
}

export type SelectionVerdict =
  'selected' | 'needs_context' | 'excluded' | 'not_applicable' | 'retired';

export interface PlaybookEvaluation {
  id: string;
  version: number;
  status: Playbook['status'];
  verdict: SelectionVerdict;
  /** `candidate` — earned nothing from the run ledger yet. Require approval. */
  unproven: boolean;
  stale: boolean;
  daysSinceLastSuccess: number | null;
  applies: PredicateVerdict[];
  excludes: PredicateVerdict[];
  appliesMatched: number;
  /** Fields this playbook asked about that the context did not carry. */
  unansweredFields: string[];
  reason: string;
}

export interface Selection {
  selected: PlaybookEvaluation[];
  needsContext: PlaybookEvaluation[];
  /** excluded · not_applicable · retired — kept, because "why did it not run?" */
  rejected: PlaybookEvaluation[];
  evaluations: PlaybookEvaluation[];
  /** Every field any playbook asked about and the context could not answer. */
  unansweredFields: string[];
}

export interface SelectOptions {
  /** Injected clock — ISO-8601. Nothing here reads an ambient one. */
  now: string;
  /** Last SUCCESSFUL run per playbook id, ISO-8601. Absent = never run. */
  lastSuccessAt?: Readonly<Record<string, string>>;
}

const DAY_MS = 86_400_000;

const ORDER: Record<'<' | '<=' | '>' | '>=', (a: number, b: number) => boolean> = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

const fmt = (v: unknown): string =>
  typeof v === 'string' ? `"${v}"` : (JSON.stringify(v) ?? 'undefined');

const describeType = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && !Number.isFinite(v)) return 'non-finite number';
  return typeof v;
};

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Strict on primitives; structural on arrays so `= [1,2]` can mean something. */
const equals = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => equals(x, b[i]));
  }
  return false;
};

type Lookup = { found: true; value: unknown } | { found: false };

/**
 * Exact key first (a snapshot key may legitimately contain a dot), then a
 * dotted path. `undefined` is treated as absent; an explicit `null` is a value
 * and compares normally — "we know there is no owner" is an answer.
 */
function lookup(context: SituationContext, field: string): Lookup {
  if (Object.prototype.hasOwnProperty.call(context, field)) {
    const value = context[field];
    return value === undefined ? { found: false } : { found: true, value };
  }
  let cursor: unknown = context;
  for (const segment of field.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return { found: false };
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return { found: false };
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor === undefined ? { found: false } : { found: true, value: cursor };
}

/** One predicate against one context. Never returns a silent `false`. */
export function evaluatePredicate(pred: Predicate, context: SituationContext): PredicateVerdict {
  const base = { field: pred.field, op: pred.op, expected: pred.value };
  const answered = (actual: unknown, matched: boolean, detail: string): PredicateVerdict => ({
    ...base,
    actual,
    outcome: matched ? 'matched' : 'unmatched',
    reason: 'ok',
    detail,
  });
  const unknown = (actual: unknown, reason: PredicateReason, detail: string): PredicateVerdict => ({
    ...base,
    actual,
    outcome: 'unknown',
    reason,
    detail,
  });

  const found = lookup(context, pred.field);
  if (!found.found) {
    return {
      ...base,
      outcome: 'unknown',
      reason: 'field_missing',
      detail: `context carries no "${pred.field}" — unanswerable, which is not the same as false`,
    };
  }
  const actual = found.value;
  const shown = `${pred.field} ${fmt(actual)} ${pred.op} ${fmt(pred.value)}`;

  switch (pred.op) {
    case '=':
    case '!=': {
      const eq = equals(actual, pred.value);
      return answered(actual, pred.op === '=' ? eq : !eq, shown);
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (!isNumber(actual) || !isNumber(pred.value)) {
        return unknown(
          actual,
          'type_mismatch',
          `${pred.field} ${pred.op} needs finite numbers on both sides; got ` +
            `${describeType(actual)} ${pred.op} ${describeType(pred.value)}. Pass timestamps as ` +
            `epoch millis — ordering strings makes "9" > "10" silently true`,
        );
      }
      return answered(actual, ORDER[pred.op](actual, pred.value), shown);
    }
    case 'in':
    case 'not_in': {
      if (!Array.isArray(pred.value)) {
        return unknown(
          actual,
          'malformed_predicate',
          `${pred.field} ${pred.op} needs an array; the playbook gives ${describeType(pred.value)}`,
        );
      }
      const member = pred.value.some((candidate) => equals(actual, candidate));
      return answered(actual, pred.op === 'in' ? member : !member, shown);
    }
    default: {
      // Exhaustive over the contract's operator enum today. A newly added
      // operator lands here as `unknown` rather than as an accidental pass.
      const unsupported: never = pred.op;
      return unknown(actual, 'malformed_predicate', `unsupported operator ${String(unsupported)}`);
    }
  }
}

function evaluatePlaybook(
  playbook: Playbook,
  context: SituationContext,
  opts: SelectOptions,
  nowMs: number,
): PlaybookEvaluation {
  const applies = playbook.applies_when.map((p) => evaluatePredicate(p, context));
  const excludes = playbook.excludes_when.map((p) => evaluatePredicate(p, context));

  const veto = excludes.find((v) => v.outcome === 'matched');
  const missed = applies.find((v) => v.outcome === 'unmatched');
  const appliesUnknown = applies.filter((v) => v.outcome === 'unknown');
  const excludesUnknown = excludes.filter((v) => v.outcome === 'unknown');
  const appliesMatched = applies.filter((v) => v.outcome === 'matched').length;

  const lastSuccess = opts.lastSuccessAt?.[playbook.id];
  const lastMs = lastSuccess === undefined ? Number.NaN : Date.parse(lastSuccess);
  const daysSinceLastSuccess = Number.isNaN(lastMs) ? null : Math.floor((nowMs - lastMs) / DAY_MS);
  const stale = daysSinceLastSuccess !== null && daysSinceLastSuccess > playbook.decay_after_days;

  let verdict: SelectionVerdict;
  let reason: string;
  if (playbook.status === 'retired') {
    verdict = 'retired';
    reason = 'retired — a retired playbook never selects, however well it matches';
  } else if (veto) {
    verdict = 'excluded';
    reason =
      `vetoed by excludes_when (${veto.detail}) — one hard negative outranks ` +
      `${appliesMatched} matched condition(s)`;
  } else if (missed) {
    verdict = 'not_applicable';
    reason = `applies_when not met: ${missed.detail}`;
  } else if (appliesUnknown.length > 0) {
    verdict = 'needs_context';
    reason = `applies_when unanswerable: ${appliesUnknown.map((v) => v.detail).join('; ')}`;
  } else if (excludesUnknown.length > 0) {
    verdict = 'needs_context';
    reason =
      `cannot rule out a veto: ${excludesUnknown.map((v) => v.detail).join('; ')} — an ` +
      `unanswered hard negative is not a pass`;
  } else {
    verdict = 'selected';
    reason = `${appliesMatched}/${applies.length} applies_when matched, ${excludes.length} veto(es) cleared`;
  }

  if (stale) {
    reason += `; stale — ${daysSinceLastSuccess}d since the last success, past its ${playbook.decay_after_days}d decay`;
  }

  return {
    id: playbook.id,
    version: playbook.version,
    status: playbook.status,
    verdict,
    unproven: playbook.status === 'candidate',
    stale,
    daysSinceLastSuccess,
    applies,
    excludes,
    appliesMatched,
    unansweredFields: unanswered([...applies, ...excludes]),
    reason,
  };
}

/** Only genuinely missing fields — a type mismatch is a data bug, not a gap. */
const unanswered = (verdicts: readonly PredicateVerdict[]): string[] =>
  [...new Set(verdicts.filter((v) => v.reason === 'field_missing').map((v) => v.field))].sort();

const VERDICT_RANK: Record<SelectionVerdict, number> = {
  selected: 0,
  needs_context: 1,
  excluded: 2,
  not_applicable: 3,
  retired: 4,
};
const STATUS_RANK: Record<Playbook['status'], number> = { proven: 0, candidate: 1, retired: 2 };

/** A TOTAL order: id + version break every remaining tie, so equal-ranked
 *  playbooks cannot reshuffle between runs on input order alone. */
const compare = (a: PlaybookEvaluation, b: PlaybookEvaluation): number =>
  VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
  STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
  Number(a.stale) - Number(b.stale) ||
  b.appliesMatched - a.appliesMatched ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
  b.version - a.version;

/**
 * Filter playbooks against a situation. Pure, total, and explained.
 *
 * There is no port parameter: nothing here can reach a model or a network even
 * by accident, which is the property the run ledger depends on when it replays
 * a historical situation snapshot and expects the same selection.
 */
export function selectPlaybooks(
  playbooks: readonly Playbook[],
  context: SituationContext,
  opts: SelectOptions,
): Selection {
  const nowMs = Date.parse(opts.now);
  if (Number.isNaN(nowMs)) {
    // Silently falling back to epoch 0 would mark every playbook stale.
    throw new RangeError(`selectPlaybooks: opts.now is not a valid ISO timestamp: "${opts.now}"`);
  }

  const evaluations = playbooks
    .map((playbook) => evaluatePlaybook(playbook, context, opts, nowMs))
    .sort(compare);

  return {
    selected: evaluations.filter((e) => e.verdict === 'selected'),
    needsContext: evaluations.filter((e) => e.verdict === 'needs_context'),
    rejected: evaluations.filter(
      (e) => e.verdict === 'excluded' || e.verdict === 'not_applicable' || e.verdict === 'retired',
    ),
    evaluations,
    unansweredFields: [...new Set(evaluations.flatMap((e) => e.unansweredFields))].sort(),
  };
}
