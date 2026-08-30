/**
 * THE FOUNDER'S DOOR INTO THE LEDGER.
 *
 * `SEED_QUESTIONS` ships without a `p` on purpose, and its header says why: the
 * founder and the agent each supply their own probability for the SAME question
 * and are scored separately, because that comparison is the point of the whole
 * ledger. Thirteen rows went in as `agent:claude-opus-5` and nothing was ever
 * built that could write the other side, so the most valuable output this
 * system produces has had one side since August.
 *
 * Two properties matter more than the shape of the CLI:
 *
 *  1. **A forecast is never shown the agent's number first.** Anchoring is not
 *     a hypothetical here — the agent's `p` is one file away, and a human who
 *     reads 0.85 before writing their own does not produce an independent
 *     forecast, they produce a slightly-adjusted copy. Scoring two correlated
 *     numbers against each other measures nothing. So `list` hides it, and it
 *     becomes visible only once the human's row exists.
 *
 *  2. **One forecast per question per author.** The idempotency key is
 *     (claim, author), not claim — the second row for the same claim under a
 *     different author is the entire design. Running the seed twice once
 *     produced 24 rows for 13 questions and double-counted every score it
 *     touched; the same trap is one keystroke away here.
 */
import { describe, expect, it } from 'vitest';

import { HUMAN_AUTHOR, chooseQuestion, parseProbability, summarise } from './forecast.js';

const questions = [
  { key: 'jiffy_toronto_snow', claim: 'Jiffy advertises snow removal', resolve_at: 'x', resolver: {}, rationale: 'r' },
  { key: 'handy_ca_presence', claim: 'Handy shows no Canadian page', resolve_at: 'y', resolver: {}, rationale: 'r' },
] as never[];

describe('parseProbability', () => {
  it('takes a probability, not a percentage', () => {
    expect(parseProbability('0.85')).toBe(0.85);
    expect(parseProbability('.2')).toBe(0.2);
  });

  it('refuses 0 and 1 — a forecast that cannot be wrong is not a forecast', () => {
    // The ledger clamps to 0.01–0.99. Saying 1.0 and being wrong is an infinite
    // log score, and a forecaster who never says 1.0 is the one worth scoring.
    expect(() => parseProbability('0')).toThrow(/between 0.01 and 0.99/);
    expect(() => parseProbability('1')).toThrow(/between 0.01 and 0.99/);
  });

  it('catches the percentage mistake by name rather than clamping it', () => {
    // 85 silently becoming 0.99 is the worst outcome: a confident forecast the
    // founder never made, scored against them.
    expect(() => parseProbability('85')).toThrow(/percentage/i);
  });

  it('refuses anything that is not a number', () => {
    expect(() => parseProbability('likely')).toThrow(/not a number/i);
  });
});

describe('chooseQuestion', () => {
  it('finds a question by key', () => {
    expect(chooseQuestion(questions, 'handy_ca_presence', [])?.key).toBe('handy_ca_presence');
  });

  it('refuses a key that is not a seed question, naming the ones that are', () => {
    // Silently writing a free-text claim would route around question-selection
    // bias — the trap SEED_QUESTIONS exists to close.
    expect(() => chooseQuestion(questions, 'made_up', [])).toThrow(/unknown question "made_up"/);
    expect(() => chooseQuestion(questions, 'made_up', [])).toThrow(/jiffy_toronto_snow/);
  });

  it('refuses a question this author already forecast', () => {
    const existing = [{ author: HUMAN_AUTHOR, claim: 'Handy shows no Canadian page' }] as never[];
    expect(() => chooseQuestion(questions, 'handy_ca_presence', existing)).toThrow(/already/i);
  });

  it('does not treat the agent\'s row as yours', () => {
    // The whole point: the same claim carries two rows under two authors.
    const existing = [{ author: 'agent:claude-opus-5', claim: 'Handy shows no Canadian page' }] as never[];
    expect(chooseQuestion(questions, 'handy_ca_presence', existing)?.key).toBe('handy_ca_presence');
  });
});

describe('summarise — what the list may reveal', () => {
  it('hides the agent number on a question you have not forecast', () => {
    const rows = summarise(questions, [{ author: 'agent:x', claim: 'Jiffy advertises snow removal', p: 0.85 }] as never[]);
    const open = rows.find((r) => r.key === 'jiffy_toronto_snow')!;
    expect(open.yours).toBeNull();
    expect(open.agent).toBeNull();
  });

  it('reveals it only once your own forecast is in', () => {
    const rows = summarise(questions, [
      { author: 'agent:x', claim: 'Jiffy advertises snow removal', p: 0.85 },
      { author: HUMAN_AUTHOR, claim: 'Jiffy advertises snow removal', p: 0.4 },
    ] as never[]);
    const done = rows.find((r) => r.key === 'jiffy_toronto_snow')!;
    expect(done.yours).toBe(0.4);
    expect(done.agent).toBe(0.85);
  });
});
