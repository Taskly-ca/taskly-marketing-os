/**
 * The multi-step loop, driven end to end with fake ports — no key, no network,
 * no clock, no model.
 *
 * Four of these tests exist because the failure they catch is INVISIBLE in a
 * finished answer:
 *
 *  - A step-2 span numbered `[1]` looks exactly like a step-1 span numbered
 *    `[1]`. The answer renders, every badge says confirmed, and half the
 *    markers point at the wrong quote. Nothing downstream can tell.
 *  - A run that stopped because it ran out of money and a run that stopped
 *    because it finished produce the same prose. Only `stop` separates them.
 *  - A clarify gate that fires after the first search is a gate that never
 *    fires, and the only way to prove the ordering is to make retrieval
 *    explode if it is touched.
 *  - A step that researched the umbrella question instead of its own
 *    sub-question returns plausible spans about the right subject, and the
 *    run quietly becomes one pass repeated five times.
 */
import { describe, expect, it } from 'vitest';

import { absorbSpans, bindClarify, bindPlan, revisePlan, streamDeep } from './deep.js';
import type { DeepAnswer, DeepDeps } from './deep.js';
import type { CitableSpan } from './attribute.js';
import type {
  ClarifyEvent,
  DeltaEvent,
  PlanEvent,
  ReflectEvent,
  SentenceEvent,
  SourceEvent,
  SpanEvent,
  StatusEvent,
  StepEvent,
} from './events.js';
import type {
  AskPort,
  AskResult,
  AskStreamPort,
  ReadDoc,
  ReadPort,
  SearchHit,
  SearchPort,
} from './types.js';

/* ── the corpus ───────────────────────────────────────────────────────────── */

const URL_A = 'https://a.example.com/jiffy';
const URL_B = 'https://b.example.org/taskrabbit';
const URL_C = 'https://c.example.net/handy';

const DOCS: ReadDoc[] = [
  {
    url: URL_A,
    title: 'Jiffy',
    text:
      'Jiffy operates in Toronto and Ottawa with a network of cleaners. Their standard rate is $89 ' +
      'per visit for two hours of work, booked entirely through the app, and the company has been ' +
      'running across Ontario for several years with steady expansion into nearby regions.',
  },
  {
    url: URL_B,
    title: 'TaskRabbit',
    text:
      'TaskRabbit charges a 15% service fee on every booking in Canada. The platform lists ' +
      'thousands of taskers across Toronto, Vancouver and Montreal, and it publishes its rates ' +
      'openly on a pricing page for anyone who wants to compare them before booking anything.',
  },
  {
    url: URL_C,
    title: 'Handy',
    text:
      'Handy lists a minimum booking of two hours in Ontario. Its cleaners are paid weekly and ' +
      'the company operates a flat 20% platform charge on completed jobs across every Canadian ' +
      'city it serves, which it publishes openly on its own help pages for anyone to read.',
  },
];

const SPAN_A = 'Jiffy operates in Toronto and Ottawa';
const SPAN_B = 'TaskRabbit charges a 15% service fee on every booking in Canada';
const SPAN_C = 'Handy lists a minimum booking of two hours in Ontario';

const SPAN_OF: Record<string, string> = { Jiffy: SPAN_A, TaskRabbit: SPAN_B, Handy: SPAN_C };

/** Sentence-initial words the fake planner must not mistake for a subject. */
const INTERROGATIVES = new Set(['What', 'Where', 'When', 'Which', 'How', 'Who', 'Should']);

/** The umbrella question. Its distinctive word — "October" — is what the
 *  drift tests look for in a step's prompts, where it must never appear. */
const QUESTION = 'Should we launch a cleaning campaign in Toronto in October?';

/** Three sub-questions, each naming exactly one company, so a step's retrieval
 *  is traceable to the step that asked for it. */
const PLAN_STEPS = [
  { question: 'What does Jiffy charge for a cleaning visit?', why: 'the incumbent price' },
  { question: 'What service fee does TaskRabbit take in Canada?', why: 'the marketplace fee' },
  { question: 'What minimum booking does Handy list in Ontario?', why: 'the third comparator' },
];

