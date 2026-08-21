import { describe, expect, it } from 'vitest';

import { parseArgs } from './cli.js';

describe('parseArgs', () => {
  it('defaults to a full, scheduled pass', () => {
    expect(parseArgs([])).toEqual({ help: false });
  });

  it('accepts both spellings of a valued flag', () => {
    expect(parseArgs(['--only', 'hn', '--limit', '3'])).toMatchObject({ only: 'hn', limit: 3 });
    expect(parseArgs(['--only=rss', '--limit=1'])).toMatchObject({ only: 'rss', limit: 1 });
  });

  it('ignores the `--` pnpm forwards, which is the documented invocation', () => {
    expect(parseArgs(['--', '--force'])).toMatchObject({ force: true });
  });

  it('refuses an unknown argument rather than running something unintended', () => {
    expect(() => parseArgs(['--forse'])).toThrow(/unknown argument/);
  });
});
