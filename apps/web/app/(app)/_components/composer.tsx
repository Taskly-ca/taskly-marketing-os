'use client';

import { useEffect, useRef, useState } from 'react';
import { MODE_ORDER, MODES, type Mode } from '@/lib/answer';

type Props = {
  mode: Mode;
  onMode: (m: Mode) => void;
  onSubmit: (q: string) => void;
  onStop?: () => void;
  running: boolean;
  followUp: boolean;
  error: string | null;
  value: string;
  onValue: (v: string) => void;
  autoFocus?: boolean;
};

/** One composer for both the first question and follow-ups. Enter asks, Shift+Enter is a new line. */
export function Composer({ mode, onMode, onSubmit, onStop, running, followUp, error, value, onValue, autoFocus }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const submit = () => { if (!running && value.trim()) onSubmit(value.trim()); };

  return (
    <div className="composer">
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="box">
        <textarea
          id="question"
          ref={ref}
          rows={1}
          value={value}
          autoFocus={autoFocus}
          placeholder={running ? 'Working…' : followUp ? 'Ask a follow-up…' : MODES[mode].placeholder}
          aria-label="Question"
          onChange={e => onValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
        />
        <div className="box-row">
          <div className="mode-pick" ref={pop}>
            <button type="button" className="pick" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open} title={MODES[mode].about}>
              <ModeIcon mode={mode} /><b>{MODES[mode].name}</b>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {open && (
              <div className="pop pop-modes" role="listbox" aria-label="How to answer">
                <div className="lab pop-lab">How to answer</div>
                {MODE_ORDER.map(m => (
                  <button key={m} role="option" aria-selected={m === mode} className="mode-opt" onClick={() => { onMode(m); setOpen(false); ref.current?.focus(); }}>
                    <ModeIcon mode={m} />
                    <span><b>{MODES[m].name}</b><small>{MODES[m].about}</small></span>
                    <svg className="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m5 12 5 5 9-10" /></svg>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="mode-hint hide-sm">{MODES[mode].short}</span>
          <div className="send">
            {running && onStop ? (
              <button type="button" className="go stop" onClick={onStop} aria-label="Stop showing this run" title="Stop showing this run">
                <svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
              </button>
            ) : (
              <button type="button" className="go" onClick={submit} disabled={running || !value.trim()} aria-label="Ask">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ModeIcon({ mode }: { mode: Mode }) {
  const p = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, className: 'mode-icon', 'aria-hidden': true } as const;
  if (mode === 'web') return <svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z" /></svg>;
  if (mode === 'grounded') return <svg {...p}><path d="M4 7.5 12 4l8 3.5-8 3.5-8-3.5z" /><path d="m4 12 8 3.5 8-3.5M4 16.5 12 20l8-3.5" /></svg>;
  if (mode === 'verified') return <svg {...p}><path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-2.5z" /><path d="m8.8 12 2.2 2.2 4.3-4.4" /></svg>;
  return <svg {...p}><path d="M5 5h9M5 10h14M5 15h9M5 20h14" /><circle cx="18" cy="5" r="1.4" /><circle cx="18" cy="15" r="1.4" /></svg>;
}
