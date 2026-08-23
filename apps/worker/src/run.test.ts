/**
 * The pass runner.
 *
 * One property matters more than the rest and it is the one that is easy to get
 * backwards: a stage that throws must not stop the pass. The stages' failure
 * modes are uncorrelated — a feed having a bad afternoon is not a reason to
 * skip regenerating the briefing from data already in the database — and a
 * runner that aborts on the first error turns every flaky source into a night
 * with no output at all.
 */
import { describe, expect, it, vi } from 'vitest';

import { STAGES, parseArgs, plan, runPass, summarise, type Stage } from './run.js';

const stage = (name: string, over: Partial<Stage> = {}): Stage => ({
  name,
  why: 'because',
  run: async () => undefined,
  spends: false,
  ...over,
});

describe('parseArgs', () => {
  it('runs everything by default', () => {
    expect(parseArgs([])).toEqual({ only: null, free: false, help: false });
  });

  it('reads --only in both spellings', () => {
    expect(parseArgs(['--only', 'watch']).only).toBe('watch');
    expect(parseArgs(['--only=digest']).only).toBe('digest');
  });

  it('refuses a stage that does not exist, naming the ones that do', () => {
    // Silently running nothing looks identical to a pass where every stage was
    // a no-op, and the exit code is zero either way.
    expect(() => parseArgs(['--only', 'reasoning'])).toThrow(/unknown stage "reasoning"/);
    expect(() => parseArgs(['--only', 'reasoning'])).toThrow(/collect/);
  });

  it('ignores the -- that pnpm forwards', () => {
    expect(parseArgs(['--', '--free']).free).toBe(true);
  });
});

describe('plan', () => {
  const stages = [stage('a'), stage('b', { spends: true }), stage('c')];

  it('keeps the declared order', () => {
    expect(plan({ only: null, free: false, help: false }, stages).map((s) => s.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('--free drops the stages that spend on a model', () => {
    expect(plan({ only: null, free: true, help: false }, stages).map((s) => s.name)).toEqual([
      'a',
      'c',
    ]);
  });

  it('--only narrows to one', () => {
    expect(plan({ only: 'b', free: false, help: false }, stages).map((s) => s.name)).toEqual(['b']);
  });
});

describe('the declared pass', () => {
  it('collects before it reasons, and writes the page last', () => {
    const names = STAGES.map((s) => s.name);
    expect(names.indexOf('collect')).toBeLessThan(names.indexOf('reason'));
    expect(names.indexOf('watch')).toBeLessThan(names.indexOf('digest'));
    // The briefing reflects the pass that just ran, even when stages failed.
    expect(names.at(-1)).toBe('briefing');
  });

  it('marks exactly the model-spending stages', () => {
    const spends = STAGES.filter((s) => s.spends).map((s) => s.name);
    expect(spends).toEqual(['watch', 'reason']);
  });
});

describe('runPass', () => {
  const quiet = (): void => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  };

  it('runs every stage in order', async () => {
    quiet();
    const seen: string[] = [];
    const stages = ['a', 'b', 'c'].map((n) => stage(n, { run: async () => void seen.push(n) }));

    const results = await runPass({ only: null, free: false, help: false }, { stages, clock: () => 0 });
    vi.restoreAllMocks();

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('CONTINUES after a stage throws, and records why', async () => {
    quiet();
    const seen: string[] = [];
    const stages = [
      stage('a', {
        run: async () => {
          throw new Error('ENOTFOUND feeds.example');
        },
      }),
      stage('b', { run: async () => void seen.push('b') }),
    ];

    const results = await runPass({ only: null, free: false, help: false }, { stages, clock: () => 0 });
    vi.restoreAllMocks();

    // The whole point: a feed with a bad afternoon must not stop the briefing.
    expect(seen).toEqual(['b']);
    expect(results[0]).toMatchObject({ name: 'a', ok: false });
    expect(results[0]?.detail).toMatch(/ENOTFOUND/);
    expect(results[1]).toMatchObject({ name: 'b', ok: true });
  });

  it('times each stage from the injected clock', async () => {
    quiet();
    let t = 0;
    const results = await runPass(
      { only: null, free: false, help: false },
      { stages: [stage('a')], clock: () => (t += 25) },
    );
    vi.restoreAllMocks();

    expect(results[0]?.ms).toBe(25);
  });
});

describe('summarise', () => {
  it('reports a failed stage without calling the pass a failure', async () => {
    const lines = summarise([
      { name: 'collect', ok: false, ms: 12, detail: 'ENOTFOUND feeds.example' },
      { name: 'briefing', ok: true, ms: 40, detail: '' },
    ]);
    const text = lines.join('\n');

    expect(text).toMatch(/FAILED\s+collect/);
    expect(text).toMatch(/ENOTFOUND/);
    expect(text).toMatch(/the pass still completed/);
  });

  it('says so plainly when everything worked', () => {
    expect(summarise([{ name: 'digest', ok: true, ms: 3, detail: '' }]).join('\n')).toMatch(
      /all green/,
    );
  });
});
