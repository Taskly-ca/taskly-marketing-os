import { describe, expect, it } from 'vitest';
import type { Basis, EvidenceRef } from '@tmos/contracts';
import {
  ask,
  isChatScope,
  openChat,
  trimHistory,
  type BudgetPort,
  type ChatDeps,
  type ChatScope,
  type ChatSubject,
  type LlmPort,
  type LlmTurnResponse,
  type ScopedEvidence,
  type SpendOutcome,
  type SpendRequest,
} from './chat.js';

/**
 * Faithful stand-in for `assertHonest` from `@tmos/guardrails`.
 *
 * NOT the real gate. `packages/surface/package.json` does not depend on
 * `@tmos/guardrails`, so importing it here fails `tsc`. The stand-in reproduces
 * the two properties `chat.ts` relies on: it THROWS on a forbidden claim, and
 * it is negation-aware, so "we do not run background checks" — the honest
 * sentence — passes. Wiring the real gate is a package.json change.
 */
const honestyStub = (text: string, surface: string): void => {
  const banned = /\b(background check\w*|insurance|insured|guarantee\w*|vetted)\b/gi;
  const hits = [...text.matchAll(banned)].filter((m) => {
    const at = m.index ?? 0;
    return !/\b(no|not|never|without)\b/i.test(text.slice(Math.max(0, at - 40), at));
  });
  if (hits.length > 0) {
    throw new Error(
      `honesty gate blocked ${hits.length} violation(s) on ${surface}: ` +
        hits.map((h) => `"${h[0]}"`).join(', '),
    );
  }
};

const ev = (url: string, over: Partial<{ basis: Basis; key: string; span: string }> = {}) => {
  const ref: EvidenceRef = {
    signal_id: null,
    fact_id: null,
    source_url: url,
    span: over.span ?? 'the span that supports the claim',
    observed_at: '2026-08-01T00:00:00.000Z',
  };
  const e: ScopedEvidence = {
    ref,
    basis: over.basis ?? 'inferred_from_sources',
    independenceKey: over.key ?? url,
  };
  return e;
};

const subject = (over: Partial<ChatSubject> = {}): ChatSubject => ({
  scope: { kind: 'finding', findingId: 'f-1' },
  title: 'A competitor launched same-day booking across Toronto.',
  soWhat: 'Our slowest lane is now the one they advertise against.',
  basis: 'inferred_from_sources',
  evidence: [ev('https://a.example/post'), ev('https://b.example/post')],
  ...over,
});

const fakeBudget = (outcome: SpendOutcome = 'allowed') => {
  const committed: SpendRequest[] = [];
  const port: BudgetPort = {
    authorize: () => (outcome === 'allowed' ? { outcome } : { outcome, reason: 'ceiling reached' }),
    commit: (r) => {
      committed.push(r);
    },
  };
  return { port, committed };
};

const fakeLlm = (res: Partial<LlmTurnResponse>): LlmPort => ({
  estimateTurn: () => ({ tokens: 400, costCents: 2 }),
  answer: () =>
    Promise.resolve({
      text: 'They now advertise same-day slots in the west end.',
      citedUrls: ['https://a.example/post'],
      answered: true,
      tokens: 400,
      costCents: 2,
      ...res,
    }),
});

const depsOf = (llm: LlmPort, budget = fakeBudget()): ChatDeps => ({
  llm,
  budget: budget.port,
  honesty: honestyStub,
  surface: 'internal',
});

describe('ChatScope', () => {
  it('has no open variant — an unscoped chat cannot be spelled', () => {
    // @ts-expect-error — ChatScope has exactly two members and neither is
    // `open`. If this ever compiles, the blank chat box is back.
    const smuggled: ChatScope = { kind: 'open' };
    expect(isChatScope(smuggled)).toBe(false);
  });

  it('refuses at runtime when an unscoped shape is smuggled past the type', () => {
    const bad = subject({ scope: { kind: 'open' } as unknown as ChatScope });
    expect(() => openChat(bad, depsOf(fakeLlm({})))).toThrow(/unscoped chat|chat scope/i);
  });

  it('refuses a scope with an empty id', () => {
    const bad = subject({ scope: { kind: 'entity', entityId: '' } });
    expect(() => openChat(bad, depsOf(fakeLlm({})))).toThrow(/chat scope/i);
  });
});

describe('openChat', () => {
  it('pre-seeds the object, its evidence and its basis, deterministically', () => {
    const deps = depsOf(fakeLlm({}));
    const a = openChat(subject(), deps);
    const b = openChat(subject(), deps);
    expect(a.seed.text).toBe(b.seed.text);
    expect(a.seed.text).toContain('A competitor launched same-day booking');
    expect(a.seed.text).toContain('https://a.example/post');
    expect(a.seed.allowedUrls).toEqual(['https://a.example/post', 'https://b.example/post']);
    expect(a.history).toEqual([]);
  });

  it('refuses an object with no evidence — it could only guess', () => {
    expect(() => openChat(subject({ evidence: [] }), depsOf(fakeLlm({})))).toThrow(/evidence/i);
  });

  it('refuses a no-op honesty gate (canary)', () => {
    const deps: ChatDeps = { ...depsOf(fakeLlm({})), honesty: () => {} };
    expect(() => openChat(subject(), deps)).toThrow(/honesty gate/i);
  });
});

