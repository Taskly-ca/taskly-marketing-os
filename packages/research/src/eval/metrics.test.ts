/**
 * SCORING THE SCORER.
 *
 * A metric nobody has checked is an opinion with a decimal point on it, and
 * this one is going to be quoted against published third-party numbers, so
 * every rule in `metrics.ts` is exercised here against a case whose right
 * answer was decided by hand before the code ran.
 *
 * The most important test in this file is the last one. It asserts that the
 * known second-hand hallucination scores a PERFECT 1.0 — not because that is
 * desirable but because it is true, and a harness that quietly stopped being
 * blind to it without anyone changing the blindness would be lying in the more
 * dangerous direction.
 */
import { describe, expect, it } from 'vitest';

import { citedIds, poolCitations, scoreCitations, scoreStatement, supportUnits, unitsMetBy } from './metrics.js';
import type { EvalSentence, EvalSpan, EvalTranscript } from './types.js';

const span = (id: number, text: string, locator = `https://example.test/${id}`): EvalSpan => ({ id, locator, text });
const said = (text: string, verdict: 'confirmed' | 'flagged' = 'confirmed', n = 0): EvalSentence => ({ n, text, verdict });

describe('citedIds', () => {
  it('reads single, grouped and repeated markers', () => {
    expect(citedIds('a [1] b [2, 3] c [1].')).toEqual([1, 2, 3]);
  });

  it('leaves ordinary bracketed prose alone', () => {
    // Treating `[sic]` as a broken citation would flag honest sentences; the
    // cost of missing an exotic marker form is that it renders as text.
    expect(citedIds('the page says "colour" [sic] throughout.')).toEqual([]);
  });
});

describe('supportUnits', () => {
  it('takes figures from claimNumbers, so the eval and the shipped gate cannot drift', () => {
    // Bare integers under 10 are exempt in `verify.ts` — "the top 3 reasons"
    // must not demand a "3" on the page — and that exemption is inherited here
    // rather than re-decided.
    const units = supportUnits('The top 3 reasons cost $40 and 12% more.');
    expect(units.filter((u) => u.kind === 'figure').map((u) => u.text)).toEqual(['40', '12']);
  });

  it('does not treat marker digits as claims', () => {
    // Without stripping, [12] would demand that "12" appear in a cited span and
    // every well-cited statement past span 9 would fail for citing itself.
    expect(supportUnits('Rates are flat [12].').filter((u) => u.kind === 'figure')).toEqual([]);
  });

  it('takes a capitalised name mid-sentence and rejects sentence-starters', () => {
    const units = supportUnits('The platform operates in Toronto. However there is more.');
    const names = units.filter((u) => u.kind === 'entity').map((u) => u.text);
    expect(names).toContain('Toronto');
    expect(names).not.toContain('However');
    expect(names).not.toContain('The');
  });

  it('SKIPS the first token, because sentence-initial capitals are ambiguous', () => {
    // "Hourly rates run $40-$70" is correctly cited by a page that says "per
    // hour", and an earlier draft failed it for not containing the word
    // "Hourly". The rule under-reports on purpose: a name in first position is
    // not checked, and no honest sentence is ever flagged for one.
    expect(supportUnits('Hourly rates run high.')).toEqual([]);
    expect(supportUnits('Jiffy operates widely.')).toEqual([]);
  });

  it('takes a hyphenated coinage, because it is the document\'s own phrasing', () => {
    const names = supportUnits('Its position is safe-but-narrow.').map((u) => u.text);
    expect(names).toContain('safe-but-narrow');
  });

  it('finds nothing checkable in a sentence with no figure and no name', () => {
    expect(supportUnits('That does not settle the rest of the question.')).toEqual([]);
  });
});

describe('unitsMetBy', () => {
  it('matches a name case-insensitively and through a plural', () => {
    const units = supportUnits('The Jiffy taskers work in Toronto.');
    const met = unitsMetBy(units, [span(1, 'JIFFY tasker listings cover toronto and Ottawa.')]);
    expect(met.map((u) => u.text).sort()).toEqual(['Jiffy', 'Toronto']);
  });

  it('refuses a bare number on the page as support for a priced figure', () => {
    // Stricter than the verifier's private `numbersIn`, and stricter in the
    // right direction: "$5" is not supported by a page that says "5".
    const units = supportUnits('The fee is $5.99.');
    expect(unitsMetBy(units, [span(1, 'There are 5 99 things on this page.')])).toEqual([]);
  });
});

