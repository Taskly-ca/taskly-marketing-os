/**
 * `EntityHistoryPort` (packages/reason/src/tier/t2-correlate.ts) on Postgres.
 *
 * T2 asks one question — "is this actually new?" — and it can only answer it
 * against what we already hold. Until now nothing implemented that port outside
 * a test double, so the tier that exists to refuse restatements had no history
 * to compare against and the whole change-detection half of the system was
 * unreachable from the live path. This is the six-line adapter t2-correlate's
 * comment promises, and it is six lines of policy rather than plumbing:
 *
 * THE THIRD STATE IS THE POINT. `HistoryLookup` distinguishes "we do not know
 * this entity" from "we know it and hold nothing for this predicate" from "we
 * hold something we cannot compare". Collapsing the third into the second is
 * the expensive mistake the port's own doc warns about: it classifies as
 * `changed_value` and mints a Finding saying "we now hold a value where we
 * previously held none", which is false. An `entity`- or `json`-valued fact
 * therefore comes back as `current: { value: null }`, and T2 refuses the item
 * as `unsupported_value` — a counted skip rather than an invented change.
 *
 * AN UNPARSEABLE REF IS A CALLER BUG, NOT AN UNKNOWN ENTITY. `entityKnown:
 * false` is a legitimate answer that classifies as `new_entity` and mints a
 * Finding announcing a competitor we have never seen. Returning it for a typo'd
 * subject ref would manufacture that Finding out of a broken string, so a ref
 * that does not parse throws and a ref that parses but resolves to nothing
 * answers honestly.
 *
 * THE CLOCK IS INJECTED. Every other read in this package takes its instants
 * from the caller, and "what do we believe NOW" needs one — so `now` is an
 * option with a default rather than a `new Date()` buried in the query. A test
 * that cannot move the clock cannot test a bitemporal read at all.
 */
import { db, type Executor } from '@tmos/db';
import { currentBelief, type FactValue } from '@tmos/world';
import type { EntityHistoryPort, HistoryLookup, ObservedValue } from '@tmos/reason';

import { entityById, entityByHardKey } from './entity-directory.js';
import { createPostgresFactStore } from './fact-store.js';

/**
 * `type:id`, per `subjectRefSchema` in contracts.
 *
 * Two id spaces are legal and they are not interchangeable. `entity:<uuid>` is
 * our own primary key — unambiguous, and what an internal caller holds.
 * Everything else is read as a HARD KEY of kind `domain` (migration 001), which
 * is the identity a competitor watcher actually has: it fetched a URL, so it
 * knows `taskrabbit.ca` and does not know our uuid for them. An exact hard-key
 * match auto-merges with no scoring, which is why a domain is the only soft
 * identifier accepted here — resolving `company:TaskRabbit` by name would put
 * fuzzy entity resolution on the change-detection path, where a wrong merge
 * silently attributes one company's move to another.
 */
const SUBJECT_REF = /^([a-z_]+):([a-zA-Z0-9._-]+)$/;

export interface ParsedSubjectRef {
  readonly type: string;
  readonly id: string;
}

export function parseSubjectRef(subjectRef: string): ParsedSubjectRef {
  const m = SUBJECT_REF.exec(subjectRef.trim());
  if (!m) {
    throw new TypeError(
      `subject ref ${JSON.stringify(subjectRef)} is not \`type:id\` — refusing to ` +
        'report a malformed ref as an unknown entity, which would mint a Finding',
    );
  }
  return { type: m[1]!, id: m[2]! };
}

/**
 * `FactValue` → `ObservedValue`, or `null` for the two variants T2 has no
 * semantics to diff. The conversion t2-correlate asks the integrator to write,
 * written once here rather than once per call site — the invisible version is
 * an integrator's `if (!converted) continue`, which turns a whole class of fact
 * into one that never produces a Finding and is counted nowhere.
 */
export function toObservedValue(value: FactValue): ObservedValue | null {
  if (value.datatype === 'num') return { kind: 'num', num: value.num };
  if (value.datatype === 'text') return { kind: 'text', text: value.text };
  return null;
}

export interface EntityHistoryOptions {
  readonly executor?: Executor;
  /** Injected so a test can ask what we believed at an instant it chooses. */
  readonly now?: () => string;
}

/** Resolve a parsed ref to our entity id, or null when we hold no such entity. */
async function resolveEntityId(
  ref: ParsedSubjectRef,
  ex: Executor,
): Promise<string | null> {
  if (ref.type === 'entity') {
    const found = await entityById(ref.id, ex);
    return found?.entityId ?? null;
  }
  const byDomain = await entityByHardKey({ kind: 'domain', valueNorm: ref.id.toLowerCase() }, ex);
  return byDomain?.entityId ?? null;
}

export function createPostgresEntityHistory(
  options: EntityHistoryOptions = {},
): EntityHistoryPort {
  const ex = options.executor ?? db();
  const now = options.now ?? ((): string => new Date().toISOString());
  const store = createPostgresFactStore(ex);

  return {
    async lookup(subjectRef: string, predicate: string): Promise<HistoryLookup> {
      const entityId = await resolveEntityId(parseSubjectRef(subjectRef), ex);
      if (entityId === null) return { entityKnown: false, current: null };

      const row = await currentBelief(store, entityId, predicate, now());
      if (row === null) return { entityKnown: true, current: null };

      return {
        entityKnown: true,
        current: { value: toObservedValue(row.value), observedAt: row.observedAt },
      };
    },
  };
}
