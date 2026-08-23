/**
 * Delivery, without a network.
 *
 * The case that would do real damage is the quiet one: Slack answers HTTP 200
 * with `{ok:false}` for a bad token, a channel the bot is not in, or blocks it
 * will not render. Reading the status alone reports a successful delivery of a
 * message nobody received — and the delivery row that follows silences those
 * Findings permanently, because the never-send-it-twice rule has no expiry.
 *
 * So: a failed send records nothing, a refused render records nothing, and no
 * credentials is a skip rather than a throw.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Finding } from '@tmos/contracts';
import type { DeliveryRecord } from '@tmos/surface';

import {
  DIGEST_CHANNEL_ENV,
  DIGEST_EMAIL_ENV,
  DIGEST_FROM_ENV,
  chooseDelivery,
  createResendDelivery,
  createSlackDelivery,
  plainText,
  runDigest,
  type DigestDeliveryPort,
} from './deliver.js';

const NOW = new Date('2026-08-23T12:00:00.000Z');

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: '11111111-1111-4111-8111-111111111111',
  claim: "Jiffy's sitemap now lists junk-removal.",
  so_what: 'A category has appeared in it — check whether our taxonomy covers it.',
  subject_refs: ['company:jiffyondemand.com'],
  evidence: [
    {
      signal_id: null,
      fact_id: null,
      source_url: 'https://jiffyondemand.com/sitemap.xml',
      span: '<loc>https://jiffyondemand.com/service/junk-removal</loc>',
      observed_at: '2026-08-23T11:00:00.000Z',
    },
  ],
  basis: 'inferred_from_sources',
  causal_rung: 0,
  stakes: 'high',
  region: 'ca',
  domain_score: 0.85,
  generated_by: 'agent:openai/gpt-oss-120b@watch-3',
  reviewed_by: null,
  superseded_by: null,
  supersede_reason: null,
  created_at: '2026-08-23T11:30:00.000Z',
  ...over,
});

const transportThat = (ok: boolean): DigestDeliveryPort & { calls: number } => {
  const t = {
    calls: 0,
    channel: 'test',
    async send() {
      t.calls += 1;
      return { ok, channel: 'test', detail: ok ? 'posted' : 'refused' };
    },
  };
  return t;
};

const deps = (over: Partial<Parameters<typeof runDigest>[0]> = {}) => {
  const recorded: DeliveryRecord[] = [];
  return {
    recorded,
    input: {
      findings: [finding()],
      history: [] as DeliveryRecord[],
      signalsExamined: 240,
      now: NOW,
      deepLinkBase: 'https://tmos.local/app',
      transport: transportThat(true),
      record: async (r: DeliveryRecord) => {
        recorded.push(r);
      },
      ...over,
    },
  };
};

describe('chooseDelivery', () => {
  it('prefers Slack when both are configured', () => {
    const got = chooseDelivery({
      SLACK_BOT_TOKEN: 'xoxb-1',
      [DIGEST_CHANNEL_ENV]: 'C123',
      RESEND_API_KEY: 're_1',
      [DIGEST_EMAIL_ENV]: 'a@b.c',
      [DIGEST_FROM_ENV]: 'x@y.z',
    });
    expect(got?.channel).toBe('slack:C123');
  });

  it('falls back to email', () => {
    const got = chooseDelivery({
      RESEND_API_KEY: 're_1',
      [DIGEST_EMAIL_ENV]: 'a@b.c',
      [DIGEST_FROM_ENV]: 'x@y.z',
    });
    expect(got?.channel).toBe('email:a@b.c');
  });

  it('returns null rather than throwing when nothing is set', () => {
    expect(chooseDelivery({})).toBeNull();
    // A token with no channel is not a configured transport; half a credential
    // must not read as one.
    expect(chooseDelivery({ SLACK_BOT_TOKEN: 'xoxb-1' })).toBeNull();
  });
});

describe('createSlackDelivery', () => {
  it('treats HTTP 200 with ok:false as a failure', async () => {
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), { status: 200 }),
    );
    const port = createSlackDelivery({ token: 't', channel: 'C1', fetch: fetchStub as never });

    const got = await port.send({ text: 'x', blocks: [] }, 'x');
    expect(got.ok).toBe(false);
    expect(got.detail).toMatch(/not_in_channel/);
  });

  it('reports an unreachable host rather than throwing', async () => {
    const port = createSlackDelivery({
      token: 't',
      channel: 'C1',
      fetch: (async () => {
        throw new Error('ENOTFOUND');
      }) as never,
    });
    await expect(port.send({ text: 'x', blocks: [] }, 'x')).resolves.toMatchObject({ ok: false });
  });
});

describe('createResendDelivery', () => {
  it('sends the rendered text, not a second rendering of it', async () => {
    // A second rendering path is a second place a banned claim can be
    // introduced after the gate that would have caught it.
    let sent: string | undefined;
    const fetchStub = vi.fn(async (_url: string, init: { body?: string }) => {
      sent = init.body;
      return new Response('{}', { status: 200 });
    });
    const port = createResendDelivery({
      apiKey: 'k',
      from: 'a@b.c',
      to: 'd@e.f',
      subject: 's',
      fetch: fetchStub as never,
    });

    const got = await port.send({ text: 'blocks', blocks: [] }, 'the rendered lines');
    expect(got.ok).toBe(true);

    const body = JSON.parse(String(sent)) as Record<string, unknown>;
    expect(body['text']).toBe('the rendered lines');
    expect(body).not.toHaveProperty('html');
  });

  it('reports a refusal by status', async () => {
    const port = createResendDelivery({
      apiKey: 'k',
      from: 'a@b.c',
      to: 'd@e.f',
      subject: 's',
      fetch: (async () => new Response('bad key', { status: 401 })) as never,
    });
    await expect(port.send({ text: 'x', blocks: [] }, 'x')).resolves.toMatchObject({ ok: false });
  });
});

describe('runDigest', () => {
  it('sends, and records only after the transport confirms', async () => {
    const d = deps();
    const report = await runDigest(d.input);

    expect(report.outcome?.ok).toBe(true);
    expect(report.delivered).toEqual([finding().id]);
    expect(d.recorded).toHaveLength(1);
    expect(d.recorded[0]?.deliveredAt).toBe(NOW.toISOString());
  });

  it('records NOTHING when the send failed', async () => {
    // The rule this protects: a delivery row silences a Finding forever, and
    // the never-send-it-twice rule has no expiry.
    const d = deps({ transport: transportThat(false) });
    const report = await runDigest(d.input);

    expect(report.outcome?.ok).toBe(false);
    expect(report.delivered).toEqual([]);
    expect(d.recorded).toEqual([]);
  });

  it('skips cleanly with no transport, and still selects', async () => {
    const d = deps({ transport: null });
    const report = await runDigest(d.input);

    expect(report.outcome).toBeNull();
    expect(report.delivered).toEqual([]);
    expect(report.selection.kind).toBe('digest');
    // The work still happened and can be read from the report — a run that
    // reasoned correctly did not fail because nobody set a token.
    expect(report.rendered).toHaveLength(1);
  });

  it('never re-sends something already delivered', async () => {
    const d = deps({
      history: [{ findingId: finding().id, deliveredAt: '2026-08-01T00:00:00.000Z' }],
    });
    const report = await runDigest(d.input);

    expect(report.selection.kind).toBe('quiet');
    expect(d.recorded).toEqual([]);
  });

  it('sends a quiet message with its receipt rather than nothing', async () => {
    const d = deps({ findings: [] });
    const report = await runDigest(d.input);

    expect(report.selection.kind).toBe('quiet');
    if (report.selection.kind !== 'quiet') return;
    // Silence with a receipt is a result; silence without one is an outage.
    expect(report.selection.checked).toBe(240);
    expect(report.outcome?.ok).toBe(true);
  });

  it('does not record a finding the render gates refused', async () => {
    const d = deps({
      findings: [finding({ claim: 'The rate change caused a drop in offers.' })],
    });
    const report = await runDigest(d.input);

    expect(report.refusals.length).toBeGreaterThan(0);
    expect(d.recorded).toEqual([]);
  });
});

describe('plainText', () => {
  it('carries the note and its link, for a transport with no blocks', () => {
    const body = plainText([
      { id: 'a', lines: ['one', 'two'], text: 'one\ntwo', deepLink: 'https://x/a' },
    ]);
    expect(body).toContain('one\ntwo');
    expect(body).toContain('https://x/a');
  });
});
