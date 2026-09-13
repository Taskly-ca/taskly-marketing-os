'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Mark } from '@/components/mark';

type Props = { active: 'ask' | 'watch'; onToggleHistory?: () => void; onNew?: () => void; spend?: { usd: number; limit: number } | null };

export function TopBar({ active, onToggleHistory, onNew, spend }: Props) {
  const router = useRouter();
  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
    router.refresh();
  }
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
      <div className="top-right">
        {spend && <span className="chip hide-sm num" title={`Daily ceiling $${spend.limit.toFixed(0)}`}>${spend.usd.toFixed(2)} today</span>}
        <Link className="btn sm ghost" href="/" onClick={e => { if (onNew) { e.preventDefault(); onNew(); } }}>New question</Link>
        <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" /></svg>
        </button>
      </div>
    </header>
  );
}
