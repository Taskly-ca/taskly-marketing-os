/**
 * Blast radius — if this turns out to be wrong, what else is wrong with it?
 *
 * Beliefs carry `derived_from` (migration 003), so the justifications form a
 * directed graph: this belief rests on those beliefs, which rest on those
 * findings, which rest on those facts. When something at the bottom is refuted,
 * the question that matters is not "is this belief still true" but "what did we
 * DECIDE on the strength of it".
 *
 * Without this query a retraction is a local event: one row flips and the
 * decisions built on it keep their justification text intact, still citing a
 * belief that no longer holds. The failure is silent by construction — nothing
 * about a decision record changes when its foundation is withdrawn.
 *
 * Mirrors a recursive CTE over `derived_from`; kept here as a pure function so
 * the traversal rules are testable without a database and identical to the SQL.
 */

export type NodeKind = 'fact' | 'finding' | 'belief' | 'decision' | 'playbook_run';

export interface JustificationNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** The nodes this one rests on. Edges point CHILD → PARENT (dependent → support). */
  derivedFrom: readonly string[];
}

export interface ImpactedNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Edges traversed from the origin. 1 = rests on it directly. */
  distance: number;
  /** One shortest path back to the origin, for showing WHY it is implicated. */
  path: readonly string[];
}

export interface BlastRadius {
  origin: string;
  impacted: ImpactedNode[];
  /** Decisions are surfaced separately: they are the only nodes where being
   *  wrong has already cost something. */
  decisions: ImpactedNode[];
  /** True when traversal stopped early. Never silently truncate a blast
   *  radius — an under-reported one is worse than none, because it looks
   *  authoritative. */
  truncated: boolean;
  /** Cycles found. A justification cycle (A supports B supports A) is a real
   *  defect worth surfacing, not just a traversal hazard to route around. */
  cycles: string[][];
}

export const MAX_BLAST_NODES = 5000;

/**
 * Everything that transitively rests on `originId`.
 *
 * Breadth-first, so `distance` is the true shortest hop count and the first
 * path found is a shortest one. Depth-first would report a longer path for the
 * same node depending on edge order, which makes the explanation arbitrary.
 */
export function blastRadius(
  originId: string,
  nodes: Iterable<JustificationNode>,
  opts: { maxNodes?: number } = {},
): BlastRadius {
  const maxNodes = opts.maxNodes ?? MAX_BLAST_NODES;

  // Invert the edges once: we are given "what I rest on" and we need
  // "what rests on me".
  const dependents = new Map<string, string[]>();
  const byId = new Map<string, JustificationNode>();
  for (const n of nodes) {
    byId.set(n.id, n);
    for (const parent of n.derivedFrom) {
      const list = dependents.get(parent);
      if (list) list.push(n.id);
      else dependents.set(parent, [n.id]);
    }
  }

  const impacted: ImpactedNode[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>([originId]);
  let truncated = false;

  let frontier: Array<{ id: string; path: string[] }> = [{ id: originId, path: [originId] }];
  let distance = 0;

  while (frontier.length > 0) {
    distance += 1;
    const next: Array<{ id: string; path: string[] }> = [];

    // Deterministic order, so the same graph always produces the same report.
    for (const { id, path } of frontier) {
      const children = [...(dependents.get(id) ?? [])].sort();
      for (const childId of children) {
        if (path.includes(childId)) {
          cycles.push([...path.slice(path.indexOf(childId)), childId]);
          continue;
        }
        if (seen.has(childId)) continue;
        seen.add(childId);

        const node = byId.get(childId);
        if (!node) continue;

        if (impacted.length >= maxNodes) {
          truncated = true;
          break;
        }
        const childPath = [...path, childId];
        impacted.push({
          id: node.id,
          kind: node.kind,
          label: node.label,
          distance,
          path: childPath,
        });
        next.push({ id: childId, path: childPath });
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = next;
  }

  return {
    origin: originId,
    impacted,
    decisions: impacted.filter((n) => n.kind === 'decision'),
    truncated,
    cycles,
  };
}

/**
 * Human-readable summary, written to be uncomfortable in the right way.
 *
 * "3 decisions rest on this" is the sentence that should make someone check
 * before retracting — and check again before NOT retracting.
 */
export function describeBlastRadius(r: BlastRadius): string {
  if (r.impacted.length === 0) return `Nothing rests on ${r.origin}.`;
  const byKind = new Map<NodeKind, number>();
  for (const n of r.impacted) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
  const parts = [...byKind.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`);
  const head = `${r.impacted.length} node${r.impacted.length === 1 ? '' : 's'} rest on ${r.origin} — ${parts.join(', ')}.`;
  const decisions =
    r.decisions.length > 0
      ? ` ${r.decisions.length} of them ${r.decisions.length === 1 ? 'is a decision' : 'are decisions'} already taken.`
      : '';
  const cut = r.truncated ? ' TRUNCATED — the real radius is larger.' : '';
  const loops = r.cycles.length > 0 ? ` ${r.cycles.length} justification cycle(s) found.` : '';
  return head + decisions + cut + loops;
}

/**
 * Retraction impact: what must be re-examined, ordered by how much it costs to
 * be wrong. Decisions first, then beliefs, then everything else — and within a
 * kind, nearest first, because a direct dependent is more likely to flip than a
 * distant one.
 */
export function retractionWorklist(r: BlastRadius): ImpactedNode[] {
  const weight: Record<NodeKind, number> = {
    decision: 0,
    playbook_run: 1,
    belief: 2,
    finding: 3,
    fact: 4,
  };
  return [...r.impacted].sort(
    (a, b) =>
      weight[a.kind] - weight[b.kind] || a.distance - b.distance || a.id.localeCompare(b.id),
  );
}
