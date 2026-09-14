'use client';

import { useEffect, useState } from 'react';

/** Per-browser preferences. Read after mount (the server has no storage), written best-effort. */
export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'tmos.theme';

function readTheme(): Theme {
  try { const t = window.localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; }
}

export function applyTheme(t: Theme) {
  try { if (t === 'system') window.localStorage.removeItem(THEME_KEY); else window.localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  window.dispatchEvent(new CustomEvent('tmos:theme', { detail: t }));
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    setTheme(readTheme());
    const on = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener('tmos:theme', on);
    return () => window.removeEventListener('tmos:theme', on);
  }, []);
  return [theme, applyTheme];
}

/** Today's spend against the daily ceiling, refreshed on focus, every minute, and when a run finishes. */
type Spend = { day: string; spentCents: number; limitCents: number; killswitch: boolean };

export function useSpend(): Spend | null {
  const [spend, setSpend] = useState<Spend | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/console/spend', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() as Promise<Spend> : null)).then(s => { if (alive && s) setSpend(s); }).catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    window.addEventListener('focus', load);
    window.addEventListener('tmos:spent', load);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', load); window.removeEventListener('tmos:spent', load); };
  }, []);
  return spend;
}
