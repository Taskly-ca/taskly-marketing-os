import { describe, it, expect } from 'vitest';
import {
  blastRadius,
  describeBlastRadius,
  retractionWorklist,
  MAX_BLAST_NODES,
} from './blast-radius.js';
import type { JustificationNode } from './blast-radius.js';

const n = (
  id: string,
  kind: JustificationNode['kind'],
  derivedFrom: string[] = [],
): JustificationNode => ({ id, kind, label: `${kind} ${id}`, derivedFrom });

/** fact_price ← finding_a ← belief_1 ← decision_x
 *                        ↖ belief_2 ← decision_y  */
const GRAPH: JustificationNode[] = [
  n('fact_price', 'fact'),
  n('finding_a', 'finding', ['fact_price']),
  n('belief_1', 'belief', ['finding_a']),
  n('belief_2', 'belief', ['finding_a']),
  n('decision_x', 'decision', ['belief_1']),
  n('decision_y', 'decision', ['belief_2']),
  n('unrelated', 'finding', []),
];

describe('what rests on a retracted fact', () => {
  it('finds everything transitively, and nothing else', () => {
    const r = blastRadius('fact_price', GRAPH);
    expect(r.impacted.map((i) => i.id).sort()).toEqual([
      'belief_1',
      'belief_2',
      'decision_x',
      'decision_y',
      'finding_a',
    ]);
    expect(r.impacted.find((i) => i.id === 'unrelated')).toBeUndefined();
  });

  it('surfaces decisions separately — the only nodes where being wrong already cost something', () => {
    const r = blastRadius('fact_price', GRAPH);
    expect(r.decisions.map((d) => d.id).sort()).toEqual(['decision_x', 'decision_y']);
  });

  it('reports the true shortest distance, not an edge-order artefact', () => {
    const r = blastRadius('fact_price', GRAPH);
    expect(r.impacted.find((i) => i.id === 'finding_a')!.distance).toBe(1);
    expect(r.impacted.find((i) => i.id === 'belief_1')!.distance).toBe(2);
    expect(r.impacted.find((i) => i.id === 'decision_x')!.distance).toBe(3);
  });

  it('shows WHY each node is implicated', () => {
    const r = blastRadius('fact_price', GRAPH);
    expect(r.impacted.find((i) => i.id === 'decision_x')!.path).toEqual([
      'fact_price',
      'finding_a',
      'belief_1',
      'decision_x',
    ]);
  });

  it('reports nothing when nothing depends on it', () => {
    const r = blastRadius('unrelated', GRAPH);
    expect(r.impacted).toEqual([]);
    expect(describeBlastRadius(r)).toMatch(/Nothing rests on/);
  });
});

describe('graph hazards', () => {
  it('terminates on a cycle and REPORTS it rather than routing around it silently', () => {
    // A justification cycle is a real defect: two beliefs holding each other up
    // with nothing underneath.
    const cyclic = [n('a', 'belief', ['c']), n('b', 'belief', ['a']), n('c', 'belief', ['b'])];
    const r = blastRadius('a', cyclic);
    expect(r.impacted.map((i) => i.id).sort()).toEqual(['b', 'c']);
    expect(r.cycles.length).toBeGreaterThan(0);
  });

  it('handles a diamond without double-counting', () => {
    const diamond = [
      n('root', 'fact'),
      n('left', 'finding', ['root']),
      n('right', 'finding', ['root']),
      n('joined', 'belief', ['left', 'right']),
    ];
    const r = blastRadius('root', diamond);
    expect(r.impacted.filter((i) => i.id === 'joined')).toHaveLength(1);
    expect(r.impacted.find((i) => i.id === 'joined')!.distance).toBe(2);
  });

  it('never truncates silently', () => {
    // An under-reported blast radius is worse than none — it looks authoritative.
    const wide = [
      n('root', 'fact'),
      ...Array.from({ length: 50 }, (_, i) => n(`d${i}`, 'belief', ['root'])),
    ];
    const r = blastRadius('root', wide, { maxNodes: 10 });
    expect(r.truncated).toBe(true);
    expect(describeBlastRadius(r)).toMatch(/TRUNCATED/);
  });

  it('is deterministic across repeated runs', () => {
    const a = blastRadius('fact_price', GRAPH);
    const b = blastRadius('fact_price', [...GRAPH].reverse());
    expect(a.impacted.map((i) => i.id)).toEqual(b.impacted.map((i) => i.id));
  });

  it('ignores an edge pointing at a node we do not have', () => {
    const r = blastRadius('ghost', [n('x', 'belief', ['ghost'])]);
    expect(r.impacted.map((i) => i.id)).toEqual(['x']);
  });

  it('has a default cap so a runaway graph cannot hang a request', () => {
    expect(MAX_BLAST_NODES).toBeGreaterThan(0);
  });
});

describe('the worklist is ordered by what it costs to be wrong', () => {
  it('puts decisions first, then runs, then beliefs', () => {
    const r = blastRadius('fact_price', GRAPH);
    const kinds = retractionWorklist(r).map((i) => i.kind);
    expect(kinds[0]).toBe('decision');
    expect(kinds[1]).toBe('decision');
    expect(kinds.slice(2)).toEqual(['belief', 'belief', 'finding']);
  });

  it('summarises in a sentence that should make someone check', () => {
    const s = describeBlastRadius(blastRadius('fact_price', GRAPH));
    expect(s).toMatch(/5 nodes rest on fact_price/);
    expect(s).toMatch(/2 of them are decisions already taken/);
  });
});
