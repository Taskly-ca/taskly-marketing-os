import { describe, expect, it } from 'vitest';
import { newTurn, pieces, plainAnswer, reduce, replay, type Frame, type Turn } from './answer';

const run = (turn: Turn, frames: Frame[]) => frames.reduce(reduce, turn);
const f = (event: string, data: unknown): Frame => ({ event, data });

describe('reduce — a web run', () => {
  const done = run(newTurn('What does TaskRabbit charge in Toronto?', 'web'), [
    f('status', { phase: 'planning' }),
    f('status', { phase: 'searching', detail: 'q1 · q2' }),
    f('source', { i: 1, url: 'https://a.example/p', title: 'Fees &ndash; A', domain: 'a.example' }),
    f('source', { i: 1, url: 'https://dup.example', title: 'dup', domain: 'dup' }),
    f('span', { id: 1, sourceIndex: 1, quote: 'a 15% fee' }),
    f('delta', { n: 0, text: 'They charge 15% [' }),
    f('delta', { n: 0, text: '1]. ' }),
    f('sentence', { n: 0, verdict: 'confirmed' }),
    f('delta', { n: 1, text: 'Maybe more.' }),
    f('sentence', { n: 1, verdict: 'flagged', why: 'no figure in the span' }),
    f('epilogue', { unanswered: ['GTA-specific surcharges'], related: ['What does Jiffy charge?'], note: '' }),
    f('done', { costCents: 0.4, threadId: 't1', messageId: 'm1', flagged: 1 }),
  ]);

  it('records every phase in the activity trail, in order', () => {
    expect(done.activity.filter(a => a.kind === 'status').map(a => (a as { phase: string }).phase)).toEqual(['planning', 'searching']);
  });
  it('keeps the first source for an index and decodes entities in titles', () => {
    expect(done.sources).toHaveLength(1);
    expect(done.sources[0]?.title).toBe('Fees – A');
    expect(done.sources[0]?.kind).toBe('web');
  });
  it('joins deltas per sentence and applies verdicts without moving text', () => {
    expect(done.sentences.map(s => [s.text, s.verdict])).toEqual([['They charge 15% [1]. ', 'confirmed'], ['Maybe more.', 'flagged']]);
    expect(done.sentences[1]?.why).toBe('no figure in the span');
  });
  it('finishes with cost, flags, the message id and the epilogue', () => {
    expect(done.live).toBe(false);
    expect(done.costCents).toBe(0.4);
    expect(done.messageId).toBe('m1');
    expect(done.unanswered).toEqual(['GTA-specific surcharges']);
    expect(done.related).toEqual(['What does Jiffy charge?']);
    expect(done.note).toBeUndefined();
  });
  it('copies with markers, sources and the unconfirmed list', () => {
    const text = plainAnswer(done, true);
    expect(text).toContain('[1] Fees – A — https://a.example/p');
    expect(text).toContain('Could not be confirmed:');
    expect(plainAnswer(done, false)).toBe('They charge 15%. Maybe more.');
  });
});

describe('pieces', () => {
  it('holds an unclosed marker back while live, and splits multi-markers', () => {
    expect(pieces('Fees rose [1', true)).toEqual([{ t: 'text', text: 'Fees rose ' }]);
    expect(pieces('Fees rose [1; 3].', false)).toEqual([{ t: 'text', text: 'Fees rose' }, { t: 'cite', n: 1 }, { t: 'cite', n: 3 }, { t: 'text', text: '.' }]);
  });
  it('leaves a non-numeric bracket as prose', () => {
    expect(pieces('He said [sic] it.', false)).toEqual([{ t: 'text', text: 'He said [sic] it.' }]);
  });
});