describe('scoreStatement', () => {
  it('scores a cited, fully supported statement 1.0 on both legs', () => {
    const s = scoreStatement(
      said('TaskRabbit taskers in Toronto charge $40–$70 per hour [1].'),
      [span(1, 'TaskRabbit taskers in Toronto set their own rates, typically $40–$70 per hour.')],
    );
    expect(s.recall).toBe(true);
    expect(s.citations).toBe(1);
    expect(s.loadBearing).toBe(1);
  });

  it('fails recall on a figure the model derived rather than read', () => {
    const s = scoreStatement(
      said('That averages about $55 an hour [1].', 'flagged'),
      [span(1, 'Rates typically run $40–$70 per hour.')],
    );
    expect(s.recall).toBe(false);
    expect(s.unitsMet.map((u) => u.text)).not.toContain('55');
  });

  it('fails recall on a factual statement with no citation at all', () => {
    const s = scoreStatement(said('Most Toronto homeowners book within a week.'), [span(1, 'Toronto listings are common.')]);
    expect(s.citations).toBe(0);
    expect(s.recall).toBe(false);
  });

  it('fails recall when the sentence names a company the cited span never mentions', () => {
    // `grounded.ts` names this the undetectable one: a current, correctly-cited
    // fact about the WRONG company. The name has to sit past the first token to
    // be checked at all — see the sentence-initial exemption above, which is
    // the single largest hole in this metric's coverage.
    const s = scoreStatement(
      said('The Greater Toronto Area is served by Handy [1].'),
      [span(1, 'Jiffy is available across the Greater Toronto Area and in Ottawa.')],
    );
    expect(s.recall).toBe(false);
    expect(s.units.map((u) => u.text)).toContain('Handy');
  });

  it('counts a citation that carries nothing the sentence needs as not load-bearing', () => {
    const s = scoreStatement(said('Jiffy lists jobs starting at $99 [1][2].'), [
      span(1, 'Jiffy connects homeowners with local pros for jobs starting at $99.'),
      span(2, 'Jiffy operates in Toronto, Ottawa and Calgary.'),
    ]);
    expect(s.recall).toBe(true);
    expect(s.citations).toBe(2);
    expect(s.loadBearing).toBe(1);
  });

  it('counts both citations when each carries something, so corroboration is not punished', () => {
    const s = scoreStatement(
      said('On Jiffy a service fee applies to each job [1], while TaskRabbit taskers in Toronto set their own rates [2].'),
      [span(1, 'Jiffy charges a service fee on each completed job.'), span(2, 'TaskRabbit taskers in Toronto set their own rates.')],
    );
    expect(s.loadBearing).toBe(2);
  });

  it('marks a statement with nothing checkable as vacuous rather than scoring it', () => {
    const s = scoreStatement(said('That does not settle the rest of the question [1].'), [span(1, 'Some page text that is long enough.')]);
    expect(s.vacuous).toBe(true);
    expect(s.units).toEqual([]);
  });

  it('credits no citation when the joint set does not support the statement', () => {
    // ALCE's own rule: precision is only asked once recall holds. A padded
    // citation on an already-unsupported sentence is not a separate defect.
    const s = scoreStatement(said('The company Handy charges $250 [1].'), [span(1, 'Jiffy connects homeowners with local pros.')]);
    expect(s.recall).toBe(false);
    expect(s.loadBearing).toBe(0);
  });

  it('THE BLIND SPOT: the live second-hand hallucination scores a perfect 1.0', () => {
    // TMOS-ANSWER-ENGINE §10. Our document says Jiffy is safe-but-narrow and
    // that "broad and safe" is the UNOCCUPIED position Taskly targets; the
    // model welded them together. Both phrases are genuinely in the span, so
    // every deterministic check here passes and the sentence is false.
    //
    // This test exists so the blindness is a recorded, asserted property of the
    // harness rather than a paragraph in a comment that could quietly stop
    // being true. If it ever fails, something started reading for meaning —
    // find out what, and whether it is a measurement or a model.
    const s = scoreStatement(
      said('Its market positioning is described as safe-but-narrow and broad and safe [1].'),
      [span(1, "Jiffy's positioning is safe-but-narrow, and the broad and safe position it leaves open is the one Taskly targets.")],
    );
    expect(s.recall).toBe(true);
    expect(s.loadBearing).toBe(1);
    expect(s.citations).toBe(1);
  });
});

