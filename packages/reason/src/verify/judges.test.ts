import { describe, it, expect } from 'vitest';
import {
  UnpinnedModelError,
  judgeL1,
  judgeL2,
  verificationLadder,
  RUBRIC_DIMENSIONS,
  L2_MIN_TOTAL,
} from './judges.js';
import type {
  L1Input,
  L1Port,
  L1Request,
  L1Response,
  L2Port,
  PinnedModel,
  RubricDimension,
  RubricRequest,
  RubricResponse,
} from './judges.js';
import type { VerifiableFinding } from './adversarial.js';

const URL = 'https://jiffyondemand.com/pricing';
const OBSERVED_AT = '2026-08-04T00:00:00.000Z';
const clock = () => '2026-08-04T09:30:00.000Z';

const PIN: PinnedModel = { model: 'anthropic/claude-opus-4', version: '2026-06-01' };

class SpyL1 implements L1Port {
  readonly seen: L1Request[] = [];
  constructor(private readonly replies: readonly L1Response[]) {}
  async judge(request: L1Request): Promise<L1Response> {
    this.seen.push(request);
    return (
      this.replies[this.seen.length - 1] ?? { label: 'abstain', reason: 'no reply configured' }
    );
  }
}

class SpyL2 implements L2Port {
  readonly seen: RubricRequest[] = [];
  constructor(private readonly reply: RubricResponse) {}
  async score(request: RubricRequest): Promise<RubricResponse> {
    this.seen.push(request);
    return this.reply;
  }
}

const full = (n: number): Record<RubricDimension, number> =>
  Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, n])) as Record<RubricDimension, number>;

const finding = (claim: string, spans: string[] = [claim]): VerifiableFinding => ({
  claim,
  evidence: spans.map((span) => ({ source_url: URL, span, observed_at: OBSERVED_AT })),
  generated_by: 'agent:groq/llama-3.3-70b@2026-05-01',
});

/* ── L1 ───────────────────────────────────────────────────────────────────── */

describe('L1 sees the cited span and nothing else', () => {
  const input: L1Input = {
    claim: 'Jiffy raised prices 12%.',
    spans: ['Jiffy raised prices 12% in July.', 'Jiffy operates in Toronto.'],
  };

  it('sends one isolated request per span, carrying only claim and span', async () => {
    const port = new SpyL1([
      { label: 'not_entailed', reason: 'about geography, not price' },
      { label: 'entailed', reason: 'the span states it' },
    ]);
    await judgeL1(port, input);

    expect(port.seen).toHaveLength(2);
    for (const req of port.seen) {
      expect(Object.keys(req).sort()).toEqual(['claim', 'span']);
      expect(req.claim).toBe(input.claim);
    }
    expect(port.seen.map((r) => r.span)).toEqual(input.spans);
  });

  it('stops at the first entailment — the remaining calls cannot change it', async () => {
    const port = new SpyL1([
      { label: 'entailed', reason: 'the span states it' },
      { label: 'not_entailed', reason: 'never asked' },
    ]);
    expect((await judgeL1(port, input)).outcome).toBe('pass');
    expect(port.seen).toHaveLength(1);
  });

  it('strips context a caller tries to smuggle in, even past the type', async () => {
    // A judge that can see the rest of the document fills gaps from context the
    // reader never had, and then reports the claim as grounded. The type forbids
    // this; the runtime enforces it, because a cast can defeat a type.
    const smuggled = {
      claim: 'Jiffy raised prices 12%.',
      spans: ['Jiffy raised prices 12% in July.'],
      document: 'THE WHOLE DOCUMENT, INCLUDING THE PARAGRAPH THAT EXPLAINS IT',
      sibling_findings: ['Jiffy is losing share'],
    } as unknown as L1Input;

    const port = new SpyL1([{ label: 'entailed', reason: 'stated verbatim' }]);
    await judgeL1(port, smuggled);

    expect(Object.keys(port.seen[0]!)).toEqual(['claim', 'span']);
    expect(JSON.stringify(port.seen)).not.toContain('THE WHOLE DOCUMENT');
    expect(JSON.stringify(port.seen)).not.toContain('losing share');
  });

  it('passes when ANY single span entails the claim — evidence is disjunctive', async () => {
    const port = new SpyL1([
      { label: 'not_entailed', reason: 'wrong quarter' },
      { label: 'entailed', reason: 'stated verbatim' },
    ]);
    const v = await judgeL1(port, input);
    expect(v.outcome).toBe('pass');
    expect(v.span).toBe(input.spans[1]);
  });

  it('fails when no span entails the claim', async () => {
    const port = new SpyL1([
      { label: 'not_entailed', reason: 'wrong quarter' },
      { label: 'not_entailed', reason: 'geography only' },
    ]);
    expect((await judgeL1(port, input)).outcome).toBe('fail');
  });

  it('abstains — never fails — when a judge response is malformed', async () => {
    const cases: L1Response[] = [
      { label: 'probably', reason: 'hmm' },
      { label: 'entailed', reason: '' },
      { label: '', reason: 'x' },
    ];
    for (const reply of cases) {
      const port = new SpyL1([reply, { label: 'not_entailed', reason: 'no' }]);
      const v = await judgeL1(port, input);
      expect(v.outcome).toBe('abstain');
      expect(v.reason).toMatch(/abstain|malformed|unrecognised/i);
    }
  });

  it('abstains when the port throws', async () => {
    const port: L1Port = {
      judge: () => Promise.reject(new Error('rate limited')),
    };
    expect((await judgeL1(port, input)).outcome).toBe('abstain');
  });

  it('an abstention is never a pass', async () => {
    const port = new SpyL1([{ label: 'abstain', reason: 'the span is ambiguous' }]);
    const v = await judgeL1(port, { claim: 'x', spans: ['y'] });
    expect(v.outcome).toBe('abstain');
    expect(v.outcome).not.toBe('pass');
  });
});