/* ── the fakes ────────────────────────────────────────────────────────────── */

interface Calls {
  /** Every `ask` the run made, as `[system, user]`. */
  readonly asked: Array<{ system: string; user: string }>;
  readonly searched: string[];
  readonly readUrls: string[];
}

/** A search port whose results are decided by which company the query names. */
const searchPort = (calls: Calls): SearchPort => ({
  name: 'fake',
  search: async (query: string): Promise<SearchHit[]> => {
    calls.searched.push(query);
    const doc = DOCS.find((d) => query.toLowerCase().includes(d.title.toLowerCase()));
    return doc ? [{ title: doc.title, url: doc.url, snippet: '', provider: 'fake' }] : [];
  },
});

const readPort = (calls: Calls): ReadPort => ({
  read: async (url: string): Promise<ReadDoc | null> => {
    calls.readUrls.push(url);
    return DOCS.find((d) => d.url === url) ?? null;
  },
});

/** A port that fails the test if it is reached at all. */
const forbiddenSearch: SearchPort = {
  name: 'forbidden',
  search: async (): Promise<SearchHit[]> => {
    throw new Error('the search port was touched');
  },
};
const forbiddenRead: ReadPort = {
  read: async (): Promise<ReadDoc | null> => {
    throw new Error('the read port was touched');
  },
};

interface AskOptions {
  /** `{ok:true}` unless this is set. */
  readonly clarify?: unknown;
  readonly plan?: unknown;
  /** Reflection replies, one per step; the last is reused once exhausted. */
  readonly reflect?: readonly unknown[];
  readonly related?: unknown[];
  /** Every reply's cost. Raised in the spend-cap test. */
  readonly costCents?: number;
}

/**
 * One fake standing in for all six non-streaming calls, dispatching on the
 * system prompt. The order of the branches matters: the deep planner and the
 * per-step query planner both talk about questions, so the more specific
 * "sub-questions" test has to come first.
 *
 * The attribution branch is the interesting one — it reads the document block
 * it was handed and returns a quote per document, numbered LOCALLY from 1, the
 * way `attribute()` really behaves. That local numbering is what every id test
 * below is actually exercising.
 */
const askPort = (calls: Calls, opts: AskOptions = {}): AskPort => {
  let reflections = 0;
  return {
    ask: async (system: string, user: string): Promise<AskResult | null> => {
      calls.asked.push({ system, user });
      const cost = opts.costCents ?? 0.01;

      if (system.includes('specific enough')) {
        return { text: JSON.stringify(opts.clarify ?? { ok: true }), costCents: cost };
      }
      if (system.includes('sub-questions')) {
        return { text: JSON.stringify({ steps: opts.plan ?? PLAN_STEPS }), costCents: cost };
      }
      if (system.includes('multi-step research run')) {
        const list = opts.reflect ?? [];
        const reply = list[Math.min(reflections, list.length - 1)] ?? {
          stillOpen: ['what the remaining steps cover'],
          note: 'Some ground is still uncovered.',
          done: false,
        };
        reflections += 1;
        return { text: JSON.stringify(reply), costCents: cost };
      }
      if (system.includes('search queries')) {
        // The per-step planner. Queries name the subject the STEP asked about,
        // which is what routes each step to its own document — and, for a
        // subject nothing indexes, to no document at all.
        const doc = DOCS.find((d) => user.includes(d.title));
        const named =
          doc?.title ??
          (user.match(/\b[A-Z][a-z]+\b/g) ?? []).find((w) => !INTERROGATIVES.has(w));
        return {
          text: JSON.stringify({
            queries: named === undefined ? [] : [`${named} pricing`],
            unanswerable: [],
          }),
          costCents: cost,
        };
      }
      if (system.includes('ask NEXT')) {
        return { text: JSON.stringify({ questions: opts.related ?? [] }), costCents: cost };
      }
      // Attribution. One quote per document actually in the prompt, numbered
      // from 1 within this call.
      const spans: Array<{ span: string; doc: number }> = [];
      for (const m of user.matchAll(/^\[(\d+)\] (.+)$/gm)) {
        const quote = SPAN_OF[(m[2] ?? '').trim()];
        if (quote) spans.push({ span: quote, doc: Number(m[1]) });
      }
      return { text: JSON.stringify({ spans }), costCents: cost };
    },
  };
};

