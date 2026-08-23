/**
 * The rendering fallback, without a key or a network.
 *
 * Nothing here has met a real Firecrawl response, which is exactly why the
 * parsing is what gets tested: the failure this must not have is returning
 * `"undefined"` or `"[object Object]"` as a document and having it quoted in a
 * Finding. Every unexpected shape must produce a null and a reason.
 */
import { describe, expect, it, vi } from 'vitest';

import { MIN_USEFUL_CHARS, RENDER_KEY_ENV, createRenderer, extractText } from './render.js';

const page = (n = MIN_USEFUL_CHARS + 10): string => 'a'.repeat(n);

describe('extractText', () => {
  it('reads the documented field', () => {
    expect(extractText({ success: true, data: { markdown: page() } })).toHaveLength(
      MIN_USEFUL_CHARS + 10,
    );
  });

  it('returns null for every shape it does not recognise', () => {
    for (const body of [
      null,
      'a string',
      [],
      {},
      { data: null },
      { data: 'text' },
      { data: {} },
      { data: { markdown: 42 } },
      { success: false, data: { markdown: page() } },
    ]) {
      expect(extractText(body), JSON.stringify(body)).toBeNull();
    }
  });

  it('treats a page too short to read as no page', () => {
    // The same floor `readPage` uses: under it, this is a cookie wall or a
    // redirect stub, and quoting it cites a consent banner as evidence.
    expect(extractText({ data: { markdown: 'too short' } })).toBeNull();
  });
});

describe('createRenderer', () => {
  it('is null with no key — a skip, never a crash', () => {
    expect(createRenderer({})).toBeNull();
    expect(createRenderer({ [RENDER_KEY_ENV]: '   ' })).toBeNull();
  });

  it('asks for rendered markdown of the main content', async () => {
    let sent: string | undefined;
    const fetchStub = vi.fn(async (_u: string, init: { body?: string }) => {
      sent = init.body;
      return new Response(JSON.stringify({ success: true, data: { markdown: page() } }), {
        status: 200,
      });
    });

    const render = createRenderer({ [RENDER_KEY_ENV]: 'fc-1' }, { fetch: fetchStub as never });
    const got = await render?.('https://jiffyondemand.com/');

    expect(got?.ok).toBe(true);
    const body = JSON.parse(String(sent)) as Record<string, unknown>;
    expect(body['url']).toBe('https://jiffyondemand.com/');
    expect(body['formats']).toEqual(['markdown']);
    expect(body['onlyMainContent']).toBe(true);
  });

  it('reports a refusal rather than throwing', async () => {
    const render = createRenderer(
      { [RENDER_KEY_ENV]: 'fc-1' },
      { fetch: (async () => new Response('nope', { status: 402 })) as never },
    );
    await expect(render?.('https://x.test/')).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('402'),
    });
  });

  it('reports an unusable body rather than returning it', async () => {
    const render = createRenderer(
      { [RENDER_KEY_ENV]: 'fc-1' },
      { fetch: (async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as never },
    );
    await expect(render?.('https://x.test/')).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('no usable markdown'),
    });
  });

  it('reports an unreachable host rather than throwing', async () => {
    const render = createRenderer(
      { [RENDER_KEY_ENV]: 'fc-1' },
      {
        fetch: (async () => {
          throw new Error('ENOTFOUND');
        }) as never,
      },
    );
    await expect(render?.('https://x.test/')).resolves.toMatchObject({ ok: false });
  });
});
