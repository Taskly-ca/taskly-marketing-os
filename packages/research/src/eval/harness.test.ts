/**
 * THE HARNESS'S OWN ACCEPTANCE TESTS.
 *
 * `metrics.test.ts` proves the scorer is right about one statement. This file
 * proves the harness is right about the ARITHMETIC — which cases it lets into
 * the average, which it keeps out, and whether the caveats survive being
 * printed. Every exclusion rule here exists because including the case would
 * have moved a headline number in the flattering direction, so each one is
 * asserted rather than commented.
 */
import { describe, expect, it } from 'vitest';

import type { GroundedSpan } from '../grounded.js';
import type { GroundedAnswer, StreamedAnswer } from '../stream.js';

import { EVAL_CASES, EVAL_FIXTURES } from './cases.js';
import { formatEvalReport, runEval, transcriptFromGrounded, transcriptFromStreamed } from './harness.js';
import { scoreCitations } from './metrics.js';
import type { EvalCase, EvalTranscript } from './types.js';

describe('the regression set itself', () => {
  it('covers both modes, both outcomes, and carries known blind spots', () => {
    // A set that only contains answerable questions cannot measure a system's
    // willingness to refuse, which is most of what separates this pipeline from
    // the tools in the published citation-accuracy studies.
    expect(EVAL_CASES.filter((c) => c.mode === 'web').length).toBeGreaterThan(5);
    expect(EVAL_CASES.filter((c) => c.mode === 'grounded').length).toBeGreaterThan(5);
    expect(EVAL_CASES.filter((c) => c.expect === 'empty').length).toBeGreaterThan(5);
    expect(EVAL_CASES.filter((c) => c.shape === 'blind-spot').length).toBeGreaterThan(0);
  });

  it('gives every case a transcript, a reason for existing and honest provenance', () => {
    for (const c of EVAL_CASES) {
      expect(EVAL_FIXTURES[c.id], c.id).toBeDefined();
      expect(c.why.length, c.id).toBeGreaterThan(20);
      // A blind-spot case with no note would be an unexplained exclusion from
      // the averages, which is indistinguishable from cherry-picking.
      if (c.shape === 'blind-spot') expect(c.blindSpot?.length ?? 0, c.id).toBeGreaterThan(40);
    }
  });

  it('marks only web cases as safe to run live', () => {
    // Grounded retrieval lives in the console and is not reachable from this
    // package. Marking a grounded case `live` would produce a "grounded" number
    // that was never measured against grounded retrieval.
    for (const c of EVAL_CASES.filter((x) => x.live === true)) expect(c.mode).toBe('web');
  });
});

describe('runEval over the recorded set', () => {
  it('scores the whole set, and every abstention refuses WITH a reason', () => {
    return runEval().then((r) => {
      expect(r.ran).toBe(EVAL_CASES.length);
      expect(r.missing).toEqual([]);
      expect(r.abstention.wronglyAnswered).toBe(0);
      expect(r.abstention.wronglyAbstained).toBe(0);
      expect(r.abstention.correctlyAbstained).toBe(r.abstention.shouldAbstain);
      expect(r.assertionFailures).toEqual([]);
    });
  });

  it('keeps blind-spot cases OUT of the citation averages', async () => {
    const r = await runEval();
    const scored = new Set(r.citations.perStatement.map((s) => s.text));
    for (const c of EVAL_CASES.filter((x) => x.shape === 'blind-spot')) {
      const t = EVAL_FIXTURES[c.id];
      expect(t).toBeDefined();
      for (const s of t?.sentences ?? []) expect(scored.has(s.text), c.id).toBe(false);
      // …and they would have RAISED the average, which is the whole reason the
      // exclusion has to be enforced rather than trusted: every one of them
      // scores a perfect 1.0 on the metric that cannot see what is wrong.
      if (t) expect(scoreCitations(t).recall).toBe(1);
    }
    expect(r.blindSpots.length).toBe(EVAL_CASES.filter((x) => x.shape === 'blind-spot').length);
  });

  it('keeps abstentions out of the citation averages too', async () => {
    const r = await runEval();
    // Otherwise the cheapest way to raise citation recall would be to answer
    // fewer questions, and the metric would be pulling against the product.
    for (const c of EVAL_CASES.filter((x) => x.expect === 'empty')) {
      expect(r.excluded.some((e) => e.caseId === c.id), c.id).toBe(true);
    }
  });

  it('counts hand-built and live-recorded transcripts apart', async () => {
    const r = await runEval();
    expect(r.liveRecorded).toBeGreaterThan(0);
    expect(r.handBuilt).toBeGreaterThan(0);
    expect(r.liveRecorded + r.handBuilt).toBe(r.ran);
  });

  it('names a case it could not cover instead of quietly passing it', async () => {
    const r = await runEval(EVAL_CASES, (c) => (c.id === 'grounded-jiffy' ? null : (EVAL_FIXTURES[c.id] ?? null)));
    expect(r.missing).toEqual(['grounded-jiffy']);
    expect(r.ran).toBe(EVAL_CASES.length - 1);
  });
});

