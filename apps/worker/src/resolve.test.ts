/**
 * The calibration report.
 *
 * Two properties, and both are about refusing to overstate. A score printed
 * without its n invites a reading it cannot support — four resolved questions
 * is not a track record whatever the Brier says — and human and agent
 * forecasts pooled into one number describe nobody, which is the comparison
 * `PredictionRecord.author` exists to make possible.
 */
import { describe, expect, it } from 'vitest';
import type { PredictionRecord } from '@tmos/intel';

import { authorClass, calibrationReport, scorable } from './resolve.js';

const p = (over: Partial<PredictionRecord> = {}): PredictionRecord => ({
  id: '1',
  claim: 'Jiffy will list snow removal by November.',
  p: 0.7,
  author: 'human:nishant',
  created_at: '2026-08-01T00:00:00.000Z',
  resolve_at: '2026-11-01T00:00:00.000Z',
  resolver: { kind: 'manual' } as PredictionRecord['resolver'],
  evidence_snapshot_hash: 'abc',
  decision_id: null,
  belief_ids: [],
  outcome: null,
  observed: null,
  resolved_at: null,
  annul_reason: null,
  ...over,
});

describe('authorClass', () => {
  it('separates the two things worth comparing', () => {
    expect(authorClass('human:nishant')).toBe('human');
    expect(authorClass('agent:openai/gpt-oss-120b@watch-3')).toBe('agent');
    expect(authorClass('somebody')).toBe('other');
  });
});

describe('scorable', () => {
  it('keeps only settled forecasts', () => {
    const rows = [p({ outcome: 1 }), p({ outcome: 0 }), p({ outcome: 'annulled' }), p()];
    // Annulled is not a wrong answer and open is not an answer at all;
    // counting either as a zero would penalise an unreachable source.
    expect(scorable(rows)).toEqual([
      { p: 0.7, outcome: 1 },
      { p: 0.7, outcome: 0 },
    ]);
  });
});

describe('calibrationReport', () => {
  it('says there is no score rather than printing one from nothing', () => {
    const text = calibrationReport([p(), p()]).join('\n');
    expect(text).toMatch(/2 prediction\(s\): 0 settled · 2 open/);
    expect(text).toMatch(/no settled forecasts yet/i);
    expect(text).not.toMatch(/Brier /);
  });

  it('leads with the counts, then the score', () => {
    const rows = [p({ outcome: 1 }), p({ outcome: 0, p: 0.2 })];
    const lines = calibrationReport(rows);
    const counts = lines.findIndex((l) => l.includes('settled'));
    const brier = lines.findIndex((l) => l.includes('Brier'));

    expect(counts).toBeGreaterThanOrEqual(0);
    expect(counts).toBeLessThan(brier);
  });

  it('shows the decomposition, not just the number', () => {
    const text = calibrationReport([p({ outcome: 1 }), p({ outcome: 0, p: 0.3 })]).join('\n');
    // Brier alone cannot tell overconfidence from saying 50% about everything,
    // and the second is the one a startup has and mistakes for humility.
    expect(text).toMatch(/reliability/);
    expect(text).toMatch(/resolution/);
    expect(text).toMatch(/uncertainty/);
  });

  it('scores humans and agents separately when both are present', () => {
    const rows = [
      p({ outcome: 1, author: 'human:nishant' }),
      p({ outcome: 0, author: 'agent:openai/gpt-oss-120b@x', p: 0.9 }),
    ];
    const text = calibrationReport(rows).join('\n');

    expect(text).toMatch(/scored separately/);
    expect(text).toMatch(/human\s+n=\s*1/);
    expect(text).toMatch(/agent\s+n=\s*1/);
  });

  it('does not split by author when only one kind has forecast', () => {
    const text = calibrationReport([p({ outcome: 1 })]).join('\n');
    expect(text).not.toMatch(/scored separately/);
  });
});
