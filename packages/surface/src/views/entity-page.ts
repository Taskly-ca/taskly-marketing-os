/**
 * The entity page — "what do we know about Jiffy, and how do we know it?"
 *
 * The whole design rests on one refusal: a UI that collapses the two time axes
 * is why "we were wrong" and "the world changed" become indistinguishable, and
 * once they are, every past decision stops being auditable. So the timeline
 * labels each entry `world_change` (the value moved: `valid` closed) or
 * `we_corrected_ourselves` (our belief moved: `asserted` closed), derived from
 * the same rows, and never merges them into one "updated" event.
 *
 * The second refusal: open disagreements are shown, not fused. A `temporal`
 * conflict is not a conflict at all — it is a change, and rendering it as a
 * dispute deletes the most valuable signal we collect. `factual` and `opinion`
 * conflicts appear side by side with both sources and NO fused value, because a
 * single tidy number that no source stands behind is the artifact this system
 * exists to avoid.
 *
 * The third: absence is information. A page that only shows what it has makes
 * its gaps invisible, so predicates our peers carry and this entity lacks are a
 * first-class section rather than a silence.
 */
import type { Basis, Finding, EvidenceRef } from '@tmos/contracts';
import { buildFeed, renderedBasis } from './feed.js';
import type { FeedRow, RenderedBasis } from './feed.js';

/** Postgres `tstzrange` semantics: `[from, to)`; `to: null` is still in force. */
export interface Range {
  from: string;
  to: string | null;
}

export type FactStatus = 'active' | 'retracted' | 'disputed';

/**
 * The input port. Deliberately narrow, and deliberately WITHOUT the `fact.confidence`
 * column: a surface has no use for it that is not a lie (see basis.ts). Values
 * arrive display-ready — typing them is the world model's job, not the view's.
 */
export interface FactRecord {
  factId: string;
  predicate: string;
  value: string;
  valid: Range;
  asserted: Range;
  sourceId: string;
  sourceName: string | null;
  evidence: EvidenceRef | null;
  /** Distinct from `valid.from`: tells a stale scrape apart from a real change. */
  observedAt: string;
  status: FactStatus;
  basis: Basis;
  supersedes: string | null;
}

export interface ConflictRecord {
  id: string;
  predicate: string;
  kind: 'temporal' | 'factual' | 'opinion';
  status: 'open' | 'resolved' | 'unresolvable';
  validInstant: string;
  factIds: readonly string[];
}

export interface PeerCoverage {
  entityRef: string;
  name: string;
  predicates: readonly string[];
}

export interface EntityPageInput {
  entity: { ref: string; name: string; region: Finding['region'] | null };
  facts: readonly FactRecord[];
  conflicts: readonly ConflictRecord[];
  findings: readonly Finding[];
  peers: readonly PeerCoverage[];
  /** Injected clock. Nothing in this package reads the wall clock. */
  asOf: string;
  maxFindings?: number;
}

/** A value welded to the source that stands behind it. Every value this page
 *  renders — current, historical or disputed — is one of these, so there is no
 *  shape in which a bare number can reach a reader. */
export interface SourcedValue {
  factId: string;
  value: string;
  sourceId: string;
  sourceName: string | null;
  evidence: EvidenceRef | null;
  basis: RenderedBasis;
  observedAt: string;
}

export interface CurrentFactView extends SourcedValue {
  predicate: string;
  trueSince: string;
  believedSince: string;
  /** Another source disagrees right now. The value is shown, never as settled. */
  contested: boolean;
  conflictId: string | null;
}

export type TimelineKind = 'world_change' | 'we_corrected_ourselves';

export interface TimelineEntry {
  kind: TimelineKind;
  /** Which axis moved. This is the whole point of the entry. */
  axis: 'valid' | 'asserted';
  predicate: string;
  at: string;
  from: { factId: string; value: string } | null;
  to: { factId: string; value: string };
  label: string;
  evidence: EvidenceRef | null;
  basis: RenderedBasis;
  /** Set when a typed `temporal` conflict is what produced this entry. */
  conflictId: string | null;
}

export type DisputeSide = SourcedValue;

export interface DisputeView {
  conflictId: string;
  predicate: string;
  kind: 'factual' | 'opinion';
  headline: string;
  guidance: string;
  sides: readonly DisputeSide[];
  /** Always null, and present so the absence is explicit rather than forgotten. */
  fusedValue: null;
}

export interface Gap {
  predicate: string;
  heldByPeers: number;
  peerExamples: readonly string[];
  label: string;
}

