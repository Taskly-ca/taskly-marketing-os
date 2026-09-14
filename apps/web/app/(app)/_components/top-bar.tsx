'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mark } from '@/components/mark';
import { useSpend, useTheme, type Theme } from '@/lib/prefs';

type Props = { active: 'ask' | 'watch'; onToggleHistory?: () => void; onNew?: () => void };

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

export function TopBar({ active, onToggleHistory, onNew }: Props) {
  const router = useRouter();
  const spend = useSpend();
  const [theme, setTheme] = useTheme();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [menu]);

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
    router.refresh();
  }

  const share = spend && spend.limitCents > 0 ? spend.spentCents / spend.limitCents : 0;

  return (
    <header className="top">
      {onToggleHistory && (
        <button className="icon-btn only-narrow" onClick={onToggleHistory} aria-label="Threads">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
        </button>
      )}
      <Link href="/" className="brand"><Mark /><span>Marketing OS</span></Link>
      <nav className="tabs">
        <Link className="tab" href="/" aria-current={active === 'ask' ? 'page' : undefined}>Ask</Link>
        <Link className="tab" href="/watch" aria-current={active === 'watch' ? 'page' : undefined}>Watch</Link>
      </nav>
      <button className="cmd-open hide-sm" onClick={() => window.dispatchEvent(new Event('tmos:command'))} aria-label="Search and commands">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
        <span>Search or jump to…</span><kbd>⌘K</kbd>
      </button>
      <div className="top-right">
        {spend && (
          <span className={`chip spend hide-sm num${spend.killswitch || share >= 0.9 ? ' hot' : ''}`} title={`Spent today (UTC day ${spend.day}) against the daily ceiling of ${dollars(spend.limitCents)}${spend.killswitch ? ' — the killswitch is ON, nothing that spends will run' : ''}`}>
            <span className="spend-bar"><span style={{ width: `${Math.min(100, share * 100)}%` }} /></span>
            {spend.killswitch ? 'Killswitch on' : `${dollars(spend.spentCents)} today`}
          </span>
        )}
        <Link className="btn sm ghost" href="/" onClick={e => { if (onNew) { e.preventDefault(); onNew(); } }}>New question</Link>
        <div className="menu-wrap" ref={menuRef}>
          <button className="icon-btn" onClick={() => setMenu(m => !m)} aria-label="Menu" aria-expanded={menu}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1.2-3.4 3.8-5 7-5s5.8 1.6 7 5" /></svg>
          </button>
          {menu && (
            <div className="pop user-menu" role="menu">
              <div className="lab pop-lab">Signed in as taskly</div>
              {spend && <div className="menu-spend num">{dollars(spend.spentCents)} of {dollars(spend.limitCents)} spent today</div>}
              <div className="menu-row">
                <span>Theme</span>
                <div className="seg mini" role="radiogroup" aria-label="Theme">
                  {(['system', 'light', 'dark'] as Theme[]).map(t => (
                    <button key={t} role="radio" aria-checked={theme === t} aria-pressed={theme === t} onClick={() => setTheme(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>
                  ))}
                </div>
              </div>
              <button role="menuitem" className="menu-item" onClick={() => { setMenu(false); window.dispatchEvent(new Event('tmos:command')); }}>Search and commands <kbd>⌘K</kbd></button>
              <button role="menuitem" className="menu-item" onClick={() => { setMenu(false); window.dispatchEvent(new Event('tmos:shortcuts')); }}>Keyboard shortcuts <kbd>?</kbd></button>
              <a role="menuitem" className="menu-item" href="/?demo=1">Demo replay <span className="muted">no spend</span></a>
              <button role="menuitem" className="menu-item" onClick={signOut}>Sign out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
