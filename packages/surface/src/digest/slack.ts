/**
 * The Slack surface: a message BUILDER, and a port somebody else wires.
 *
 * Nothing here talks to the network, reads a token, or knows a workspace
 * exists. A builder that can send is a builder that sends during a test run,
 * during a refactor, and during the first careless `node -e` — and "the founder
 * received a fabricated digest" is not recoverable by reverting a commit. So
 * the transport is an interface the CALLER supplies, and pointing it at a real
 * workspace stays the decision of whoever owns that workspace.
 *
 * Three things this message does that a text dump would not:
 *
 *   1. A deep link per finding — a summary that cannot be left is one the
 *      reader has to trust blindly.
 *   2. A dismissal that CARRIES A REASON. `feedback.ts` refuses an unreasoned
 *      dismissal because it routes to no component; a bare dismiss button would
 *      make that refusal unreachable and the taxonomy decorative. So the
 *      control is a select and the reason travels in the payload value.
 *   3. Degrades by dropping WHOLE findings. Slack allows 50 blocks and 3000
 *      characters per text object, and the tempting fix — trim until it fits —
 *      silently amputates evidence. An omitted finding is visible; a truncated
 *      one is not.
 */
import { ALL_DISMISS_REASONS, dismissMeaning } from '../feedback.js';
import { assertNoConfidenceNumber } from '../basis.js';
import { truncateLine, type RenderedFinding } from './format.js';
import type { DigestSelection, QuietReason } from './select.js';

/* ── Slack's limits ───────────────────────────────────────────────────────── */

export const MAX_BLOCKS = 50;
export const MAX_TEXT_CHARS = 3000;
export const MAX_HEADER_CHARS = 150;

/** section + actions + divider. */
const BLOCKS_PER_FINDING = 3;
/** header + footer context. */
const RESERVED_BLOCKS = 2;

export const MAX_FINDINGS_PER_MESSAGE = Math.floor(
  (MAX_BLOCKS - RESERVED_BLOCKS) / BLOCKS_PER_FINDING,
);

/* ── Block Kit, as plain data ─────────────────────────────────────────────── */

export interface SlackTextObject {
  type: 'mrkdwn' | 'plain_text';
  text: string;
  emoji?: boolean;
}

export interface SlackOption {
  text: SlackTextObject;
  value: string;
}

export interface SlackButton {
  type: 'button';
  action_id: string;
  text: SlackTextObject;
  url?: string;
  value?: string;
}

export interface SlackStaticSelect {
  type: 'static_select';
  action_id: string;
  placeholder: SlackTextObject;
  options: SlackOption[];
}

export type SlackElement = SlackButton | SlackStaticSelect;

export interface SlackHeaderBlock {
  type: 'header';
  text: SlackTextObject;
}
export interface SlackSectionBlock {
  type: 'section';
  text: SlackTextObject;
}
export interface SlackContextBlock {
  type: 'context';
  elements: SlackTextObject[];
}
export interface SlackActionsBlock {
  type: 'actions';
  block_id: string;
  elements: SlackElement[];
}
export interface SlackDividerBlock {
  type: 'divider';
}

export type SlackBlock =
  SlackHeaderBlock | SlackSectionBlock | SlackContextBlock | SlackActionsBlock | SlackDividerBlock;

/** Exactly what goes on the wire. */
export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

/** What a builder returns: the payload plus what it had to leave out. `dropped`
 *  is bookkeeping for the caller, not a Slack field — `toPayload` strips it. */
export interface BuiltMessage extends SlackMessage {
  dropped: number;
}

export const toPayload = (m: BuiltMessage): SlackMessage => ({ text: m.text, blocks: m.blocks });

/**
 * The seam. Implement it wherever the credentials live; nothing in this package
 * ever calls it, and no builder here takes one as an argument — the type system
 * should make "the builder sent something" impossible to write by accident.
 */
export interface SlackTransportPort {
  post(payload: SlackMessage): Promise<{ ok: boolean }>;
}

/* ── block helpers ────────────────────────────────────────────────────────── */

const plain = (text: string): SlackTextObject => ({ type: 'plain_text', text, emoji: false });
const mrkdwn = (text: string): SlackTextObject => ({ type: 'mrkdwn', text });

const header = (text: string): SlackHeaderBlock => ({
  type: 'header',
  text: plain(truncateLine(text, MAX_HEADER_CHARS)),
});

const context = (text: string): SlackContextBlock => ({
  type: 'context',
  elements: [mrkdwn(truncateLine(text, MAX_TEXT_CHARS))],
});

/**
 * Controls for one finding. The dismiss control is a select and never a button,
 * so a reason is structurally required — `recordFeedback` refuses `dismissed`
 * without one, and a UI that can produce an unreasoned dismissal makes that
 * refusal fire on a real human instead of on a developer. Each option value
 * carries the finding id, so the interaction payload alone is a complete
 * feedback event with nothing to look up server-side.
 */
function controlsFor(f: RenderedFinding): SlackActionsBlock {
  return {
    type: 'actions',
    block_id: `finding:${f.id}`,
    elements: [
      { type: 'button', action_id: `open:${f.id}`, text: plain('Open'), url: f.deepLink },
      {
        type: 'button',
        action_id: `acted_on:${f.id}`,
        text: plain('I acted on this'),
        value: `acted_on:${f.id}`,
      },
      {
        type: 'static_select',
        action_id: `dismiss:${f.id}`,
        placeholder: plain('Dismiss — why?'),
        options: ALL_DISMISS_REASONS.map((reason) => ({
          text: plain(dismissMeaning(reason).label),
          value: `dismiss:${reason}:${f.id}`,
        })),
      },
    ],
  };
}

