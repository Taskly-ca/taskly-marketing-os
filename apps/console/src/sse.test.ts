/**
 * ONE FRAME PER EVENT, WHATEVER IS IN IT.
 *
 * SSE is a line protocol: a bare newline inside `data:` ends the field, and a
 * blank line ends the frame. So the only property worth proving about `send` is
 * that a payload containing newlines — which every answer's prose does — still
 * arrives as exactly one frame rather than as a truncated one followed by
 * garbage the browser silently drops.
 *
 * `JSON.stringify` is what buys that, and it is easy to "simplify" away by
 * writing the text straight into the field. This test is the reason not to.
 */
import { describe, expect, it } from 'vitest';

import { send, type SseSink } from './sse.js';

function sink(): { written: string[]; sink: SseSink } {
  const written: string[] = [];
  return { written, sink: { write: (chunk: string) => written.push(chunk) } };
}

describe('send', () => {
  it('writes one frame: an event line, a data line, and a blank line', () => {
    const { written, sink: s } = sink();
    send(s, 'status', { phase: 'writing' });
    expect(written).toEqual(['event: status\ndata: {"phase":"writing"}\n\n']);
  });

  it('escapes newlines, so multi-line prose stays a single frame', () => {
    const { written, sink: s } = sink();
    send(s, 'delta', { n: 1, text: 'first line\nsecond line' });
    const frame = written[0] ?? '';
    // Exactly one blank-line terminator, and it is at the end.
    expect(frame.indexOf('\n\n')).toBe(frame.length - 2);
    expect(frame.split('\n').filter((l) => l.startsWith('data: '))).toHaveLength(1);
    expect(frame).toContain('\\n');
  });

  it('carries a bare string payload as JSON, not raw', () => {
    const { written, sink: s } = sink();
    send(s, 'error_msg', 'no search provider configured');
    expect(written[0]).toBe('event: error_msg\ndata: "no search provider configured"\n\n');
  });
});