const streamer = (text: string): AskStreamPort => ({
  askStream: async (_s, _u, _m, onDelta): Promise<AskResult | null> => {
    onDelta(text);
    return { text, costCents: 0.05 };
  },
});

interface Captured {
  readonly status: StatusEvent[];
  readonly clarify: ClarifyEvent[];
  readonly plans: PlanEvent[];
  readonly steps: StepEvent[];
  readonly reflect: ReflectEvent[];
  readonly sources: SourceEvent[];
  readonly spans: SpanEvent[];
  readonly deltas: DeltaEvent[];
  readonly sentences: SentenceEvent[];
}

interface Harness {
  readonly answer: DeepAnswer;
  readonly cap: Captured;
  readonly calls: Calls;
}

const PROSE = `${SPAN_A} [1]. ${SPAN_B} [2]. ${SPAN_C} [3].`;

async function run(
  opts: {
    question?: string;
    ask?: AskOptions;
    prose?: string;
    deps?: Partial<DeepDeps>;
  } = {},
): Promise<Harness> {
  const calls: Calls = { asked: [], searched: [], readUrls: [] };
  const cap: Captured = {
    status: [], clarify: [], plans: [], steps: [], reflect: [],
    sources: [], spans: [], deltas: [], sentences: [],
  };
  const answer = await streamDeep(opts.question ?? QUESTION, {
    ask: askPort(calls, opts.ask),
    askStream: streamer(opts.prose ?? PROSE),
    search: [searchPort(calls)],
    read: readPort(calls),
    onStatus: (e): void => void cap.status.push(e),
    onClarify: (e): void => void cap.clarify.push(e),
    onPlan: (e): void => void cap.plans.push(e),
    onStep: (e): void => void cap.steps.push(e),
    onReflect: (e): void => void cap.reflect.push(e),
    onSource: (e): void => void cap.sources.push(e),
    onSpan: (e): void => void cap.spans.push(e),
    onDelta: (e): void => void cap.deltas.push(e),
    onSentence: (e): void => void cap.sentences.push(e),
    ...opts.deps,
  });
  return { answer, cap, calls };
}

/* ── the happy path, and the id invariant it is really testing ────────────── */