/* ── the digest ───────────────────────────────────────────────────────────── */

export interface DigestMessageInput {
  findings: readonly RenderedFinding[];
  /** Signals examined this run. Present in every message, quiet or not, so the
   *  reader always knows how much work stands behind what they are seeing. */
  checked: number;
  /** Findings held back by the cap or the gate. */
  held?: number;
}

const DIGEST_HEADER = 'Worth your attention this week';

export function buildDigestMessage(input: DigestMessageInput): BuiltMessage {
  // Oversized findings go first, whole. Trimming a finding to fit would cut
  // into cited evidence, and evidence trimmed to fit a chat window is evidence
  // the reader can no longer check.
  const fits = input.findings.filter((f) => f.text.length <= MAX_TEXT_CHARS);
  const kept = fits.slice(0, MAX_FINDINGS_PER_MESSAGE);
  const dropped = input.findings.length - kept.length;

  const blocks: SlackBlock[] = [header(DIGEST_HEADER)];
  for (const f of kept) {
    blocks.push({ type: 'section', text: mrkdwn(f.text) });
    blocks.push(controlsFor(f));
    blocks.push({ type: 'divider' });
  }
  if (kept.length === 0) {
    blocks.push({
      type: 'section',
      text: mrkdwn(
        'Everything selected this week was too large to render in Slack. ' +
          'Nothing was truncated — open the findings list to read them in full.',
      ),
    });
  }

  const parts = [`${input.checked} signals examined`];
  if (input.held !== undefined) parts.push(`${input.held} held below the bar`);
  if (dropped > 0) parts.push(`${dropped} dropped to fit Slack's block limit`);
  blocks.push(context(parts.join(' · ')));

  const message: BuiltMessage = {
    text: `${DIGEST_HEADER} — ${kept.length} finding${kept.length === 1 ? '' : 's'}`,
    blocks,
    dropped,
  };
  assertPayloadClean(message);
  return message;
}

/* ── the quiet week ───────────────────────────────────────────────────────── */

export interface QuietMessageInput {
  /** Nothing has been pushed since this instant. */
  since: string;
  checked: number;
  reason: QuietReason;
  held?: number;
}

const QUIET_HEADER = 'Nothing worth your attention this week';

const QUIET_BODY: Record<QuietReason, string> = {
  nothing_material:
    'Nothing cleared the materiality bar. This is a result, not an outage — the sweep ran and came back empty.',
  weekly_cap_reached:
    'The weekly cap is already spent, and nothing left was urgent enough to exceed it. Held items are waiting in the findings list.',
};

/**
 * Silence, with a receipt — the message this whole design turns on. A system
 * that simply stops posting is indistinguishable from one whose collector died
 * three weeks ago, and the reader learns which at the worst possible moment. So
 * a quiet week is POSTED, says how many signals were examined to reach that
 * silence, and names why: "nothing happened" becomes a claim the reader can
 * evaluate instead of an absence they have to interpret.
 */
export function buildQuietMessage(input: QuietMessageInput): BuiltMessage {
  const parts = [`${input.checked} signals examined since ${input.since}`];
  if (input.held !== undefined) parts.push(`${input.held} held below the bar`);

  const message: BuiltMessage = {
    text: QUIET_HEADER,
    blocks: [
      header(QUIET_HEADER),
      { type: 'section', text: mrkdwn(QUIET_BODY[input.reason]) },
      context(`${parts.join(' · ')}.`),
    ],
    dropped: 0,
  };
  assertPayloadClean(message);
  return message;
}

/** Dispatch on the selection's own shape, so the quiet arm can never be
 *  rendered as an empty digest by a caller that forgot to check `kind`. */
export function buildSlackMessage(
  selection: DigestSelection,
  rendered: readonly RenderedFinding[],
): BuiltMessage {
  if (selection.kind === 'quiet') {
    return buildQuietMessage({
      since: selection.since,
      checked: selection.checked,
      reason: selection.reason,
      held: selection.held.length,
    });
  }
  return buildDigestMessage({
    findings: rendered,
    checked: selection.checked,
    held: selection.held.length,
  });
}

/* ── the guard, on our own output ─────────────────────────────────────────── */

function textsIn(block: SlackBlock): string[] {
  switch (block.type) {
    case 'header':
    case 'section':
      return [block.text.text];
    case 'context':
      return block.elements.map((e) => e.text);
    case 'actions':
      return block.elements.flatMap((e) =>
        e.type === 'button'
          ? [e.text.text]
          : [e.placeholder.text, ...e.options.map((o) => o.text.text)],
      );
    case 'divider':
      return [];
  }
}

/**
 * Run the basis guard over every string that will reach a human.
 *
 * The per-finding render already checked its own text, but this message also
 * contains copy THIS module wrote — headers, footers, control labels — and a
 * rule that only holds for text written elsewhere is not a rule. Cheap enough
 * to run on every build, so it does.
 */
export function assertPayloadClean(message: SlackMessage): void {
  assertNoConfidenceNumber(message.text);
  for (const block of message.blocks) {
    for (const text of textsIn(block)) assertNoConfidenceNumber(text);
  }
}