describe('ask', () => {
  it('refuses an answer that cites a URL outside the scope', async () => {
    const deps = depsOf(fakeLlm({ citedUrls: ['https://elsewhere.example/leak'] }));
    const session = openChat(subject(), deps);
    const { answer, session: after } = await ask(session, 'Where else did they launch?', deps);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('citation_outside_scope');
    expect(answer.detail).toContain('https://elsewhere.example/leak');
    expect(after.history).toEqual([]);
  });

  it('returns cannot_answer_in_scope with what would be needed, not a guess', async () => {
    const guess = 'Probably about 40% of their bookings.';
    const deps = depsOf(
      fakeLlm({ answered: false, text: guess, citedUrls: [], needed: 'their published volumes' }),
    );
    const session = openChat(subject(), deps);
    const { answer } = await ask(session, 'What share of their bookings is same-day?', deps);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('cannot_answer_in_scope');
    expect(answer.needed).toBe('their published volumes');
    expect(JSON.stringify(answer)).not.toContain(guess);
  });

  it('treats an uncited answer as unanswerable rather than shipping it', async () => {
    const deps = depsOf(fakeLlm({ citedUrls: [] }));
    const session = openChat(subject(), deps);
    const { answer } = await ask(session, 'What changed?', deps);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('cannot_answer_in_scope');
  });

  it('carries a basis rendered from what it drew on, taking the weakest', async () => {
    const subj = subject({
      basis: 'governed_query',
      evidence: [
        ev('https://a.example/post', { basis: 'governed_query', key: 'chain-1' }),
        ev('https://b.example/post', { basis: 'exploratory_unverified', key: 'chain-1' }),
      ],
    });
    const deps = depsOf(
      fakeLlm({ citedUrls: ['https://a.example/post', 'https://b.example/post'] }),
    );
    const { answer } = await ask(openChat(subj, deps), 'What changed?', deps);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.basis).toBe('exploratory_unverified');
    expect(answer.quotable).toBe(false);
    expect(answer.basisLabel).toBe('Exploratory');
  });

  it('counts independent sources after copy-chain collapse, not cited URLs', async () => {
    const subj = subject({
      evidence: [
        ev('https://a.example/post', { key: 'press-release-7' }),
        ev('https://b.example/post', { key: 'press-release-7' }),
      ],
    });
    const deps = depsOf(
      fakeLlm({ citedUrls: ['https://a.example/post', 'https://b.example/post'] }),
    );
    const { answer } = await ask(openChat(subj, deps), 'What changed?', deps);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.basisLabel).toBe('Inferred from 1 independent source');
  });

  it('passes honest generated text', async () => {
    const deps = depsOf(fakeLlm({ text: 'They do not run background checks either.' }));
    const { answer } = await ask(openChat(subject(), deps), 'Do they screen?', deps);
    expect(answer.ok).toBe(true);
  });

  it('refuses a forbidden claim loudly, surfacing the gate message', async () => {
    const deps = depsOf(fakeLlm({ text: 'Every Tasker carries $2M liability insurance.' }));
    const { answer } = await ask(openChat(subject(), deps), 'Are we covered?', deps);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('honesty');
    expect(answer.detail).toContain('honesty gate blocked');
  });

  it('refuses text that renders confidence as a number', async () => {
    const deps = depsOf(fakeLlm({ text: 'They launched same-day booking (92% confidence).' }));
    const { answer } = await ask(openChat(subject(), deps), 'Did they launch?', deps);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('confidence_number');
  });

  it('surfaces blocked_daily_cost instead of swallowing it', async () => {
    const budget = fakeBudget('blocked_daily_cost');
    const deps = depsOf(fakeLlm({}), budget);
    const { answer } = await ask(openChat(subject(), deps), 'What changed?', deps);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.code).toBe('budget_blocked');
    expect(answer.budgetOutcome).toBe('blocked_daily_cost');
    expect(budget.committed).toEqual([]);
  });

  it('commits spend even when the answer is then refused', async () => {
    const budget = fakeBudget();
    const deps = depsOf(fakeLlm({ citedUrls: ['https://elsewhere.example/leak'] }), budget);
    await ask(openChat(subject(), deps), 'What changed?', deps);
    expect(budget.committed).toHaveLength(1);
    expect(budget.committed[0]?.estimatedCostCents).toBe(2);
  });
});

describe('history', () => {
  it('drops the oldest turns and never the seed', async () => {
    const deps: ChatDeps = { ...depsOf(fakeLlm({})), maxHistoryTurns: 4 };
    let session = openChat(subject(), deps);
    const seedText = session.seed.text;
    for (let i = 0; i < 8; i += 1) {
      const r = await ask(session, `question ${i}`, deps);
      session = r.session;
    }
    expect(session.history).toHaveLength(4);
    expect(session.history[0]?.text).toBe('question 6');
    // The seed is not IN the history array, so trimming structurally cannot
    // reach it — this asserts the property the structure already guarantees.
    expect(session.seed.text).toBe(seedText);
    expect(session.seed.allowedUrls).toHaveLength(2);
  });

  it('trimHistory keeps the newest turns', () => {
    const turns = [0, 1, 2].map((i) => ({ role: 'user' as const, text: `t${i}`, citedUrls: [] }));
    expect(trimHistory(turns, 2).map((t) => t.text)).toEqual(['t1', 't2']);
    expect(trimHistory(turns, 9)).toEqual(turns);
  });
});
