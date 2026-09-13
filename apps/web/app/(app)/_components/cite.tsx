'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { KIND_INFO, safeUrl, sourceForCite, type Sentence, type Turn } from '@/lib/answer';

const VERDICT: Record<Sentence['verdict'], [string, string]> = {
  pending: ['Checking', 'This sentence is still being checked against the quote.'],
  confirmed: ['Confirmed', 'Every figure in this sentence appears in the quoted span.'],
  flagged: ['Unconfirmed', 'The checker could not match this sentence to its quote. That is not the same as false — read the quote.'],
  stored: ['Saved', 'Checks run live; a saved answer keeps its quotes but not the per-sentence verdicts.'],
};

type Props = { turn: Turn; n: number; verdict: Sentence['verdict']; onToast: (m: string) => void };

/** A citation marker. Hover or focus shows the quote; click opens the page, or copies the locator for our own records. */
export function Cite({ turn, n, verdict, onToast }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const { source } = sourceForCite(turn, n);
  const kind = source?.kind ?? 'web';
  const info = KIND_INFO[kind];
  const url = source ? safeUrl(source.url) : null;

  const activate = async () => {
    if (url && info.linkable) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
    if (source) {
      try { await navigator.clipboard.writeText(source.url); onToast(`Copied — ${source.url}`); } catch { onToast('Could not copy'); }
      return;
    }
    onToast('The source for that citation has not arrived yet');
  };

  return (
    <sup
      ref={ref}
      className={`cb k-${kind} v-${verdict}`}
      role="button"
      tabIndex={0}
      aria-label={`Citation ${n}, from ${info.says}, ${VERDICT[verdict][0].toLowerCase()}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={activate}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void activate(); } if (e.key === 'Escape') setOpen(false); }}
    >
      {kind === 'brain' || kind === 'ledger' ? info.glyph : ''}{n}
      {open && <CitePop anchor={ref} turn={turn} n={n} verdict={verdict} />}
    </sup>
  );
}

function CitePop({ anchor, turn, n, verdict }: { anchor: React.RefObject<HTMLElement | null>; turn: Turn; n: number; verdict: Sentence['verdict'] }) {
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const { source, span } = sourceForCite(turn, n);
  const kind = source?.kind ?? 'web';
  const info = KIND_INFO[kind];
  const url = source ? safeUrl(source.url) : null;

  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const p = pop.current?.getBoundingClientRect();
    if (!a || !p) return;
    const below = a.top - p.height - 10 < 12;
    const left = Math.min(Math.max(12, a.left + a.width / 2 - p.width / 2), window.innerWidth - p.width - 12);
    setPos({ left, top: below ? a.bottom + 8 : a.top - p.height - 8, below });
  }, [anchor]);

  return (
    <div ref={pop} className="cite-pop" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}>
      <div className="cite-src">
        <span className={`kind-dot k-${kind}`}>{info.glyph}</span>
        <span className="cite-domain">{source ? (kind === 'brain' ? 'Taskly Brain' : kind === 'ledger' ? 'Prediction ledger' : source.domain) : 'Source'}</span>
        {source?.observedAt && <span className="cite-date num">{kind === 'ledger' ? 'Recorded' : 'Read'} {source.observedAt.slice(0, 10)}</span>}
      </div>
      <b className="cite-title">{source?.title || 'Source not yet received'}</b>
      <blockquote>{span ? `“${span.quote}”` : 'The quoted span for this marker has not arrived yet.'}</blockquote>
      <div className={`cite-verdict v-${verdict}`}><b>{VERDICT[verdict][0]}</b> {VERDICT[verdict][1]}</div>
      <div className="cite-act">
        {url && info.linkable ? `Click to open ${source?.domain} ↗${kind === 'world' ? ' — their page as it stands today' : ''}` : source ? 'No link — our own record. Click to copy where it lives.' : ''}
      </div>
    </div>
  );
}