export interface EntityPage {
  entity: EntityPageInput['entity'];
  asOf: string;
  currentFacts: readonly CurrentFactView[];
  timeline: readonly TimelineEntry[];
  disputes: readonly DisputeView[];
  findings: readonly FeedRow[];
  gaps: readonly Gap[];
  counts: {
    facts: number;
    worldChanges: number;
    corrections: number;
    disputes: number;
    gaps: number;
  };
}

const t = (iso: string): number => Date.parse(iso);
const day = (iso: string): string => iso.slice(0, 10);

const overlaps = (a: Range, b: Range): boolean => {
  const aEnd = a.to === null ? Infinity : t(a.to);
  const bEnd = b.to === null ? Infinity : t(b.to);
  return t(a.from) < bEnd && t(b.from) < aEnd;
};

const holdsAt = (r: Range, instant: string): boolean =>
  t(r.from) <= t(instant) && (r.to === null || t(instant) < t(r.to));

/** One evidence ref is one independent source; `renderBasis` needs the count,
 *  never the row count of a copy chain. */
const sourced = (f: FactRecord): SourcedValue => ({
  factId: f.factId,
  value: f.value,
  sourceId: f.sourceId,
  sourceName: f.sourceName,
  evidence: f.evidence,
  basis: renderedBasis(f.basis, f.evidence ? 1 : 0),
  observedAt: f.observedAt,
});

function groupByPredicate(facts: readonly FactRecord[]): Map<string, FactRecord[]> {
  const out = new Map<string, FactRecord[]>();
  for (const f of facts) {
    const list = out.get(f.predicate);
    if (list) list.push(f);
    else out.set(f.predicate, [f]);
  }
  return out;
}

function currentFacts(
  input: EntityPageInput,
  openBy: Map<string, ConflictRecord>,
): CurrentFactView[] {
  const out: CurrentFactView[] = [];
  for (const [predicate, rows] of groupByPredicate(input.facts)) {
    const live = rows
      .filter(
        (f) => f.status !== 'retracted' && f.asserted.to === null && holdsAt(f.valid, input.asOf),
      )
      .sort((a, b) => t(b.observedAt) - t(a.observedAt) || (a.factId < b.factId ? -1 : 1));
    const best = live[0];
    if (!best) continue;
    const conflict = openBy.get(predicate) ?? null;
    out.push({
      ...sourced(best),
      predicate,
      trueSince: best.valid.from,
      believedSince: best.asserted.from,
      contested: conflict !== null || live.length > 1,
      conflictId: conflict?.id ?? null,
    });
  }
  return out.sort((a, b) => (a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1 : 0));
}

function entry(prev: FactRecord, next: FactRecord): TimelineEntry | null {
  if (prev.value === next.value) return null;
  const sameInstant = overlaps(prev.valid, next.valid);
  // Both still believed, both claiming the same instant: nothing moved in time.
  // That is a disagreement and belongs in `disputes`, not in the history.
  if (sameInstant && prev.asserted.to === null && next.asserted.to === null) return null;

  const corrected = sameInstant;
  const at = corrected ? (prev.asserted.to ?? next.asserted.from) : next.valid.from;
  return {
    kind: corrected ? 'we_corrected_ourselves' : 'world_change',
    axis: corrected ? 'asserted' : 'valid',
    predicate: next.predicate,
    at,
    from: { factId: prev.factId, value: prev.value },
    to: { factId: next.factId, value: next.value },
    label: corrected
      ? `We recorded ${next.predicate} as "${prev.value}" and corrected it to "${next.value}" on ${day(at)}. The value never changed — our belief did.`
      : `${next.predicate} changed from "${prev.value}" to "${next.value}" on ${day(at)}. The world moved; we were not wrong before.`,
    evidence: next.evidence,
    basis: renderedBasis(next.basis, next.evidence ? 1 : 0),
    conflictId: null,
  };
}

