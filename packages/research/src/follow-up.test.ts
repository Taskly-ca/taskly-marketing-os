/**
 * Planning a follow-up, and refusing to launder the last turn's credibility.
 *
 * Two halves. The first is ordinary: does the planner get told what it needs,
 * and does reuse pick the right URLs. The second is the one that matters — a
 * "related question" is generated text sitting in a rail that reads like
 * navigation, which is the most credulous place on the page, so an ungrounded
 * one there is an uncited claim nobody thinks to check. `bindRelated` is the
 * only thing between the model and that rail, so it is tested the way a gate is
 * tested: with the things it is supposed to refuse.
 */
import { describe, expect, it } from 'vitest';

import type { CitableSpan } from './attribute.js';
import type { ConversationTurn } from './events.js';
import { bindRelated, planSearches, relatedQuestions, reuseUrls } from './follow-up.js';
import type { AskPort, AskResult, ReadDoc } from './types.js';

const URL_A = 'https://example.com/jiffy';
const URL_B = 'https://competitor.example.org/taskrabbit';

const SPANS: CitableSpan[] = [
  {
    id: 1,
    docIndex: 1,
    url: URL_A,
    span: 'Jiffy operates in Toronto and Ottawa with a network of cleaners.',
  },
  {
    id: 2,
    docIndex: 2,
    url: URL_B,
    span: 'TaskRabbit charges a 15% service fee on every booking in Canada.',
  },
];

const DOCS: ReadDoc[] = [
  { url: URL_A, title: 'Jiffy pricing', text: '' },
  { url: URL_B, title: 'TaskRabbit fees', text: '' },
];

const HISTORY: ConversationTurn[] = [
  {
    question: 'What do competitors charge for cleaning in Toronto?',
    answer: 'Jiffy operates in Toronto and Ottawa [1]. TaskRabbit charges a 15% service fee [2].',
    sourceUrls: [URL_A, URL_B],
  },
];

/** Records what the planner was actually sent, so the prompt itself can be
 *  asserted on — the follow-up rules are behaviour, not decoration. */
function spyAsk(reply: unknown, cost = 0.01): AskPort & { system: string; user: string } {
  const spy = {
    system: '',
    user: '',
    ask: async (system: string, user: string): Promise<AskResult | null> => {
      spy.system = system;
      spy.user = user;
      return { text: JSON.stringify(reply), costCents: cost };
    },
  };
  return spy;
}

/* ── planning ─────────────────────────────────────────────────────────────── */

describe('planSearches — a first question plans exactly as it always did', () => {
  it('sends the bare question and no conversation rules', async () => {
    const ask = spyAsk({ queries: ['jiffy toronto pricing'], unanswerable: [] });
    const plan = await planSearches('What does Jiffy charge?', [], ask, 4);

    expect(ask.user).toBe('What does Jiffy charge?');
    expect(ask.system).not.toContain('FOLLOW-UP RULES');
    expect(plan.queries).toEqual(['jiffy toronto pricing']);
    // No history means nothing to reuse and nothing to resolve — the standalone
    // question is the question, not a rewrite of it.
    expect(plan.standalone).toBe('What does Jiffy charge?');
    expect(plan.reuse).toBe(false);
  });

  it('ignores a reuse or standalone field a first-turn model volunteers', async () => {
    // Turn one has no previous sources, so "reuse" could only resolve to an
    // empty list — and a run that believed it would skip the search and read
    // nothing at all.
    const ask = spyAsk({ queries: ['q'], reuse: true, standalone: 'something else entirely' });
    const plan = await planSearches('What does Jiffy charge?', [], ask, 4);
    expect(plan.reuse).toBe(false);
    expect(plan.standalone).toBe('What does Jiffy charge?');
  });
});

