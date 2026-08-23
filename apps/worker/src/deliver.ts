/**
 * DELIVERY — the half of a marketing operating system that talks to a human.
 *
 * Part 6 built the whole chain: `selectDigest` decides what earns an
 * interruption, `renderFindings` turns those into six-line notes through the
 * honesty and causal gates, `buildSlackMessage` assembles the blocks. And
 * `SlackTransportPort` says, in its own comment, "implement it wherever the
 * credentials live; nothing in this package ever calls it".
 *
 * Nothing ever did. The build tracker's credential table says "Slack bot token
 * — push delivery works **now**"; `SLACK_BOT_TOKEN` is empty and always has
 * been, so the system has had no way to tell anyone anything since it was
 * built. Every Finding it has produced has been read by someone typing a
 * command.
 *
 * TWO TRANSPORTS, ONE PORT, AND NEITHER IS REQUIRED. Slack takes the blocks and
 * the interaction controls; Resend takes the same rendered lines as text, minus
 * the controls, because an email cannot carry a dismiss-with-a-reason select
 * and pretending otherwise would produce a message whose buttons do nothing.
 * Whichever credential exists is used, Slack first. Neither configured is a
 * REPORTED skip, never a crash: a run that collected and reasoned correctly did
 * not fail because nobody had set a token, and it must not exit non-zero and
 * teach an operator to ignore the exit code.
 *
 * A SEND IS RECORDED BEFORE IT IS TRUSTED, AND ONLY AFTER IT SUCCEEDS. The
 * never-send-it-twice rule and the weekly cap both read `digest_delivery`
 * (migration 012), so a row written for a message that failed to post silences
 * a Finding forever without anyone reading it. Recording after the transport
 * confirms means the opposite failure — a message that posted and was not
 * recorded, and could be sent again — which is recoverable by a human who sees
 * it twice and is not recoverable the other way round.
 */
import type { Finding } from '@tmos/contracts';
import { assertHonest, assertCausalLanguage } from '@tmos/guardrails';
import {
  assertGatesLive,
  assertPayloadClean,
  buildSlackMessage,
  renderFindings,
  selectDigest,
  toPayload,
  type DeliveryRecord,
  type DigestSelection,
  type RenderedFinding,
  type SlackMessage,
} from '@tmos/surface';

/* ── the port ─────────────────────────────────────────────────────────────── */

export interface DeliveryOutcome {
  readonly ok: boolean;
  readonly channel: string;
  readonly detail: string;
}

export interface DigestDeliveryPort {
  readonly channel: string;
  send(message: SlackMessage, plain: string): Promise<DeliveryOutcome>;
}

/* ── Slack ────────────────────────────────────────────────────────────────── */

const SLACK_URL = 'https://slack.com/api/chat.postMessage';