function timeline(input: EntityPageInput): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const rows of groupByPredicate(input.facts).values()) {
    const ordered = [...rows].sort(
      (a, b) =>
        t(a.asserted.from) - t(b.asserted.from) ||
        t(a.valid.from) - t(b.valid.from) ||
        (a.factId < b.factId ? -1 : 1),
    );
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1];
      const next = ordered[i];
      if (!prev || !next) continue;
      const e = entry(prev, next);
      if (e) entries.push(e);
    }
  }

  // A typed `temporal` conflict is a change. Attach it to the entry it explains,
  // and if the rows never produced one, render the conflict itself as history —
  // it must never fall through to `disputes`.
  for (const c of input.conflicts) {
    if (c.kind !== 'temporal') continue;
    const hit = entries.find(
      (e) =>
        e.predicate === c.predicate &&
        e.from !== null &&
        c.factIds.includes(e.from.factId) &&
        c.factIds.includes(e.to.factId),
    );
    if (hit) {
      hit.conflictId = c.id;
      continue;
    }
    const rows = input.facts
      .filter((f) => c.factIds.includes(f.factId))
      .sort((a, b) => t(a.valid.from) - t(b.valid.from));
    const [prev, next] = [rows[0], rows[1]];
    if (!prev || !next) continue;
    entries.push({
      kind: 'world_change',
      axis: 'valid',
      predicate: c.predicate,
      at: c.validInstant,
      from: { factId: prev.factId, value: prev.value },
      to: { factId: next.factId, value: next.value },
      label: `${c.predicate} changed from "${prev.value}" to "${next.value}" on ${day(c.validInstant)}. A change over time, not a dispute.`,
      evidence: next.evidence,
      basis: renderedBasis(next.basis, next.evidence ? 1 : 0),
      conflictId: c.id,
    });
  }

  return entries.sort(
    (a, b) =>
      t(b.at) - t(a.at) ||
      (a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1 : 0) ||
      (a.to.factId < b.to.factId ? -1 : 1),
  );
}

const HEADLINES: Record<DisputeView['kind'], { headline: string; guidance: string }> = {
  factual: {
    headline: 'Sources disagree about the same instant — one of these is wrong.',
    guidance: 'Check the cited spans before quoting either. Do not average them.',
  },
  opinion: {
    headline: 'Both are true. This predicate is subjective.',
    guidance:
      'Averaging these would manufacture a number no source stands behind. Quote them attributed, or not at all.',
  },
};

function disputes(input: EntityPageInput): DisputeView[] {
  const byId = new Map(input.facts.map((f) => [f.factId, f]));
  return input.conflicts
    .filter((c) => c.kind !== 'temporal' && c.status === 'open')
    .map((c) => {
      const kind = c.kind as DisputeView['kind'];
      const sides: DisputeSide[] = c.factIds
        .map((id) => byId.get(id))
        .filter((f): f is FactRecord => f !== undefined)
        .sort((a, b) => t(a.observedAt) - t(b.observedAt) || (a.factId < b.factId ? -1 : 1))
        .map(sourced);
      return {
        conflictId: c.id,
        predicate: c.predicate,
        kind,
        ...HEADLINES[kind],
        sides,
        fusedValue: null,
      };
    })
    .sort((a, b) => (a.conflictId < b.conflictId ? -1 : 1));
}

function gaps(input: EntityPageInput): Gap[] {
  const ours = new Set(input.facts.map((f) => f.predicate));
  const holders = new Map<string, string[]>();
  for (const peer of input.peers) {
    for (const p of new Set(peer.predicates)) {
      if (ours.has(p)) continue;
      holders.set(p, [...(holders.get(p) ?? []), peer.name]);
    }
  }
  return [...holders.entries()]
    .map(([predicate, names]) => ({
      predicate,
      heldByPeers: names.length,
      peerExamples: [...names].sort().slice(0, 3),
      label: `No ${predicate} on record. ${names.length} of ${input.peers.length} comparable entities have one.`,
    }))
    .sort((a, b) => b.heldByPeers - a.heldByPeers || (a.predicate < b.predicate ? -1 : 1));
}

export function buildEntityPage(input: EntityPageInput): EntityPage {
  const openByPredicate = new Map<string, ConflictRecord>();
  for (const c of input.conflicts) {
    if (c.kind !== 'temporal' && c.status === 'open' && !openByPredicate.has(c.predicate)) {
      openByPredicate.set(c.predicate, c);
    }
  }
  const facts = currentFacts(input, openByPredicate);
  const history = timeline(input);
  const open = disputes(input);
  const missing = gaps(input);
  const findings = buildFeed(input.findings, {
    filter: { subjects: [input.entity.ref] },
    limit: input.maxFindings ?? 10,
  }).rows;

  return {
    entity: input.entity,
    asOf: input.asOf,
    currentFacts: facts,
    timeline: history,
    disputes: open,
    findings,
    gaps: missing,
    counts: {
      facts: facts.length,
      worldChanges: history.filter((e) => e.kind === 'world_change').length,
      corrections: history.filter((e) => e.kind === 'we_corrected_ourselves').length,
      disputes: open.length,
      gaps: missing.length,
    },
  };
}