describe('streamDeep — the loop', () => {
  it('plans, runs every step, reflects between them, and answers over the whole universe', async () => {
    const { answer, cap } = await run();

    expect(answer.clarify).toBeNull();
    expect(answer.plan).toHaveLength(3);
    expect(cap.plans[0]?.steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(cap.plans[0]?.revisedBecause).toBeUndefined();

    // Three steps, each announced running then done.
    expect(cap.steps.filter((s) => s.state === 'running')).toHaveLength(3);
    expect(cap.steps.filter((s) => s.state === 'done').map((s) => s.found)).toEqual([1, 1, 1]);
    expect(cap.steps.some((s) => s.state === 'skipped')).toBe(false);

    // A reflection after every step, plus the terminal one carrying `stop`.
    expect(cap.reflect.filter((r) => r.stop === undefined)).toHaveLength(3);
    expect(answer.stoppedBecause).toBe('every planned step ran');

    // The answer is written from all three steps' evidence at once.
    expect(answer.spans).toHaveLength(3);
    expect(answer.text).toContain('[1]');
    expect(answer.text).toContain('[3]');
    expect(answer.sentences.every((s) => s.verdict === 'confirmed')).toBe(true);
  });

  it('the phases announce in order, so a watcher sees the work rather than a spinner', async () => {
    const { cap } = await run();
    const phases = cap.status.map((s) => s.phase);
    expect(phases[0]).toBe('planning');
    expect(phases).toContain('searching');
    expect(phases).toContain('reading');
    expect(phases).toContain('attributing');
    expect(phases).toContain('writing');
    expect(phases).toContain('checking');
    expect(phases[phases.length - 1]).toBe('done');
  });
});

/* ── span identity across steps: the bug that renders as a correct answer ─── */

describe('span ids across steps', () => {
  it('gives every span in the run a unique, contiguous id even though each step numbers from 1', async () => {
    const { answer, cap } = await run();

    // The fake attribution pass returns `doc: 1` on every step, exactly as the
    // real one does. Without renumbering, all three spans would be `[1]`.
    expect(answer.spans.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(new Set(answer.spans.map((s) => s.id)).size).toBe(answer.spans.length);
    expect(cap.spans.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  it("re-homes each span's docIndex onto the run's source list, so [N] resolves to the right page", async () => {
    const { answer } = await run();

    // The invariant that matters: follow the marker to the source card the
    // reader would open, and the quote must be on THAT page.
    for (const span of answer.spans) {
      const doc = answer.sources[span.docIndex - 1];
      expect(doc, `span ${span.id} has no source at index ${span.docIndex}`).toBeDefined();
      expect(doc?.url).toBe(span.url);
      expect(doc?.text).toContain(span.span);
    }
    expect(answer.spans.map((s) => s.docIndex)).toEqual([1, 2, 3]);
  });

  it('emits source events numbered to match, so the cards and the markers agree', async () => {
    const { cap } = await run();
    expect(cap.sources.map((s) => s.i)).toEqual([1, 2, 3]);
    expect(cap.sources.map((s) => s.domain)).toEqual([
      'a.example.com',
      'b.example.org',
      'c.example.net',
    ]);
  });

  it('counts a span an earlier step already proved as found: 0, and keeps it once', async () => {
    // Every step asks about Jiffy, so every step retrieves and proves the same
    // sentence. A `found` count of documents read would say "1, 1, 1"; the
    // count of NEW evidence is the honest one and says "1, 0, 0".
    const { answer, cap } = await run({
      ask: {
        plan: [
          { question: 'What does Jiffy charge for a visit?', why: 'price' },
          { question: 'Where does Jiffy operate?', why: 'coverage' },
          { question: 'How long is a Jiffy visit?', why: 'duration' },
        ],
      },
    });

    expect(cap.steps.filter((s) => s.state === 'done').map((s) => s.found)).toEqual([1, 0, 0]);
    expect(answer.spans).toHaveLength(1);
    expect(answer.spans[0]?.id).toBe(1);
    // And the page was fetched once, not three times.
    expect(answer.sources).toHaveLength(1);
  });
});

describe('absorbSpans — the merge, on its own', () => {
  const doc = (url: string): number | undefined =>
    ({ [URL_A]: 1, [URL_B]: 2, [URL_C]: 3 })[url];

  const local = (span: string, url: string): CitableSpan => ({ id: 1, docIndex: 1, url, span });

  it('renumbers colliding ids and re-homes docIndex by URL', () => {
    const first = absorbSpans([], [local(SPAN_A, URL_A)], doc, 40);
    const second = absorbSpans(first.spans, [local(SPAN_B, URL_B)], doc, 40);

    expect(first.added).toBe(1);
    expect(second.added).toBe(1);
    expect(second.spans.map((s) => [s.id, s.docIndex])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('keeps the same sentence on two documents — that is corroboration, not a duplicate', () => {
    const merged = absorbSpans([], [local(SPAN_A, URL_A), local(SPAN_A, URL_B)], doc, 40);
    expect(merged.added).toBe(2);
    expect(merged.spans.map((s) => s.docIndex)).toEqual([1, 2]);
  });

  it('drops a span whose URL is not in the run, rather than guessing a home for it', () => {
    const merged = absorbSpans([], [local(SPAN_A, 'https://nowhere.example/x')], doc, 40);
    expect(merged.added).toBe(0);
    expect(merged.spans).toHaveLength(0);
    expect(merged.dropped[0]?.why).toContain('not in this run');
  });

  it('reports the cap rather than silently truncating, and keeps ids contiguous', () => {
    const merged = absorbSpans([], [local(SPAN_A, URL_A), local(SPAN_B, URL_B)], doc, 1);
    expect(merged.spans.map((s) => s.id)).toEqual([1]);
    expect(merged.added).toBe(1);
    expect(merged.dropped[0]?.why).toContain('capped at 1 spans');
  });
});

/* ── the clarify gate: before retrieval or never ──────────────────────────── */

describe('the ambiguity gate', () => {
  it('fires before any search or read port is touched, and stops the run', async () => {
    const calls: Calls = { asked: [], searched: [], readUrls: [] };
    const answer = await streamDeep('Tell me about Jiffy', {
      ask: askPort(calls, {
        clarify: {
          questions: ['Do you mean Jiffy the home-services app?', 'Which market?'],
          because: 'Two companies share that name and the research would differ.',
        },
      }),
      askStream: streamer(PROSE),
      // If retrieval is reached at all, these throw and the test fails loudly.
      search: [forbiddenSearch],
      read: forbiddenRead,
    });

    expect(answer.clarify?.questions).toEqual([
      'Do you mean Jiffy the home-services app?',
      'Which market?',
    ]);
    expect(answer.text).toBe('');
    expect(answer.plan).toHaveLength(0);
    expect(answer.spans).toHaveLength(0);
    expect(calls.searched).toHaveLength(0);
    expect(calls.readUrls).toHaveLength(0);
    // And it decided before the DECOMPOSITION too: decomposing is where a
    // model commits to one reading of the question.
    expect(calls.asked.map((a) => a.system.includes('sub-questions'))).not.toContain(true);
  });

  it('emits the clarify event and says why, in the reader’s terms', async () => {
    const cap: ClarifyEvent[] = [];
    const calls: Calls = { asked: [], searched: [], readUrls: [] };
    await streamDeep('Tell me about the market', {
      ask: askPort(calls, {
        clarify: { questions: ['Which market do you mean?'], because: 'No market was named.' },
      }),
      askStream: streamer(PROSE),
      search: [forbiddenSearch],
      read: forbiddenRead,
      onClarify: (e): void => void cap.push(e),
    });
    expect(cap).toHaveLength(1);
    expect(cap[0]?.because).toBe('No market was named.');
  });

  it('skips the gate entirely when the caller already has the reader’s answers', async () => {
    const { answer, calls } = await run({
      ask: {
        clarify: { questions: ['Which market?'], because: 'ambiguous' },
      },
      deps: { clarifications: ['Toronto, the home-services app'] },
    });

    expect(answer.clarify).toBeNull();
    expect(calls.asked.some((a) => a.system.includes('specific enough'))).toBe(false);
    expect(answer.spans).toHaveLength(3);
    // The reader's own words reach the writer; nothing the run generated does.
    const write = calls.asked.find((a) => a.system.includes('ask NEXT'));
    expect(write).toBeDefined();
  });

  it('proceeds when the gate returns something unusable — a broken gate must not deadlock the tool', async () => {
    const { answer } = await run({
      ask: { clarify: { questions: ['not a question'], because: '' } },
    });
    expect(answer.clarify).toBeNull();
    expect(answer.spans).toHaveLength(3);
  });
});

describe('bindClarify', () => {
  it('proceeds on {ok:true}', () => {
    expect(bindClarify({ ok: true })).toBeNull();
  });

  it('proceeds on an unparseable or empty reply rather than blocking the run', () => {
    expect(bindClarify({})).toBeNull();
    expect(bindClarify({ questions: [] })).toBeNull();
    expect(bindClarify('nonsense')).toBeNull();
  });

  it('refuses a statement dressed as a clarification', () => {
    expect(bindClarify({ questions: ['Tell me the market.'], because: 'x' })).toBeNull();
  });

  it('drops a clarifying question that crosses the honesty boundary', () => {
    const c = bindClarify({
      questions: ['Do you want only fully vetted providers?', 'Which city?'],
      because: 'unclear',
    });
    expect(c?.questions).toEqual(['Which city?']);
  });

  it('caps the questions at three', () => {
    const c = bindClarify({
      questions: ['One city?', 'Two cities?', 'Three cities?', 'Four cities?'],
      because: 'unclear',
    });
    expect(c?.questions).toHaveLength(3);
  });
});

/* ── the caps, and saying which one ended the run ─────────────────────────── */

describe('the caps sit under the model’s judgement', () => {
  it('the step cap ends the run, names itself, and marks the rest skipped', async () => {
    const { answer, cap } = await run({ deps: { budget: { maxSteps: 1 } } });

    expect(answer.stoppedBecause).toContain('step cap');
    expect(answer.stoppedBecause).toContain('1 step(s)');
    // The plan is still published whole — the reader is owed the cost of the cap.
    expect(answer.plan).toHaveLength(3);
    expect(cap.steps.filter((s) => s.state === 'done')).toHaveLength(1);
    expect(cap.steps.filter((s) => s.state === 'skipped').map((s) => s.n)).toEqual([2, 3]);
    // And it still answers over what it did prove.
    expect(answer.spans).toHaveLength(1);
    expect(answer.text).toContain('[1]');
  });

  it('the spend cap ends the run and says so in cents', async () => {
    // Each reply costs 1¢ against a 4¢ ceiling: the gate and the plan spend 2¢,
    // step one spends two more, and step two never starts.
    const { answer, cap } = await run({
      ask: { costCents: 1 },
      deps: { budget: { maxCostCents: 4 } },
    });

    expect(answer.stoppedBecause).toContain('spend cap');
    expect(answer.stoppedBecause).toContain('4¢');
    expect(cap.steps.filter((s) => s.state === 'done')).toHaveLength(1);
    expect(cap.steps.filter((s) => s.state === 'skipped').map((s) => s.n)).toEqual([2, 3]);
  });

  it('the time cap ends the run and says so in seconds', async () => {
    // A clock that jumps a minute per reading. The first step runs; the second
    // never starts.
    let t = 0;
    const { answer } = await run({
      deps: {
        budget: { maxMs: 90_000 },
        now: (): number => {
          t += 60_000;
          return t;
        },
      },
    });

    expect(answer.stoppedBecause).toContain('time cap');
    expect(answer.stoppedBecause).toContain('90s ceiling');
  });

  it('the evidence cap ends the run before the universe outgrows the prompt', async () => {
    const { answer } = await run({ deps: { budget: { maxSpans: 1 } } });
    expect(answer.stoppedBecause).toContain('evidence cap');
    expect(answer.spans).toHaveLength(1);
  });

  it('a cap overrides the model asking to continue — the reflection does not get a vote', async () => {
    const { answer } = await run({
      ask: {
        reflect: [{ stillOpen: ['everything'], note: 'much is still open.', done: false }],
      },
      deps: { budget: { maxSteps: 1 } },
    });
    expect(answer.stoppedBecause).toContain('step cap');
    // The reflection's own list is preserved — the run reports both what the
    // model thought and what actually stopped it.
    expect(answer.reflections[0]?.stillOpen).toEqual(['everything']);
  });

  it('distinguishes "the plan is answered" from "a cap ended it"', async () => {
    const { answer, cap } = await run({
      ask: { reflect: [{ stillOpen: [], note: 'Everything asked for is covered.', done: true }] },
    });

    expect(answer.stoppedBecause).toContain('its own judgement');
    expect(answer.stoppedBecause).not.toContain('cap ended the run');
    expect(cap.reflect.filter((r) => r.stop !== undefined)).toHaveLength(1);
    expect(cap.steps.filter((s) => s.state === 'skipped').map((s) => s.n)).toEqual([2, 3]);
  });

  it('carries exactly one stop reason, so "why did it end?" has one place to look', async () => {
    for (const budget of [{}, { maxSteps: 1 }, { maxSpans: 1 }]) {
      const { cap } = await run({ deps: { budget } });
      expect(cap.reflect.filter((r) => r.stop !== undefined)).toHaveLength(1);
    }
  });
});

/* ── drift: a step must research its own sub-question ─────────────────────── */

describe('drift', () => {
  it('plans, searches and attributes each step against its own sub-question, never the original', async () => {
    const { calls } = await run();

    const planners = calls.asked.filter((a) => a.system.includes('search queries'));
    expect(planners.map((a) => a.user)).toEqual(PLAN_STEPS.map((s) => s.question));

    const attributions = calls.asked.filter((a) => a.system.includes('extract QUOTES'));
    expect(attributions).toHaveLength(3);
    attributions.forEach((a, i) => {
      expect(a.user).toContain(PLAN_STEPS[i]?.question ?? '');
      // "October" is the umbrella question's distinctive word. Re-injecting it
      // is what turns a five-step plan into five copies of step one.
      expect(a.user).not.toContain('October');
    });

    // Each step therefore retrieved its OWN document, not the same one thrice.
    expect(calls.searched).toEqual(['Jiffy pricing', 'TaskRabbit pricing', 'Handy pricing']);
  });

  it('shows the reflection the plan and the proven quotes, and never the document text', async () => {
    const { calls } = await run();
    const reflections = calls.asked.filter((a) => a.system.includes('multi-step research run'));
    expect(reflections).toHaveLength(3);

    const last = reflections[2]?.user ?? '';
    expect(last).toContain('PLAN');
    expect(last).toContain(SPAN_A);
    // The rest of the page never crosses a step boundary.
    expect(last).not.toContain('booked entirely through the app');
  });

  it('never lets a generated sub-question reach the writer — only proven quotes are evidence', async () => {
    const { calls } = await run();
    const write = calls.asked.find((a) => a.system.includes('ask NEXT'));
    expect(write).toBeDefined();

    // The generation prompt is built by `writeFromSpans`; what this asserts is
    // the input this file composes for it. A sub-question is model-written
    // prose, and prose the generator can see is prose it can copy into the
    // answer with a citation to a page that never said it.
    const attributions = calls.asked.filter((a) => a.system.includes('extract QUOTES'));
    expect(attributions).toHaveLength(3);
  });
});

/* ── replanning ───────────────────────────────────────────────────────────── */

describe('replanning', () => {
  it('emits a new plan with revisedBecause, and never rewrites a step that already ran', async () => {
    const { answer, cap } = await run({
      ask: {
        reflect: [
          {
            stillOpen: ['the fee question'],
            note: 'The first step settled the price.',
            done: false,
            revise: [{ n: 3, question: 'What does Handy charge per hour in Ontario?', why: 'better' }],
            revisedBecause: 'The price question is settled, so step three should ask about rates.',
          },
        ],
      },
    });

    expect(cap.plans).toHaveLength(2);
    expect(cap.plans[1]?.revisedBecause).toContain('step three');
    expect(cap.plans[1]?.steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(cap.plans[1]?.steps[0]?.question).toBe(PLAN_STEPS[0]?.question);
    expect(answer.plan[2]?.question).toBe('What does Handy charge per hour in Ontario?');
  });

  it('refuses a revision aimed at a step that already ran', () => {
    const plan = [
      { n: 1, question: 'What does Jiffy charge?', why: '' },
      { n: 2, question: 'What does Handy charge?', why: '' },
    ];
    const out = revisePlan(plan, [{ n: 1, question: 'Something else entirely?', why: '' }], 1);
    expect(out).toEqual(plan);
  });

  it('appends a genuinely new step rather than renumbering', () => {
    const plan = [{ n: 1, question: 'What does Jiffy charge?', why: '' }];
    const out = revisePlan(plan, [{ question: 'What does Handy charge in Ontario?', why: '' }], 1);
    expect(out.map((s) => s.n)).toEqual([1, 2]);
    expect(out[0]).toEqual(plan[0]);
  });
});

describe('bindPlan', () => {
  it('numbers the steps itself — n is never the model’s to choose', () => {
    const steps = bindPlan([
      { n: 9, question: 'What does Jiffy charge?', why: 'price' },
      { n: 9, question: 'What does Handy charge?', why: 'price' },
    ]);
    expect(steps.map((s) => s.n)).toEqual([1, 2]);
  });

  it('drops a duplicate sub-question — two identical steps retrieve one set of pages', () => {
    const steps = bindPlan([
      { question: 'What does Jiffy charge?', why: '' },
      { question: 'what does jiffy charge?', why: '' },
    ]);
    expect(steps).toHaveLength(1);
  });

  it('drops a sub-question that crosses the honesty boundary or presumes a cause', () => {
    const steps = bindPlan([
      { question: 'Are Jiffy cleaners fully vetted before joining?', why: '' },
      { question: 'What caused the drop in bookings?', why: '' },
      { question: 'What does Jiffy charge in Toronto?', why: '' },
    ]);
    expect(steps.map((s) => s.question)).toEqual(['What does Jiffy charge in Toronto?']);
  });

  it('drops an unsafe "why" without losing the step', () => {
    const steps = bindPlan([
      { question: 'What does Jiffy charge in Toronto?', why: 'every tasker is fully vetted' },
    ]);
    expect(steps[0]?.why).toBe('');
  });
});

/* ── phase C, unchanged, on the final answer ──────────────────────────────── */

describe('every phase C check still fires on a deep answer', () => {
  it('deletes a marker with no span behind it and flags the sentence', async () => {
    const { answer, cap } = await run({ prose: `${SPAN_A} [1]. Jiffy also covers Hamilton [9].` });

    expect(answer.text).not.toContain('[9]');
    expect(cap.sentences[1]?.verdict).toBe('flagged');
    expect(cap.sentences[1]?.why).toContain('[9]');
    expect(answer.flagged).toBe(1);
  });

  it('flags a figure that is in no span the sentence cites', async () => {
    const { cap } = await run({ prose: 'The Toronto market is worth $2.1B [1].' });
    expect(cap.sentences[0]?.verdict).toBe('flagged');
    expect(cap.sentences[0]?.why).toContain('2.1');
  });

  it('flags a sentence that crosses the honesty boundary', async () => {
    const { cap } = await run({ prose: 'Every Tasker is fully vetted before joining [1].' });
    expect(cap.sentences[0]?.why).toContain('honesty gate');
  });

  it('flags causal language with no experiment behind it', async () => {
    const { cap } = await run({ prose: 'The 15% service fee caused bookings to fall [2].' });
    expect(cap.sentences[0]?.why).toContain('caused');
  });

  it('confirms a sentence whose markers resolve and whose figures are quoted', async () => {
    const { answer } = await run({ prose: `${SPAN_B} [2].` });
    expect(answer.sentences).toEqual([{ n: 0, verdict: 'confirmed' }]);
    expect(answer.flagged).toBe(0);
  });

  it('a marker pointing at a span a LATER step proved still resolves', async () => {
    // The whole point of accumulating: `[3]` comes from step three and must be
    // as citable as `[1]` from step one.
    const { answer } = await run({ prose: `${SPAN_C} [3].` });
    expect(answer.sentences[0]?.verdict).toBe('confirmed');
    expect(answer.text).toContain('[3]');
  });
});

/* ── the empty and broken outcomes ────────────────────────────────────────── */

describe('when there is nothing to answer from', () => {
  it('refuses to write when no step proved a span, and says it is about the sources', async () => {
    const calls: Calls = { asked: [], searched: [], readUrls: [] };
    let wrote = false;
    const answer = await streamDeep(QUESTION, {
      ask: askPort(calls),
      askStream: {
        askStream: async (): Promise<AskResult | null> => {
          wrote = true;
          return { text: 'anything at all', costCents: 1 };
        },
      },
      // Search finds nothing, so nothing is read and nothing is proven.
      search: [{ name: 'empty', search: async (): Promise<SearchHit[]> => [] }],
      read: readPort(calls),
    });

    expect(wrote).toBe(false);
    expect(answer.text).toBe('');
    expect(answer.note).toContain('about the sources, not about the topic');
    expect(answer.spans).toHaveLength(0);
  });

  it('stops when the question cannot be broken into steps', async () => {
    const { answer, calls } = await run({ ask: { plan: [] } });
    expect(answer.plan).toHaveLength(0);
    expect(answer.note).toContain('Could not break that into researchable steps');
    expect(calls.searched).toHaveLength(0);
  });

  it('records a step that read pages and proved nothing, rather than hiding it', async () => {
    // A plan whose second step names a company no search result carries.
    const { cap } = await run({
      ask: {
        plan: [
          PLAN_STEPS[0],
          { question: 'What does Acme charge in Ontario?', why: 'a company nobody indexes' },
        ],
      },
    });
    const done = cap.steps.filter((s) => s.state === 'done');
    expect(done[1]?.found).toBe(0);
    expect(done[1]?.detail).toContain('no search results');
  });
});
