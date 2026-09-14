'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { MODES, MODE_ORDER, type Mode } from '@/lib/answer';
import { TABS } from '@/lib/watch';
import type { ThreadSummary } from '@/lib/threads';
import { applyTheme, type Theme } from '@/lib/prefs';

type Item = { id: string; group: string; label: string; hint?: string; keys?: string; run: () => void };

const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/**
 * ⌘K — jump to any thread or section, change the answer mode or theme, start a
 * demo. Plus the single-key shortcuts, which only fire when you are not typing:
 * `/` focuses the question box, `?` opens the shortcut list.
 */
export function CommandMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = useCallback(() => { setOpen(false); setQ(''); setActive(0); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setHelp(false); setOpen(o => !o); return; }
      if (e.key === 'Escape') { if (open) close(); if (help) setHelp(false); return; }
      if (open || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { const box = document.getElementById('question'); if (box) { e.preventDefault(); box.focus(); } }
      if (e.key === '?') { e.preventDefault(); setHelp(h => !h); }
    };
    const onOpen = () => { setHelp(false); setOpen(true); };
    const onHelp = () => { setOpen(false); setHelp(true); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('tmos:command', onOpen);
    window.addEventListener('tmos:shortcuts', onHelp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('tmos:command', onOpen); window.removeEventListener('tmos:shortcuts', onHelp); };
  }, [open, help, close]);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => input.current?.focus(), 0);
    fetch('/api/console/threads', { cache: 'no-store' }).then(r => (r.ok ? r.json() : [])).then(setThreads).catch(() => setThreads([]));
  }, [open]);

  const go = useCallback((href: string) => { close(); router.push(href); }, [close, router]);
  const onAsk = pathname === '/' || pathname.startsWith('/t/');

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [
      { id: 'new', group: 'Actions', label: 'New question', keys: '', run: () => { close(); if (onAsk) window.dispatchEvent(new Event('tmos:new')); else router.push('/'); } },
      { id: 'ask', group: 'Go to', label: 'Ask', run: () => go('/') },
      ...TABS.map(t => ({ id: `watch-${t.id}`, group: 'Go to', label: `Watch · ${t.name}`, run: () => go(`/watch?tab=${t.id}`) })),
      ...MODE_ORDER.map((m: Mode) => ({ id: `mode-${m}`, group: 'Answer mode', label: `Answer in ${MODES[m].name} mode`, hint: MODES[m].short, run: () => { close(); if (onAsk) window.dispatchEvent(new CustomEvent('tmos:mode', { detail: m })); else router.push(`/?mode=${m}`); } })),
      ...(['system', 'light', 'dark'] as Theme[]).map(t => ({ id: `theme-${t}`, group: 'Theme', label: `Theme: ${t[0]!.toUpperCase()}${t.slice(1)}`, run: () => { applyTheme(t); close(); } })),
      ...(['web', 'grounded', 'deep'] as Mode[]).map(m => ({ id: `demo-${m}`, group: 'Demo replays', label: `Replay a ${MODES[m].name.toLowerCase()} run`, hint: 'Scripted — no server, no spend', run: () => { close(); window.location.href = `/?demo=1&mode=${m}`; } })),
      { id: 'keys', group: 'Help', label: 'Keyboard shortcuts', keys: '?', run: () => { close(); setHelp(true); } },
    ];
    const threadItems: Item[] = threads.map(t => ({ id: `t-${t.id}`, group: 'Threads', label: t.title, run: () => go(`/t/${t.id}`) }));
    const needle = q.trim().toLowerCase();
    if (!needle) return [...out.slice(0, 1), ...threadItems.slice(0, 5), ...out.slice(1)];
    return [...threadItems, ...out].filter(i => `${i.group} ${i.label} ${i.hint ?? ''}`.toLowerCase().includes(needle)).slice(0, 40);
  }, [threads, q, close, go, onAsk, router]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  return (
    <>
      {open && (
        <div className="cmd-scrim" onMouseDown={close}>
          <div className="cmd" role="dialog" aria-modal="true" aria-label="Command menu" onMouseDown={e => e.stopPropagation()}>
            <div className="cmd-input">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
              <input
                ref={input}
                value={q}
                placeholder="Search threads, sections and actions…"
                aria-label="Search"
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(items.length - 1, a + 1)); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
                  if (e.key === 'Enter') { e.preventDefault(); items[active]?.run(); }
                }}
              />
              <kbd>esc</kbd>
            </div>
            <div className="cmd-list" ref={list} role="listbox">
              {items.length === 0 && <div className="cmd-empty">Nothing matches that.</div>}
              {items.map((it, i) => (
                <div key={it.id} style={{ display: 'contents' }}>
                  {(i === 0 || items[i - 1]!.group !== it.group) && <div className="cmd-group lab">{it.group}</div>}
                  <button role="option" aria-selected={i === active} data-active={i === active} className="cmd-item" onMouseMove={() => setActive(i)} onClick={it.run}>
                    <span className="cmd-label">{it.label}</span>
                    {it.hint && <span className="cmd-hint">{it.hint}</span>}
                    {it.keys && <kbd>{it.keys}</kbd>}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {help && (
        <div className="cmd-scrim" onMouseDown={() => setHelp(false)}>
          <div className="cmd keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={e => e.stopPropagation()}>
            <div className="keys-head"><h3>Keyboard shortcuts</h3><button className="icon-btn" onClick={() => setHelp(false)} aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 6l12 12M18 6 6 18" /></svg></button></div>
            <dl>
              {[
                [`${MOD} K`, 'Search threads, sections and actions'],
                ['/', 'Put the cursor in the question box'],
                ['Enter', 'Ask'],
                ['Shift Enter', 'New line in the question'],
                ['?', 'Show this list'],
                ['Esc', 'Close a menu or card'],
                ['Enter / Space on a citation', 'Open its page, or copy where it lives'],
                [`${MOD} Enter`, 'Run a Research question on Watch'],
              ].map(([k, v]) => <div key={k}><dt>{k!.split(' ').map((x, i) => <kbd key={i}>{x}</kbd>)}</dt><dd>{v}</dd></div>)}
            </dl>
          </div>
        </div>
      )}
    </>
  );
}
