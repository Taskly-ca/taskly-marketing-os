/**
 * What the draft asks the Brain.
 *
 * A constant query returns a constant answer, which would make the Brain a
 * decoration on every draft rather than an input to it — the same three
 * passages about positioning, every week, regardless of what is actually in
 * play. The queries are built from the open seasons and the companies we hold
 * facts about so that October retrieves the snow campaign and June does not.
 */
import { describe, expect, it } from 'vitest';

import { brainQueries } from './draft-route.js';

describe('brainQueries', () => {
  it('always asks the three questions every draft needs', () => {
    const q = brainQueries([], []).join(' | ');
    expect(q).toMatch(/positioning/i);
    expect(q).toMatch(/roadmap/i);
    expect(q).toMatch(/pricing/i);
  });

  it('asks about the seasons that are actually open', () => {
    expect(brainQueries(['snow removal'], []).join(' | ')).toMatch(/snow removal/);
  });

  it('varies with the season, so October and June retrieve different pages', () => {
    const oct = brainQueries(['snow removal'], []);
    const jun = brainQueries(['lawn and garden'], []);
    expect(oct).not.toEqual(jun);
  });

  it('asks how we compare only to competitors we hold facts about', () => {
    expect(brainQueries([], ['Jiffy', 'Handy']).join(' | ')).toMatch(/Jiffy, Handy/);
    // No companies means no comparison question rather than an empty one.
    expect(brainQueries([], []).join(' | ')).not.toMatch(/compare to\s*$/);
  });
});