describe('planSearches — a follow-up is planned against the conversation', () => {
  it('shows the planner the prior turns, with citation markers intact', async () => {
    const ask = spyAsk({ queries: ['vancouver cleaning prices'], standalone: 'x', reuse: false });
    await planSearches('and in Vancouver?', HISTORY, ask, 4);

    expect(ask.user).toContain('What do competitors charge for cleaning in Toronto?');
    // The markers must survive into the prompt: "where did that come from?" is
    // a question ABOUT `[2]`, and a history that tidied it away cannot answer.
    expect(ask.user).toContain('[1]');
    expect(ask.user).toContain('[2]');
    expect(ask.user).toContain('FOLLOW-UP: and in Vancouver?');
    // Domains, so the planner can judge whether the old material still applies.
    // Not URLs — a URL in a prompt is a source a model can name unread.
    expect(ask.user).toContain('example.com');
    expect(ask.user).not.toContain(URL_A);
  });

  it('tells the planner what a bracketed number means and that empty is legal', async () => {
    const ask = spyAsk({ queries: [], standalone: 'x', reuse: true });
    await planSearches('where did that fee come from?', HISTORY, ask, 4);
    expect(ask.system).toContain('citation marker');
    expect(ask.system).toContain('MAY BE EMPTY');
  });

  it('takes the standalone rewrite, which is what phases A and B will answer', async () => {
    const ask = spyAsk({
      queries: ['vancouver house cleaning prices'],
      standalone: 'What do cleaning companies charge in Vancouver?',
      reuse: true,
    });
    const plan = await planSearches('and in Vancouver?', HISTORY, ask, 4);
    expect(plan.standalone).toBe('What do cleaning companies charge in Vancouver?');
    expect(plan.reuse).toBe(true);
  });

  it('falls back to the literal follow-up when the rewrite is missing or blank', async () => {
    // A blank rewrite would attribute and generate against an empty question,
    // which selects nothing. The literal follow-up is a weak question and a
    // safe one.
    const ask = spyAsk({ queries: ['q'], standalone: '   ', reuse: false });
    const plan = await planSearches('and in Vancouver?', HISTORY, ask, 4);
    expect(plan.standalone).toBe('and in Vancouver?');
  });

  it('caps the queries it will act on', async () => {
    const ask = spyAsk({ queries: ['a', 'b', 'c', 'd', 'e'] });
    expect((await planSearches('q', [], ask, 2)).queries).toEqual(['a', 'b']);
  });

  it('reports a refused model call instead of returning an empty plan', async () => {
    const plan = await planSearches('q', HISTORY, { ask: async (): Promise<null> => null }, 4);
    expect(plan.note).toContain('budget ceiling');
    expect(plan.queries).toEqual([]);
  });

  it('survives a reply that is not JSON at all', async () => {
    const plan = await planSearches(
      'q',
      HISTORY,
      { ask: async (): Promise<AskResult> => ({ text: 'sorry, I cannot', costCents: 0.01 }) },
      4,
    );
    expect(plan.queries).toEqual([]);
    expect(plan.reuse).toBe(false);
    expect(plan.note).toBe('');
  });
});

/* ── reuse ────────────────────────────────────────────────────────────────── */

describe('reuseUrls — what goes back on the reading list', () => {
  const plan = (over: Partial<Parameters<typeof reuseUrls>[1]> = {}): Parameters<typeof reuseUrls>[1] => ({
    queries: [], unanswerable: [], standalone: 'q', reuse: true, costCents: 0, note: '', ...over,
  });

  it('returns nothing when the planner did not ask for reuse', () => {
    expect(reuseUrls(HISTORY, plan({ reuse: false }), 8)).toEqual([]);
  });

  it('returns nothing when there is no history to reuse', () => {
    expect(reuseUrls([], plan(), 8)).toEqual([]);
  });

  it('reuses the most recent turn only', () => {
    // A chain that accumulated every URL it ever read would answer turn ten out
    // of turn one's pages. Reuse is a claim about continuity with the turn just
    // answered; when the subject moves back, the planner has a search to spend.
    const older: ConversationTurn = {
      question: 'older',
      answer: 'older',
      sourceUrls: ['https://stale.example.com/one'],
    };
    expect(reuseUrls([older, ...HISTORY], plan(), 8)).toEqual([URL_A, URL_B]);
  });

  it('leaves room for new material when the plan also has queries', () => {
    // "And in Vancouver?" reuses AND searches. If the old set fills every read
    // slot the new search returns pages there is no room to read, and the new
    // question gets answered out of the old pages.
    const many: ConversationTurn = {
      question: 'q',
      answer: 'a',
      sourceUrls: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'],
    };
    expect(reuseUrls([many], plan({ queries: ['new'] }), 8)).toHaveLength(4);
    expect(reuseUrls([many], plan(), 8)).toHaveLength(8);
  });

  it('never returns the same page twice', () => {
    const dupes: ConversationTurn = { question: 'q', answer: 'a', sourceUrls: [URL_A, URL_A, URL_B] };
    expect(reuseUrls([dupes], plan(), 8)).toEqual([URL_A, URL_B]);
  });
});