/* ── L2 ───────────────────────────────────────────────────────────────────── */

describe('L2 is one pinned, deterministic call per digest', () => {
  const items = [
    { id: 'f1', claim: 'Jiffy raised prices 12%.', so_what: 'our 20% take looks cheaper' },
    { id: 'f2', claim: 'Jiffy hired 40 taskers.', so_what: 'supply is tightening' },
  ];
  const ok: RubricResponse = {
    scores: [
      { id: 'f1', scores: full(3), note: 'specific and sourced' },
      { id: 'f2', scores: full(2), note: 'useful' },
    ],
  };

  it('refuses an unpinned judge', async () => {
    const port = new SpyL2(ok);
    for (const bad of ['', '   ', 'latest', 'stable', 'current']) {
      await expect(
        judgeL2(port, { items, judge: { model: PIN.model, version: bad }, now: clock }),
      ).rejects.toThrow(UnpinnedModelError);
    }
    // Refused before the call: an unpinned run must not also cost money.
    expect(port.seen).toHaveLength(0);
  });

  it('makes ONE call for the whole digest, at temperature 0', async () => {
    const port = new SpyL2(ok);
    await judgeL2(port, { items, judge: PIN, now: clock });
    expect(port.seen).toHaveLength(1);
    expect(port.seen[0]!.temperature).toBe(0);
    expect(port.seen[0]!.items.map((i) => i.id)).toEqual(['f1', 'f2']);
    expect(port.seen[0]!.dimensions).toEqual(RUBRIC_DIMENSIONS);
  });

  it('records the exact judge and when it ran', async () => {
    const v = await judgeL2(new SpyL2(ok), { items, judge: PIN, now: clock });
    expect(v.judge).toEqual(PIN);
    expect(v.checked_at).toBe(clock());
    expect(v.outcome).toBe('pass');
  });

  it('abstains on the one item whose score is out of range, not the batch', async () => {
    const port = new SpyL2({
      scores: [
        { id: 'f1', scores: { ...full(3), specificity: 9 }, note: 'x' },
        { id: 'f2', scores: full(2), note: 'y' },
      ],
    });
    const v = await judgeL2(port, { items, judge: PIN, now: clock });
    expect(v.items.find((i) => i.id === 'f1')?.outcome).toBe('abstain');
    expect(v.items.find((i) => i.id === 'f2')?.outcome).toBe('pass');
    expect(v.outcome).toBe('abstain');
  });

  it('abstains on a missing dimension and on a missing item', async () => {
    const port = new SpyL2({
      scores: [{ id: 'f1', scores: { specificity: 3 }, note: 'x' }],
    });
    const v = await judgeL2(port, { items, judge: PIN, now: clock });
    expect(v.items.find((i) => i.id === 'f1')?.outcome).toBe('abstain');
    expect(v.items.find((i) => i.id === 'f2')?.outcome).toBe('abstain');
  });

  it('abstains the WHOLE batch on an id it was never sent', async () => {
    // An id we did not send means the mapping between scores and findings is
    // unreliable — for every item, not just the phantom one.
    const port = new SpyL2({
      scores: [
        { id: 'f1', scores: full(3), note: 'x' },
        { id: 'ghost', scores: full(3), note: 'y' },
      ],
    });
    const v = await judgeL2(port, { items, judge: PIN, now: clock });
    expect(v.outcome).toBe('abstain');
    expect(v.items.every((i) => i.outcome === 'abstain')).toBe(true);
    expect(v.reason).toContain('ghost');
  });

  it('fails an item scoring zero on any dimension, whatever the total', async () => {
    const port = new SpyL2({
      scores: [
        { id: 'f1', scores: { ...full(3), source_quality: 0 }, note: 'x' },
        { id: 'f2', scores: full(2), note: 'y' },
      ],
    });
    const v = await judgeL2(port, { items, judge: PIN, now: clock });
    expect(v.items.find((i) => i.id === 'f1')?.outcome).toBe('fail');
  });

  it(`fails an item below the ${L2_MIN_TOTAL}-point floor`, async () => {
    const port = new SpyL2({
      scores: [
        { id: 'f1', scores: full(1), note: 'thin' },
        { id: 'f2', scores: full(2), note: 'y' },
      ],
    });
    const v = await judgeL2(port, { items, judge: PIN, now: clock });
    expect(v.items.find((i) => i.id === 'f1')?.outcome).toBe('fail');
    expect(v.outcome).toBe('fail');
  });

  it('abstains when the port throws', async () => {
    const port: L2Port = { score: () => Promise.reject(new Error('502')) };
    const v = await judgeL2(port, { items, judge: PIN, now: clock });
    expect(v.outcome).toBe('abstain');
    expect(v.items.every((i) => i.outcome === 'abstain')).toBe(true);
  });
});