interface SlackOptions {
  readonly token: string;
  readonly channel: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * `chat.postMessage` answers **HTTP 200 with `{ok:false}`** on almost every
 * failure — a bad token, a channel the bot is not in, blocks Slack will not
 * render. Reading the status alone reports a successful delivery of a message
 * nobody received, and the delivery row that follows would then silence those
 * Findings permanently. So the body decides.
 */
export function createSlackDelivery(options: SlackOptions): DigestDeliveryPort {
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    channel: `slack:${options.channel}`,
    async send(message: SlackMessage): Promise<DeliveryOutcome> {
      try {
        const res = await doFetch(SLACK_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({ channel: options.channel, ...message }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (res.ok && body.ok === true) {
          return { ok: true, channel: `slack:${options.channel}`, detail: 'posted' };
        }
        return {
          ok: false,
          channel: `slack:${options.channel}`,
          detail: `slack refused: ${body.error ?? `http ${res.status}`}`,
        };
      } catch (error) {
        return {
          ok: false,
          channel: `slack:${options.channel}`,
          detail: `slack unreachable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/* ── Resend ───────────────────────────────────────────────────────────────── */

const RESEND_URL = 'https://api.resend.com/emails';

interface ResendOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The same rendered lines, as text.
 *
 * Deliberately NOT HTML. These notes are six lines with a link; the honesty and
 * causal gates ran over the text and would have to run again over any markup
 * built from it, and a second rendering path is a second place a banned claim
 * can be introduced after the gate that would have caught it.
 */
export function createResendDelivery(options: ResendOptions): DigestDeliveryPort {
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    channel: `email:${options.to}`,
    async send(_message: SlackMessage, plain: string): Promise<DeliveryOutcome> {
      try {
        const res = await doFetch(RESEND_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: options.from,
            to: [options.to],
            subject: options.subject,
            text: plain,
          }),
        });
        if (res.ok) return { ok: true, channel: `email:${options.to}`, detail: 'sent' };
        return {
          ok: false,
          channel: `email:${options.to}`,
          detail: `resend refused: http ${res.status} ${(await res.text()).slice(0, 160)}`,
        };
      } catch (error) {
        return {
          ok: false,
          channel: `email:${options.to}`,
          detail: `resend unreachable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/* ── choosing one ─────────────────────────────────────────────────────────── */

export const DIGEST_CHANNEL_ENV = 'SLACK_DIGEST_CHANNEL';
export const DIGEST_EMAIL_ENV = 'DIGEST_EMAIL_TO';
export const DIGEST_FROM_ENV = 'DIGEST_EMAIL_FROM';

/**
 * The transport, or null when nothing is configured.
 *
 * Null is a first-class answer. Neither credential set is the normal state of a
 * fresh checkout, and it must produce a printed skip rather than a throw —
 * exactly like a collector with no key, which this repo already treats as
 * "reported as skipped, never as a source nobody added".
 */
export function chooseDelivery(env: NodeJS.ProcessEnv): DigestDeliveryPort | null {
  const slackToken = env.SLACK_BOT_TOKEN?.trim();
  const slackChannel = env[DIGEST_CHANNEL_ENV]?.trim();
  if (slackToken && slackChannel) {
    return createSlackDelivery({ token: slackToken, channel: slackChannel });
  }

  const resendKey = env.RESEND_API_KEY?.trim();
  const to = env[DIGEST_EMAIL_ENV]?.trim();
  const from = env[DIGEST_FROM_ENV]?.trim();
  if (resendKey && to && from) {
    return createResendDelivery({
      apiKey: resendKey,
      from,
      to,
      subject: 'Worth your attention this week',
    });
  }

  return null;
}

/* ── the digest run ───────────────────────────────────────────────────────── */

interface DigestDeps {
  readonly findings: readonly Finding[];
  readonly history: readonly DeliveryRecord[];
  readonly signalsExamined: number;
  readonly now: Date;
  readonly deepLinkBase: string;
  readonly transport: DigestDeliveryPort | null;
  /** Called once per delivered finding, AFTER the transport confirms. */
  readonly record: (record: DeliveryRecord) => Promise<void>;
}

interface DigestReport {
  readonly selection: DigestSelection;
  readonly rendered: RenderedFinding[];
  readonly refusals: string[];
  readonly delivered: string[];
  readonly outcome: DeliveryOutcome | null;
}

/**
 * The rendered notes as one plain-text body, for a transport without blocks.
 *
 * `fallback` is the built message's own `text`, and it is not decoration: on a
 * QUIET week nothing is rendered, so the notes are empty — and Resend rejects a
 * mail with no `text` field outright (422). The quiet message is the one that
 * most needs to arrive, because a system that goes quiet and a system that is
 * broken look identical from outside, so an empty body is exactly the wrong
 * thing to send and exactly the wrong thing to fail on. Found on the first
 * real send, 2026-08-23.
 */
export const plainText = (
  rendered: readonly RenderedFinding[],
  fallback = '',
): string => {
  const body = rendered.map((r) => `${r.text}\n${r.deepLink}`).join('\n\n---\n\n');
  return body === '' ? fallback : body;
};

export async function runDigest(deps: DigestDeps): Promise<DigestReport> {
  const gates = { honesty: assertHonest, causal: assertCausalLanguage };
  // Prove the gates are the real ones before rendering anything through them: a
  // silently-passing guard produces a green run and a false record that the
  // text was checked.
  assertGatesLive(gates);

  const selection = selectDigest({
    candidates: deps.findings,
    history: deps.history,
    signalsExamined: deps.signalsExamined,
    now: deps.now,
  });

  const batch =
    selection.kind === 'digest'
      ? renderFindings(
          selection.items.map((i) => ({ finding: i.finding, deepLinkBase: deps.deepLinkBase })),
          gates,
        )
      : { rendered: [], refused: [] };

  // The builder takes the SELECTION, so a quiet week is its own message with
  // its own receipt — the count of signals examined — rather than an empty
  // digest. Silence with a receipt is a result; silence without one is an
  // outage, and the reader cannot tell them apart.
  const message = buildSlackMessage(selection, batch.rendered);
  // Belt to the builder's braces: a payload over Slack's limits is rejected
  // here rather than by Slack, where the failure is a 200 with `ok:false`.
  assertPayloadClean(toPayload(message));

  const refusals = batch.refused.map((r) => `${r.id}: ${r.code} — ${r.detail}`);

  if (deps.transport === null) {
    return { selection, rendered: [...batch.rendered], refusals, delivered: [], outcome: null };
  }

  const outcome = await deps.transport.send(
    toPayload(message),
    plainText(batch.rendered, message.text),
  );

  const delivered: string[] = [];
  if (outcome.ok && selection.kind === 'digest') {
    // Only what was actually rendered: a finding the gates refused was never in
    // the message, and recording it would silence it forever unread.
    const shown = new Set(batch.rendered.map((r) => r.id));
    for (const item of selection.items) {
      if (!shown.has(item.finding.id)) continue;
      await deps.record({
        findingId: item.finding.id,
        deliveredAt: deps.now.toISOString(),
        preemptedCap: item.preempts,
      });
      delivered.push(item.finding.id);
    }
  }

  return { selection, rendered: [...batch.rendered], refusals, delivered, outcome };
}