/* ── related questions ────────────────────────────────────────────────────── */

describe('bindRelated — the rail is generated text and is gated like any other', () => {
  const bind = (qs: unknown[]): string[] => bindRelated(qs, 'What do competitors charge?', SPANS, DOCS);

  it('keeps a question grounded in a proven quote', () => {
    expect(bind(['Does Jiffy operate outside Ottawa?'])).toEqual(['Does Jiffy operate outside Ottawa?']);
  });

  it('keeps a question grounded in a source title', () => {
    expect(bind(['Where is TaskRabbit pricing published?'])).toHaveLength(1);
  });

  it('drops a question about something no quote mentions', () => {
    // The suggestion that reads best is usually the invented one: it is the one
    // the model wrote from what it already believed rather than from the page.
    expect(bind(['How large is the Calgary snow-removal market?'])).toEqual([]);
  });

  it('drops a question that asserts a figure no quote carries', () => {
    // The assertion hides inside the question mark, where nothing checks it.
    expect(bind(['Is the 22% TaskRabbit fee competitive?'])).toEqual([]);
    expect(bind(['Is the 15% TaskRabbit fee competitive?'])).toHaveLength(1);
  });

  it('drops a question that crosses the honesty boundary', () => {
    // The boundary is legal, not stylistic, and it does not stop applying
    // because the sentence ends in a question mark.
    expect(bind(['Are Jiffy cleaners fully vetted in Ottawa?'])).toEqual([]);
    expect(bind(['Does Jiffy run a background check on cleaners in Toronto?'])).toEqual([]);
  });

  it('drops a question that presupposes a cause', () => {
    expect(bind(['What caused the TaskRabbit fee to rise in Canada?'])).toEqual([]);
  });

  it('drops statements, fragments and non-strings', () => {
    expect(bind(['Jiffy operates in Toronto.', 'Ottawa?', 42, null, ''])).toEqual([]);
  });

  it('drops a restatement of the question just answered', () => {
    expect(bindRelated(['Does Jiffy operate in Ottawa?'], 'Does Jiffy operate in Ottawa?', SPANS, DOCS))
      .toEqual([]);
  });

  it('deduplicates and stops at four', () => {
    const out = bind([
      'Does Jiffy operate in Ottawa?',
      'does jiffy operate in ottawa?',
      'What is the TaskRabbit service fee in Canada?',
      'How many cleaners does Jiffy have?',
      'Where does TaskRabbit publish its fees?',
      'Is Ottawa served by TaskRabbit too?',
    ]);
    expect(out).toHaveLength(4);
    expect(new Set(out.map((q) => q.toLowerCase())).size).toBe(4);
  });
});

describe('relatedQuestions', () => {
  it('spends nothing when there is no citable universe', async () => {
    let called = false;
    const ask: AskPort = {
      ask: async (): Promise<null> => {
        called = true;
        return null;
      },
    };
    // No spans means no evidence, and proposing next steps out of nothing is
    // the plain-LLM behaviour this package refuses — in the one place on the
    // page that carries no badge to contradict it.
    expect(await relatedQuestions('q', [], DOCS, ask)).toEqual({ related: [], costCents: 0 });
    expect(called).toBe(false);
  });

  it('shows the model the quotes and not the answer prose', async () => {
    const ask = spyAsk({ questions: ['Does Jiffy operate in Ottawa?'] }, 0.02);
    const out = await relatedQuestions('What do competitors charge?', SPANS, DOCS, ask);
    expect(ask.user).toContain('Jiffy operates in Toronto and Ottawa');
    expect(out.related).toEqual(['Does Jiffy operate in Ottawa?']);
    expect(out.costCents).toBe(0.02);
  });

  it('returns nothing rather than failing when the pass is refused', async () => {
    expect(await relatedQuestions('q', SPANS, DOCS, { ask: async (): Promise<null> => null }))
      .toEqual({ related: [], costCents: 0 });
  });
});