/* ── the failure modes the harness has to notice ──────────────────────────── */

const CASE = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: 'x',
  mode: 'web',
  question: 'q',
  shape: 'abstain',
  expect: 'empty',
  provenance: 'hand-built',
  why: 'a synthetic case built inside the harness tests',
  ...over,
});

const TRANSCRIPT = (over: Partial<EvalTranscript> = {}): EvalTranscript => ({
  caseId: 'x',
  mode: 'web',
  question: 'q',
  spans: [],
  sentences: [],
  sourceLocators: [],
  note: '',
  costCents: 0,
  ...over,
});

describe('abstention accounting', () => {
  it('counts an answer to an unanswerable question as wrongly answered', async () => {
    const r = await runEval([CASE()], () =>
      TRANSCRIPT({
        spans: [{ id: 1, locator: 'https://example.test/1', text: 'A page that is long enough to quote.' }],
        sentences: [{ n: 0, text: 'The market is worth $2.1B [1].', verdict: 'flagged' }],
      }),
    );
    expect(r.abstention.wronglyAnswered).toBe(1);
    expect(r.abstention.correctlyAbstained).toBe(0);
  });

  it('counts a SILENT empty answer as wrong, even though it answered nothing', async () => {
    // §10: a stored empty answer replayed as prose — a confident, uncited
    // sentence in the answer's voice. An abstention that does not say why is
    // not the honest outcome, it is the same screen with less on it.
    const r = await runEval([CASE()], () => TRANSCRIPT({ note: '' }));
    expect(r.abstention.correctlyAbstained).toBe(0);
    expect(r.abstention.wronglyAnswered).toBe(1);
  });

  it('counts a refusal to a question with an answer as wrongly abstained', async () => {
    const r = await runEval([CASE({ expect: 'answer', shape: 'factual' })], () => TRANSCRIPT({ note: 'nothing found' }));
    expect(r.abstention.wronglyAbstained).toBe(1);
  });
});

describe('per-case assertions', () => {
  it('fails a run whose answer drops the figure the question was about', async () => {
    const c = CASE({
      expect: 'answer',
      shape: 'factual',
      assertions: [{ kind: 'answer-carries-figure', value: '$99', why: 'the figure is the answer' }],
    });
    const r = await runEval([c], () =>
      TRANSCRIPT({
        spans: [{ id: 1, locator: 'https://example.test/1', text: 'Jiffy connects homeowners with local pros.' }],
        sentences: [{ n: 0, text: 'Prices were not stated on the page [1].', verdict: 'confirmed' }],
      }),
    );
    expect(r.assertionFailures.map((f) => f.value)).toEqual(['$99']);
  });

  it('fails a run that crosses the honesty boundary, whatever the citations say', async () => {
    // AGENTS rule 5. A perfectly cited sentence carrying a banned trust claim
    // is still a legal problem, and the citation metrics cannot see it.
    const c = CASE({
      expect: 'answer',
      shape: 'gate',
      assertions: [{ kind: 'never-says', value: 'background-checked', why: 'a trust claim we cannot support' }],
    });
    const r = await runEval([c], () =>
      TRANSCRIPT({
        spans: [{ id: 1, locator: 'https://example.test/1', text: 'Everyone here is Background-Checked before joining.' }],
        sentences: [{ n: 0, text: 'They say everyone is Background-Checked [1].', verdict: 'flagged' }],
      }),
    );
    expect(r.assertionFailures.length).toBe(1);
  });
});