describe('reduce — a deep run', () => {
  const start = newTurn('Where should we spend our first $5,000?', 'deep');

  it('a clarify ends the run without finishing it', () => {
    const t = run(start, [f('clarify', { questions: ['Which city?'], because: 'Too broad' })]);
    expect(t.live).toBe(false);
    expect(t.doneAt).toBeUndefined();
    expect(t.clarify?.questions).toEqual(['Which city?']);
  });

  it('flags a re-ask of the same questions after answering', () => {
    const rerun = { ...newTurn(start.question, 'deep', ['Toronto']), asked: ['Which city?'] };
    expect(run(rerun, [f('clarify', { questions: ['Which city?'], because: '' })]).reAsked).toBe(true);
  });

  it('a revision changes the plan: reworded steps keep their old question, missing ones are dropped, new ones added', () => {
    const t = run(start, [
      f('plan', { steps: [{ n: 1, question: 'A?', why: '' }, { n: 2, question: 'B?', why: '' }, { n: 3, question: 'C?', why: '' }] }),
      f('step', { n: 1, state: 'running' }),
      f('step', { n: 1, state: 'done', found: 0 }),
      f('reflect', { after: 1, stillOpen: ['B'], note: 'nothing yet' }),
      f('plan', { steps: [{ n: 1, question: 'A, narrower?', why: '' }, { n: 2, question: 'B?', why: '' }, { n: 4, question: 'D?', why: '' }], revisedBecause: 'step 1 proved nothing' }),
    ]);
    const byN = Object.fromEntries((t.plan ?? []).map(s => [s.n, s]));
    expect(byN[1]?.question).toBe('A, narrower?');
    expect(byN[1]?.was).toEqual([{ question: 'A?', outcome: 'nothing proved' }]);
    expect(byN[1]?.state).toBe('pending');
    expect(byN[3]?.dropped).toBe(true);
    expect(byN[4]?.added).toBe(true);
    expect(t.planRevisions).toBe(1);
    expect(t.reflections).toHaveLength(1);
    expect(t.activity.find(a => a.kind === 'plan' && a.revised)).toMatchObject({ because: 'step 1 proved nothing', changes: 'reworded 1 · added 1 · dropped 1' });
  });

  it('a step the plan never named still shows up', () => {
    const t = run(start, [f('plan', { steps: [] }), f('step', { n: 9, state: 'running', detail: 'extra' })]);
    expect(t.plan?.[0]).toMatchObject({ n: 9, state: 'running' });
  });
});

describe('reduce — errors and grounded frames', () => {
  it('an error_msg string stops the run and lands in the trail', () => {
    const t = reduce(newTurn('question long enough', 'web'), f('error_msg', 'Refused by the daily budget'));
    expect(t).toMatchObject({ live: false, error: 'Refused by the daily budget' });
    expect(t.activity.at(-1)).toMatchObject({ kind: 'error' });
  });
  it('keeps grounded refusals and expectations apart', () => {
    const t = reduce(newTurn('what do we know', 'grounded'), f('unused', { dropped: [{ span: 'x', why: 'superseded' }], expectations: [{ id: 'e', locator: 'l', title: 't', claim: 'c', p: 0.6, resolveAt: '2026-11-15' }] }));
    expect(t.unused?.dropped).toHaveLength(1);
    expect(t.unused?.expectations).toHaveLength(1);
  });
});

describe('replay', () => {
  it('rebuilds a stored answer with citations mapped by ordinal, verdicts as stored', () => {
    const [t] = replay({
      id: 't', title: 'q', messages: [
        { id: 'u', seq: 1, role: 'user', body: 'What is the fee?', mode: null, costCents: 0, createdAt: '2026-09-01T00:00:00Z', answer: null, citations: [] },
        { id: 'a', seq: 2, role: 'assistant', body: 'It is 15% [2]. That is high.', mode: 'fast', costCents: 0.3, createdAt: '2026-09-01T00:00:05Z', answer: { unanswered: ['x'] }, citations: [{ ordinal: 2, sourceUrl: 'https://s.example/f', span: '15%', title: 'Fees' }] },
      ],
    });
    expect(t?.mode).toBe('web');
    expect(t?.seq).toBe(2);
    expect(t?.spans).toEqual([{ id: 2, sourceIndex: 1, quote: '15%' }]);
    expect(t?.sources[0]).toMatchObject({ url: 'https://s.example/f', title: 'Fees', kind: 'web' });
    expect(t?.sentences.every(s => s.verdict === 'stored')).toBe(true);
    expect(t?.sentences.map(s => s.text).join('')).toBe('It is 15% [2]. That is high.');
  });
  it('a body with no markers and no citations replays as a note', () => {
    const [t] = replay({ id: 't', title: 'q', messages: [
      { id: 'u', seq: 1, role: 'user', body: 'q?', mode: null, costCents: 0, createdAt: '2026-09-01T00:00:00Z', answer: null, citations: [] },
      { id: 'a', seq: 2, role: 'assistant', body: 'Nothing quotable was found.', mode: 'deep', costCents: 0, createdAt: '2026-09-01T00:00:01Z', answer: null, citations: [] },
    ] });
    expect(t?.sentences).toEqual([]);
    expect(t?.note).toBe('Nothing quotable was found.');
  });
});
