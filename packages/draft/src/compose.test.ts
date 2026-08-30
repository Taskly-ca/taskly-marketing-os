/**
 * The join, and the one case that matters most: nothing to say.
 *
 * A system that always produces five recommendations carries no information in
 * producing five. The quiet path has to be real, and it has to be cheaper than
 * the loud one — hence: no model call at all when nothing has been observed.
 */
import { describe, expect, it } from 'vitest';

import { buildEvidence, composeDraft } from './compose.js';
import type { AskPort, DraftInputs } from './index.js';

const NOW = new Date('2026-10-15T00:00:00Z');

const empty: DraftInputs = { findings: [], facts: [], forecasts: [], brain: [], calendar: undefined };

const withWorld: DraftInputs = {
  ...empty,
  findings: [{ claim: 'Jiffy now lists junk-removal', soWhat: 'check our taxonomy', url: 'https://j.com', created: '2026-10-01' }],
  facts: [{ company: 'TaskRabbit', predicate: 'offers_snow_removal', value: 'yes', url: 'https://t.com', since: '2026-09-01' }],
  brain: [{ text: 'Taskly positions on getting anything done', citation: 'brand/VOICE.md § Positioning' }],
  calendar: [{ name: 'snow removal', startsMonth: 11, endsMonth: 3, leadWeeks: 8, why: 'supply first' }],
};

const asks = (payload: unknown): AskPort => ({
  ask: async () => ({ text: JSON.stringify(payload), costCents: 0.05 }),
});

describe('buildEvidence', () => {
  it('numbers everything from 1, in order of evidential strength', () => {
    const e = buildEvidence(withWorld, NOW);
    expect(e[0]?.kind).toBe('finding');
    expect(e[1]?.kind).toBe('fact');
    expect(e.map((x) => x.id)).toEqual(e.map((_, i) => i + 1));
  });

  it('includes a season only while it is actionable', () => {
    const e = buildEvidence(withWorld, NOW);
    expect(e.some((x) => x.kind === 'season')).toBe(true);
    // June: snow is five months out, and mentioning it daily is how a calendar
    // becomes noise.
    const june = buildEvidence(withWorld, new Date('2026-06-15T00:00:00Z'));
    expect(june.some((x) => x.kind === 'season')).toBe(false);
  });
});

describe('composeDraft', () => {
  it('says nothing, and spends nothing, when nothing has been observed', async () => {
    let called = false;
    const draft = await composeDraft(
      { ...empty, brain: [{ text: 'we exist', citation: 'x.md' }], calendar: withWorld.calendar },
      { ask: async () => { called = true; return { text: '{}', costCents: 1 }; } },
      NOW,
    );
    expect(called).toBe(false);
    expect(draft.recommendations).toEqual([]);
    expect(draft.costCents).toBe(0);
    expect(draft.note).toMatch(/run the competitor watch/i);
  });

  it('produces a checked recommendation when the world has been observed', async () => {
    const draft = await composeDraft(
      withWorld,
      asks({
        note: '',
        recommendations: [{
          action: 'Add junk removal to the taxonomy',
          reasoning: 'A competitor started listing it',
          falsifier: 'Fewer than 5 junk-removal tasks posted in 60 days',
          evidence: [1], horizon: '4 weeks',
        }],
      }),
      NOW,
    );
    expect(draft.recommendations).toHaveLength(1);
    expect(draft.recommendations[0]?.basis).toBe('inferred_from_sources');
  });

  it('reports a model failure instead of inventing a plan', async () => {
    const draft = await composeDraft(withWorld, { ask: async () => null }, NOW);
    expect(draft.recommendations).toEqual([]);
    expect(draft.note).toMatch(/nothing here is a fallback/i);
  });

  it('drops an unsupported proposal and keeps the supported one', async () => {
    const draft = await composeDraft(
      withWorld,
      asks({
        recommendations: [
          { action: 'Buy billboards', reasoning: 'brand', falsifier: 'no lift', evidence: [] },
          { action: 'Add junk removal', reasoning: 'observed', falsifier: 'no posts', evidence: [1] },
        ],
      }),
      NOW,
    );
    expect(draft.recommendations.map((r) => r.action)).toEqual(['Add junk removal']);
    expect(draft.dropped).toHaveLength(1);
  });
});