/* ── adapters ─────────────────────────────────────────────────────────────── */

const streamed = (text: string, verdicts: StreamedAnswer['sentences']): StreamedAnswer => ({
  question: 'q',
  text,
  sources: [{ url: 'https://example.test/1', title: 'T', text: 'body' }],
  spans: [{ id: 1, docIndex: 1, url: 'https://example.test/1', span: 'Jiffy lists jobs starting at $99.' }],
  dropped: [],
  sentences: verdicts,
  flagged: verdicts.filter((s) => s.verdict === 'flagged').length,
  queries: ['jiffy pricing'],
  unanswered: [],
  related: [],
  reused: [],
  note: '',
  costCents: 0.17,
});

describe('transcriptFromStreamed', () => {
  it('re-splits the answer and pairs each sentence with its own verdict', () => {
    const t = transcriptFromStreamed(
      'c',
      streamed('Jiffy lists jobs starting at $99 [1]. It averages $55 [1].', [
        { n: 0, verdict: 'confirmed' },
        { n: 1, verdict: 'flagged', why: '"55" is in no cited span' },
      ]),
    );
    expect(t.misaligned).toBeUndefined();
    expect(t.sentences[1]?.text).toContain('$55');
    expect(t.sentences[1]?.verdict).toBe('flagged');
  });

  it('refuses to guess when the verdicts and the sentences do not line up', async () => {
    // Repairing this by index would attach verdicts to the wrong sentences and
    // every number downstream would be wrong in a way that looks normal.
    const t = transcriptFromStreamed('c', streamed('One sentence only [1].', [
      { n: 0, verdict: 'confirmed' },
      { n: 1, verdict: 'flagged' },
    ]));
    expect(t.misaligned).toBeDefined();
    expect(t.sentences).toEqual([]);

    const r = await runEval([CASE({ id: 'c', expect: 'answer', shape: 'factual' })], () => t);
    expect(r.excluded[0]?.caseId).toBe('c');
    expect(r.citations.statements).toBe(0);
  });
});

describe('transcriptFromGrounded', () => {
  it('keeps each span\'s kind, because a Brain passage and a competitor page are not equal evidence', () => {
    const spans: GroundedSpan[] = [
      { id: 1, docIndex: 1, url: '20-architecture/SYSTEM.md', span: 'Taskly keeps 20% of the agreed deal.', kind: 'brain', recordId: 'r1', title: 'SYSTEM' },
    ];
    const a: GroundedAnswer = {
      question: 'q',
      text: 'The platform keeps 20% of the agreed deal [1].',
      sources: [{ url: '20-architecture/SYSTEM.md', title: 'SYSTEM', text: 'Taskly keeps 20% of the agreed deal.' }],
      spans,
      dropped: [],
      sentences: [{ n: 0, verdict: 'confirmed' }],
      flagged: 0,
      related: [],
      note: '',
      costCents: 0.036,
    };
    const t = transcriptFromGrounded('c', a);
    expect(t.mode).toBe('grounded');
    expect(t.spans[0]?.kind).toBe('brain');
    expect(scoreCitations(t).recall).toBe(1);
  });
});

describe('formatEvalReport', () => {
  it('prints the blind spots and the caveat under the same roof as the numbers', async () => {
    const text = formatEvalReport(await runEval());
    expect(text).toContain('DETERMINISTIC');
    expect(text).toContain('ABSTENTION');
    // The caveat is the report's last word on purpose: a recall figure quoted
    // without it says more than it means.
    expect(text).toContain('WHAT THESE NUMBERS CANNOT SEE');
    expect(text).toContain('cannot tell "these words are in the span"');
    expect(text).toContain('second-hand');
  });
});