/* ── the ladder ───────────────────────────────────────────────────────────── */

describe('the ladder runs cheapest-first and short-circuits', () => {
  const l2Pass = {
    outcome: 'pass' as const,
    items: [{ id: 'f1', outcome: 'pass' as const, scores: full(3), reason: 'ok' }],
    judge: PIN,
    checked_at: clock(),
    reason: 'ok',
  };

  it('never reaches L1 when L0 fails', async () => {
    const port = new SpyL1([{ label: 'entailed', reason: 'would have passed' }]);
    const r = await verificationLadder({
      id: 'f1',
      finding: finding('Jiffy raised prices 23%.', ['Jiffy raised prices 12%.']),
      retrievedUrls: [URL],
      l1: port,
      l2: l2Pass,
    });

    expect(r.ok).toBe(false);
    expect(r.failed_at).toBe('l0');
    expect(port.seen).toHaveLength(0); // the whole point: no model was paid
    expect(r.l1).toBeNull();
  });

  it('stops at L1 without consulting the digest rubric', async () => {
    const port = new SpyL1([{ label: 'not_entailed', reason: 'does not follow' }]);
    const r = await verificationLadder({
      id: 'f1',
      finding: finding('Jiffy is losing customers.', ['Jiffy raised prices 12%.']),
      retrievedUrls: [URL],
      l1: port,
      l2: l2Pass,
    });
    expect(r.failed_at).toBe('l1');
    expect(r.l2).toBeNull();
  });

  it('stops at L1 on an abstention — needs a human, not a rubric', async () => {
    const port = new SpyL1([{ label: 'abstain', reason: 'ambiguous' }]);
    const r = await verificationLadder({
      id: 'f1',
      finding: finding('Jiffy raised prices 12%.'),
      retrievedUrls: [URL],
      l1: port,
      l2: l2Pass,
    });
    expect(r.ok).toBe(false);
    expect(r.failed_at).toBe('l1');
  });

  it('fails closed when no digest-level L2 verdict was supplied', async () => {
    const port = new SpyL1([{ label: 'entailed', reason: 'stated verbatim' }]);
    const r = await verificationLadder({
      id: 'f1',
      finding: finding('Jiffy raised prices 12%.'),
      retrievedUrls: [URL],
      l1: port,
      l2: null,
    });
    expect(r.ok).toBe(false);
    expect(r.failed_at).toBe('l2');
  });

  it('passes only when all three levels do', async () => {
    const port = new SpyL1([{ label: 'entailed', reason: 'stated verbatim' }]);
    const r = await verificationLadder({
      id: 'f1',
      finding: finding('Jiffy raised prices 12%.'),
      retrievedUrls: [URL],
      l1: port,
      l2: l2Pass,
    });
    expect(r.ok).toBe(true);
    expect(r.failed_at).toBeNull();
    expect(r.l0.ok).toBe(true);
    expect(r.l1?.outcome).toBe('pass');
    expect(r.l2?.outcome).toBe('pass');
  });

  it('fails when the digest rubric has no entry for this finding', async () => {
    const port = new SpyL1([{ label: 'entailed', reason: 'stated verbatim' }]);
    const r = await verificationLadder({
      id: 'not-in-the-digest',
      finding: finding('Jiffy raised prices 12%.'),
      retrievedUrls: [URL],
      l1: port,
      l2: l2Pass,
    });
    expect(r.ok).toBe(false);
    expect(r.failed_at).toBe('l2');
  });
});
