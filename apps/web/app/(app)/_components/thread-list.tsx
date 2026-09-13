'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { groupThreads, when, type ThreadSummary } from '@/lib/threads';
import { ResizeHandle, type usePanelWidth } from '@/components/resizable';

type Props = {
  threads: ThreadSummary[];
  activeId: string | null;
  now: number;
  open: boolean;
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  onChanged: () => void;
  panel: ReturnType<typeof usePanelWidth>;
};

const api = (path: string, init?: RequestInit) =>
  fetch(`/api/console/${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });

/**
 * The thread rail. Everything the console's store can do to a thread is one
 * gesture here: open, rename in place, archive (undoable, and the archive view
 * brings it back), delete (armed on first press, done on the second — the spend
 * log keeps its rows either way), and search by title.
 */
export function ThreadList({ threads, activeId, now, open, collapsed, onCollapse, onChanged, panel }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<ThreadSummary[] | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!showArchived) return;
    api('threads?archived=1').then(r => r.json()).then((all: ThreadSummary[]) => setArchived(all.filter(t => t.archivedAt))).catch(() => setArchived([]));
  }, [showArchived, threads]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.hist-menu, .hist .more')) { setMenu(null); setArmed(null); } };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(null); setArmed(null); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [menu]);

  const source = showArchived ? archived ?? [] : threads;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? source.filter(t => t.title.toLowerCase().includes(q)) : source;
  }, [source, query]);

  /** `leaving` is the thread that just disappeared from the list — if it is the open one, go home. */
  async function act(run: () => Promise<Response>, failure: string, after?: () => void, leaving?: string) {
    setError(null);
    const res = await run().catch(() => null);
    if (!res?.ok) { setError(failure); return; }
    setMenu(null); setArmed(null);
    after?.();
    onChanged();
    if (leaving && leaving === activeId) router.push('/');
  }

  const remove = (t: ThreadSummary) => {
    if (armed !== t.id) { setArmed(t.id); return; }
    void act(() => api(`threads/${t.id}`, { method: 'DELETE' }), 'Couldn’t delete that thread. Try again.', () => setArchived(a => a?.filter(x => x.id !== t.id) ?? null), t.id);
  };
  const archive = (t: ThreadSummary, on: boolean) =>
    act(() => api(`threads/${t.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: on }) }),
      on ? 'Couldn’t archive that thread.' : 'Couldn’t restore that thread.', () => { if (!on) setArchived(a => a?.filter(x => x.id !== t.id) ?? null); }, on ? t.id : undefined);

  return (
    <aside className="history" data-open={open} aria-label="Threads">
      <div className="history-head">
        <span className="lab">{showArchived ? 'Archived' : 'Threads'}</span>
        <button className="icon-btn collapse-btn" onClick={() => onCollapse(!collapsed)} aria-label={collapsed ? 'Show threads' : 'Hide threads'} aria-expanded={!collapsed} title={collapsed ? 'Show threads' : 'Hide threads'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M9 4.5v15" />{collapsed ? <path d="m13 10 2 2-2 2" /> : <path d="m15 10-2 2 2 2" />}</svg>
        </button>
      </div>

      {collapsed && (
        <div className="history-rail">
          <Link href="/" className="icon-btn" aria-label="New question" title="New question">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 5v14M5 12h14" /></svg>
          </Link>
          {threads.slice(0, 10).map(t => (
            <Link key={t.id} href={`/t/${t.id}`} className="rail-chat" aria-current={activeId === t.id ? 'page' : undefined} title={t.title} aria-label={t.title}>
              {t.title.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '·'}
            </Link>
          ))}
        </div>
      )}

      <div className="history-tools">
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={showArchived ? 'Search archived' : 'Search threads'} aria-label="Search threads" />
        </div>
      </div>
      {error && <div className="alert history-alert" role="alert">{error}</div>}

      <div className="history-list">
        {filtered.length === 0 && (
          <div className="history-empty">
            {query ? 'No thread matches that.' : showArchived ? (archived === null ? 'Loading…' : 'Nothing archived.') : 'Questions you ask are kept here.'}
          </div>
        )}
        {groupThreads(filtered, now).map(g => (
          <div key={g.label} style={{ display: 'contents' }}>
            {!showArchived && <div className="history-group lab">{g.label}</div>}
            {g.items.map(t => (
              <div key={t.id} className="hist" aria-current={activeId === t.id ? 'page' : undefined} data-menu={menu === t.id}>
                {renaming === t.id ? (
                  <RenameField
                    initial={t.title}
                    onCancel={() => setRenaming(null)}
                    onSave={title => act(() => api(`threads/${t.id}/rename`, { method: 'POST', body: JSON.stringify({ title }) }), 'Couldn’t rename that thread.', () => setRenaming(null))}
                  />
                ) : (
                  <Link href={`/t/${t.id}`} onClick={() => setMenu(null)}>
                    <b>{t.title}</b>
                    <small className="num">{when(t.updatedAt, now)} · {Math.ceil(t.messageCount / 2)} {Math.ceil(t.messageCount / 2) === 1 ? 'question' : 'questions'}{t.forkedFromMessageId ? ' · fork' : ''}</small>
                  </Link>
                )}
                {renaming !== t.id && (
                  <button className="icon-btn more" onClick={() => { setMenu(menu === t.id ? null : t.id); setArmed(null); }} aria-label={`Actions for ${t.title}`} aria-expanded={menu === t.id}>
                    <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
                  </button>
                )}
                {menu === t.id && (
                  <div className="hist-menu" role="menu">
                    {!showArchived && <button role="menuitem" onClick={() => { setRenaming(t.id); setMenu(null); }}>Rename</button>}
                    {showArchived
                      ? <button role="menuitem" onClick={() => archive(t, false)}>Restore</button>
                      : <button role="menuitem" onClick={() => archive(t, true)}>Archive</button>}
                    <button role="menuitem" className="danger" data-armed={armed === t.id} onClick={() => remove(t)}>
                      {armed === t.id ? 'Delete for good?' : 'Delete'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="history-foot">
        <button className="link" onClick={() => { setShowArchived(!showArchived); setQuery(''); }}>
          {showArchived ? '← Back to threads' : 'Archived threads'}
        </button>
      </div>
      {!collapsed && <ResizeHandle label="Resize threads" panel={panel} />}
    </aside>
  );
}

function RenameField({ initial, onSave, onCancel }: { initial: string; onSave: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.select(); }, []);
  const commit = () => { const v = value.trim(); if (!v || v === initial) onCancel(); else onSave(v); };
  return (
    <input
      ref={ref}
      className="rename"
      value={value}
      maxLength={200}
      aria-label="Thread title"
      onChange={e => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') onCancel(); }}
    />
  );
}