const transcript = (sentences: EvalSentence[], spans: EvalSpan[]): EvalTranscript => ({
  caseId: 't',
  mode: 'web',
  question: 'q',
  spans,
  sentences,
  sourceLocators: spans.map((s) => s.locator),
  note: '',
  costCents: 0,
});

describe('scoreCitations', () => {
  it('separates strict recall from recall, so a vacuous pass cannot flatter the number', () => {
    const m = scoreCitations(
      transcript(
        [
          said('Jiffy lists jobs starting at $99 [1].', 'confirmed', 0),
          said('That does not settle the rest [1].', 'confirmed', 1),
          said('It averages about $55 [1].', 'flagged', 2),
        ],
        [span(1, 'Jiffy connects homeowners with local pros for jobs starting at $99.')],
      ),
    );
    expect(m.statements).toBe(3);
    expect(m.vacuousStatements).toBe(1);
    // Recall counts the vacuous statement as a pass (it is cited); strict
    // recall drops it and reports 1 of the 2 statements that had something to
    // check. Quoting either alone would be misleading, which is why both exist.
    expect(m.recall).toBeCloseTo(2 / 3);
    expect(m.strictRecall).toBeCloseTo(1 / 2);
  });

  it('excludes citations on vacuous statements from precision entirely', () => {
    const m = scoreCitations(
      transcript([said('That does not settle the rest [1][2].')], [span(1, 'Long enough page text here.'), span(2, 'Another long enough page text.')]),
    );
    // With nothing to check, an ablation cannot tell a load-bearing citation
    // from a decorative one. Scoring these 0 would report our ignorance as the
    // model's padding, so they leave both sides of the ratio.
    expect(m.precisionDenominator).toBe(0);
    expect(m.precision).toBe(1);
  });

  it('reports where the shipped per-sentence check and citation recall disagree', () => {
    const m = scoreCitations(
      transcript(
        [
          // The gate confirms it — there is no figure to miss. ALCE recall does
          // not, because it carries no citation. The disagreement is the finding.
          said('Most Toronto homeowners book within a week.', 'confirmed', 0),
          said('Jiffy lists jobs starting at $99 [1].', 'confirmed', 1),
        ],
        [span(1, 'Jiffy connects homeowners with local pros for jobs starting at $99.')],
      ),
    );
    expect(m.disagreesWithPipeline).toBe(1);
    expect(m.agreesWithPipeline).toBe(1);
  });
});

describe('poolCitations', () => {
  it('pools over statements, not over answers', () => {
    // A one-sentence answer and a three-sentence answer are not equal evidence.
    // Averaging per-answer rates would give (1.0 + 1/3) / 2 = 66.7%; pooling
    // over the four statements gives 50%, which is what actually happened.
    const short = scoreCitations(transcript([said('Jiffy lists jobs at $99 [1].')], [span(1, 'Jiffy lists jobs at $99 today.')]));
    const long = scoreCitations(
      transcript(
        [
          said('Jiffy lists jobs at $99 [1].', 'confirmed', 0),
          said('It also averages $55 [1].', 'flagged', 1),
          said('The rival Handy charges more [1].', 'flagged', 2),
        ],
        [span(1, 'Jiffy lists jobs at $99 today.')],
      ),
    );
    const pooled = poolCitations([short, long]);
    expect(pooled.statements).toBe(4);
    expect(pooled.recall).toBeCloseTo(0.5);
  });

  it('scores an empty pool as 1.0 rather than dividing by zero', () => {
    expect(poolCitations([]).recall).toBe(1);
    expect(poolCitations([]).statements).toBe(0);
  });
});
