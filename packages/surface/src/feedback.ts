/**
 * Feedback capture, and the dismissal taxonomy that makes it useful.
 *
 * "Not useful" is not a signal — it cannot be routed anywhere. The five reasons
 * below are chosen because each one points at a DIFFERENT part of the system,
 * so a dismissal is a bug report addressed to a specific component rather than
 * a vote. That routing is the entire justification for making a human pick from
 * a list instead of typing a sentence.
 *
 * Mirrors `finding_feedback.dismiss_reason` in migration 003.
 */
import type { Basis } from '@tmos/contracts';

export type FeedbackAction = 'viewed' | 'saved' | 'dismissed' | 'acted_on';

export type DismissReason = 'wrong' | 'obvious' | 'not_actionable' | 'stale' | 'bad_source';

export interface DismissMeaning {
  reason: DismissReason;
  /** What the reader is told they are saying. */
  label: string;
  /** Which component this is a bug report ABOUT. */
  blames: 'verification' | 'novelty' | 'domain_scoring' | 'freshness' | 'source_tiering';
  /** What the system should do differently next time. */
  correction: string;
  /**
   * True when a dismissal implies the finding should never have shipped, as
   * opposed to being a legitimate finding this reader did not need. The
   * distinction matters: one is a defect, the other is personalisation, and
   * conflating them makes the system quieter without making it better.
   */
  isDefect: boolean;
}

const MEANINGS: Record<DismissReason, Omit<DismissMeaning, 'reason'>> = {
  wrong: {
    label: 'This is wrong',
    blames: 'verification',
    correction:
      'The verification ladder passed something false. Re-check L0/L1 on this finding and add it to the regression corpus.',
    isDefect: true,
  },
  obvious: {
    label: 'We already knew this',
    blames: 'novelty',
    correction:
      'T2 classified as new what was actually restated. Check the entity history diff — this is the highest-volume waste in the pipeline.',
    isDefect: true,
  },
  not_actionable: {
    label: 'Nothing we would do differently',
    blames: 'domain_scoring',
    correction:
      'Materiality scored this above the gate but it changes no decision. The so_what was weak or the domain prior is mis-weighted.',
    isDefect: true,
  },
  stale: {
    label: 'Too late to matter',
    blames: 'freshness',
    correction:
      'True and useless — we found it after the window closed. A latency problem in collection or scheduling, not a quality one.',
    isDefect: true,
  },
  bad_source: {
    label: 'I do not trust this source',
    blames: 'source_tiering',
    correction:
      'The source tier is too generous, or copy-chain collapse missed a chain. Re-tier the source.',
    isDefect: true,
  },
};

export const dismissMeaning = (reason: DismissReason): DismissMeaning => ({
  reason,
  ...MEANINGS[reason],
});

export const ALL_DISMISS_REASONS: readonly DismissReason[] = [
  'wrong',
  'obvious',
  'not_actionable',
  'stale',
  'bad_source',
];

export interface FeedbackEvent {
  findingId: string;
  actor: string;
  action: FeedbackAction;
  dismissReason: DismissReason | null;
  at: string;
}

export type FeedbackResult = { ok: true; event: FeedbackEvent } | { ok: false; reason: string };

const ACTOR_RE = /^(human:[\w.-]+|agent:[\w./-]+@[\w.-]+)$/;

/**
 * Build a feedback event.
 *
 * A dismissal WITHOUT a reason is refused. That is a deliberate friction: an
 * unreasoned dismissal teaches the system nothing, and a dismiss button that
 * silently accepts one trains everybody to use it. If the reader genuinely
 * cannot say why, `viewed` is the honest record.
 */
export function recordFeedback(input: {
  findingId: string;
  actor: string;
  action: FeedbackAction;
  dismissReason?: DismissReason | null;
  at: string;
}): FeedbackResult {
  if (!ACTOR_RE.test(input.actor)) {
    return {
      ok: false,
      reason: `actor must be human:<id> or agent:<model>@<version>, got "${input.actor}"`,
    };
  }
  if (input.action === 'dismissed' && !input.dismissReason) {
    return {
      ok: false,
      reason:
        'a dismissal needs a reason — an unreasoned dismissal routes nowhere and teaches the system nothing. Record "viewed" instead.',
    };
  }
  if (input.action !== 'dismissed' && input.dismissReason) {
    return {
      ok: false,
      reason: `dismissReason is only meaningful for a dismissal, not for "${input.action}"`,
    };
  }
  return {
    ok: true,
    event: {
      findingId: input.findingId,
      actor: input.actor,
      action: input.action,
      dismissReason: input.dismissReason ?? null,
      at: input.at,
    },
  };
}

/**
 * Aggregate dismissals into what should actually change.
 *
 * Deliberately returns COUNTS per blamed component rather than a quality score.
 * A single number ("72% useful") is exactly the kind of figure that gets
 * reported upward and acted on by nobody, because it names no owner.
 */
export function dismissalPressure(events: readonly FeedbackEvent[]): Array<{
  blames: DismissMeaning['blames'];
  count: number;
  reasons: DismissReason[];
  correction: string;
}> {
  const byComponent = new Map<
    DismissMeaning['blames'],
    { count: number; reasons: Set<DismissReason>; correction: string }
  >();
  for (const e of events) {
    if (e.action !== 'dismissed' || !e.dismissReason) continue;
    const m = dismissMeaning(e.dismissReason);
    const cur = byComponent.get(m.blames) ?? {
      count: 0,
      reasons: new Set(),
      correction: m.correction,
    };
    cur.count += 1;
    cur.reasons.add(e.dismissReason);
    byComponent.set(m.blames, cur);
  }
  return [...byComponent.entries()]
    .map(([blames, v]) => ({
      blames,
      count: v.count,
      reasons: [...v.reasons].sort(),
      correction: v.correction,
    }))
    .sort((a, b) => b.count - a.count || a.blames.localeCompare(b.blames));
}

/**
 * A finding that was acted on is the only unambiguous success signal we get.
 * `saved` is weaker — it often means "interesting, not now" — and `viewed`
 * means almost nothing, since a push is seen whether or not it was wanted.
 */
export function outcomeWeight(action: FeedbackAction): number {
  switch (action) {
    case 'acted_on':
      return 1;
    case 'saved':
      return 0.3;
    case 'dismissed':
      return 0;
    case 'viewed':
      return 0;
  }
}

/** Bases whose findings deserve extra scrutiny when dismissed as `wrong`: a
 *  governed query returning a wrong answer is a far more serious defect than an
 *  exploratory note being wrong, and must not be averaged in with it. */
export const wrongnessIsSevere = (basis: Basis): boolean =>
  basis === 'verified_metric' || basis === 'governed_query';
