/**
 * In-memory `FactStore`, for tests and for running the pipeline before a
 * database exists.
 *
 * It enforces the append-only rule the Postgres trigger enforces — a value or a
 * `valid` range can never be rewritten in place. Without that, the tests would
 * pass against a store more permissive than production, and the first real
 * write would fail on a constraint nothing had exercised.
 */
import type { FactRow, FactStatus, FactStore } from './types.js';

let counter = 0;
/** Deterministic ids: a test that prints a fact id should be reproducible. */
const nextId = (): string => `fact_${(++counter).toString(36).padStart(6, '0')}`;

export function resetFactIds(): void {
  counter = 0;
}

export function createMemoryFactStore(): FactStore & { all(): FactRow[] } {
  const rows = new Map<string, FactRow>();

  const clone = (r: FactRow): FactRow => ({
    ...r,
    value: { ...r.value },
    valid: { ...r.valid },
    asserted: { ...r.asserted },
    evidence: { ...r.evidence },
  });

  return {
    async insert(row) {
      const stored: FactRow = { ...clone(row as FactRow), factId: nextId() };
      rows.set(stored.factId, stored);
      return clone(stored);
    },

    async byId(factId) {
      const r = rows.get(factId);
      return r ? clone(r) : null;
    },

    async forPredicate(entityId, predicate) {
      return [...rows.values()]
        .filter((r) => r.entityId === entityId && r.predicate === predicate)
        .map(clone);
    },

    async forEntity(entityId) {
      return [...rows.values()].filter((r) => r.entityId === entityId).map(clone);
    },

    async closeAsserted(factId, at) {
      const r = rows.get(factId);
      if (!r) throw new Error(`closeAsserted: no such fact ${factId}`);
      if (r.asserted.to !== null) {
        throw new Error(`closeAsserted: ${factId} already closed at ${r.asserted.to}`);
      }
      r.asserted = { ...r.asserted, to: at };
    },

    async closeValid(factId, at) {
      const r = rows.get(factId);
      if (!r) throw new Error(`closeValid: no such fact ${factId}`);
      if (new Date(at).getTime() < new Date(r.valid.from).getTime()) {
        throw new Error(`closeValid: ${at} precedes valid.from ${r.valid.from}`);
      }
      r.valid = { ...r.valid, to: at };
    },

    async setStatus(factId, status: FactStatus) {
      const r = rows.get(factId);
      if (!r) throw new Error(`setStatus: no such fact ${factId}`);
      r.status = status;
    },

    all() {
      return [...rows.values()].map(clone);
    },
  };
}
