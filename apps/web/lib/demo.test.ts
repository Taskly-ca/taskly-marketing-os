import { describe, expect, it } from 'vitest';
import { newTurn, reduce, type Turn } from './answer';
import { demoScript } from './demo';

const play = (turn: Turn, frames: ReturnType<typeof demoScript>) => [...frames].sort((a, b) => a.at - b.at).reduce((t, f) => reduce(t, f.frame), turn);

describe('demo replays', () => {
  it('web: six sources, five sentences, one flagged, a finished turn that saved nothing', () => {
    const t = play(newTurn('snow removal', 'web'), demoScript('web', { firstTurn: true, answered: false }));
    expect(t.live).toBe(false);
    expect(t.sources).toHaveLength(6);
    expect(t.sentences).toHaveLength(5);
    expect(t.sentences.filter(s => s.verdict === 'flagged')).toHaveLength(1);
    expect(t.messageId).toBeNull();
    expect(t.related).toHaveLength(3);
  });

  it('grounded: all four source kinds side by side, plus refusals before writing', () => {
    const t = play(newTurn('jiffy pricing', 'grounded'), demoScript('grounded', { firstTurn: true, answered: false }));
    expect(new Set(t.sources.map(s => s.kind))).toEqual(new Set(['web', 'world', 'brain', 'ledger']));
    expect(t.unused?.dropped).toHaveLength(1);
    expect(t.unused?.expectations).toHaveLength(1);
  });

  it('deep: asks first on a fresh conversation, and only then', () => {
    const asked = play(newTurn('pricing', 'deep'), demoScript('deep', { firstTurn: true, answered: false }));
    expect(asked.clarify?.questions).toHaveLength(3);
    expect(asked.doneAt).toBeUndefined();
    expect(demoScript('deep', { firstTurn: false, answered: false }).some(f => f.frame.event === 'clarify')).toBe(false);
  });

  it('deep: a barren step, a revision that keeps the old question, a skipped step, and a stop', () => {
    const t = play({ ...newTurn('pricing', 'deep', ['checkout', '', 'GTA']), asked: ['a', 'b', 'c'] }, demoScript('deep', { firstTurn: true, answered: true }));
    expect(t.planRevisions).toBe(1);
    const step2 = t.plan?.find(s => s.n === 2);
    expect(step2?.was?.[0]).toMatchObject({ outcome: 'nothing proved' });
    expect(t.plan?.find(s => s.n === 5)).toMatchObject({ state: 'skipped', added: true });
    expect(t.reflections.at(-1)?.stop).toBeTruthy();
    expect(t.live).toBe(false);
    expect(t.sentences.filter(s => s.verdict === 'flagged')).toHaveLength(1);
  });

  it('frames are in time order within each script', () => {
    for (const mode of ['web', 'grounded', 'deep'] as const) {
      const frames = demoScript(mode, { firstTurn: false, answered: true });
      const done = frames.find(f => f.frame.event === 'done')!;
      expect(frames.every(f => f.at <= done.at)).toBe(true);
    }
  });
});
