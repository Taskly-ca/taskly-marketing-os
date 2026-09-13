'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { MODES, SUGGESTED, newTurn, reduce, replay, type Frame, type Mode, type ThreadDetail, type Turn } from '@/lib/answer';
import type { ThreadSummary } from '@/lib/threads';
import { ResizeHandle, usePanelWidth, useStoredFlag } from '@/components/resizable';
import { Mark } from '@/components/mark';
import { TopBar } from './top-bar';
import { ThreadList } from './thread-list';
import { Composer, ModeIcon } from './composer';
import { TurnView } from './turn-view';
import { Activity } from './activity';

type Props = { threads: ThreadSummary[]; thread: ThreadDetail | null; now: number; consoleDown: boolean };

const EVENTS = ['status', 'source', 'span', 'delta', 'sentence', 'done', 'error_msg', 'epilogue', 'unused', 'plan', 'step', 'reflect', 'clarify'];
const MODE_KEY = 'tmos.mode';

export function Ask({ threads: initialThreads, thread, now, consoleDown }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [threads, setThreads] = useState(initialThreads);
  const [threadId, setThreadId] = useState<string | null>(thread?.id ?? null);
  const [turns, setTurns] = useState<Turn[]>(() => (thread ? replay(thread) : []));
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>('web');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(consoleDown ? 'The research engine isn’t reachable right now. Threads and answers will load once it is back.' : null);
  const [toast, setToast] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [collapsed, setCollapsed] = useStoredFlag('tmos.history.collapsed', false);
  const [pane, setPane] = useState<'answer' | 'activity'>('answer');
  const historyW = usePanelWidth('tmos.width.history', 260, 200, 420);
  const activityW = usePanelWidth('tmos.width.activity', 380, 300, 640);
  const es = useRef<EventSource | null>(null);
  const liveKey = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // A saved thread opens at the top so it reads from the question down; a live answer follows the cursor.
  const pinned = useRef(!thread);

  // Mode is a per-browser preference, read after mount so the first paint matches the server.
  useEffect(() => { try { const m = window.localStorage.getItem(MODE_KEY) as Mode | null; if (m && m in MODES) setModeState(m); } catch { /* private mode */ } }, []);
  const setMode = (m: Mode) => { setModeState(m); try { window.localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ } };

  // A different thread in the URL means a different conversation: stop anything live and load it.
  useEffect(() => {
    if ((thread?.id ?? null) === threadId && turns.length) return;
    es.current?.close(); es.current = null; liveKey.current = null;
    setThreadId(thread?.id ?? null);
    setTurns(thread ? replay(thread) : []);
    setSelected(null);
    setHistoryOpen(false);
    pinned.current = !thread;
    scroller.current?.scrollTo({ top: 0 });
  }, [thread?.id]);

  useEffect(() => () => es.current?.close(), []);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2200); return () => clearTimeout(t); }, [toast]);

  const refreshThreads = useCallback(async () => {
    const res = await fetch('/api/console/threads', { cache: 'no-store' }).catch(() => null);
    if (res?.ok) setThreads(await res.json());
  }, []);

  // Keep the reader at the bottom while an answer writes, unless they scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [turns]);
  const onScroll = () => { const el = scroller.current; if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 220; };

  const update = useCallback((key: string, f: (t: Turn) => Turn) => setTurns(ts => ts.map(t => (t.key === key ? f(t) : t))), []);

  const run = useCallback((turn: Turn, continueThread: string | null) => {
    es.current?.close();
    const params = new URLSearchParams({ q: turn.question, mode: turn.mode });
    if (continueThread) params.set('thread', continueThread);
    for (const a of turn.answers ?? []) params.append('a', a.slice(0, 500));
    const source = new EventSource(`/api/console/answer?${params}`);
    es.current = source;
    liveKey.current = turn.key;
    let frames = 0;
    let ended = false;

    for (const name of EVENTS) {
      source.addEventListener(name, (e: MessageEvent<string>) => {
        frames++;
        let data: unknown = e.data;
        try { data = JSON.parse(e.data); } catch { /* a bare string */ }
        const frame: Frame = { event: name, data };
        update(turn.key, t => (t.stopped ? t : reduce(t, frame)));
        if (name === 'done') {
          ended = true; source.close(); es.current = null; liveKey.current = null;
          const d = data as { threadId?: string | null };
          if (d.threadId) {
            setThreadId(d.threadId);
            if (!pathname.startsWith(`/t/${d.threadId}`)) window.history.replaceState(null, '', `/t/${d.threadId}`);
          }
          void refreshThreads();
        }
        if (name === 'error_msg' || name === 'clarify') { ended = true; source.close(); es.current = null; liveKey.current = null; void refreshThreads(); }
      });
    }
    source.onerror = () => {
      if (ended) return;
      source.close(); es.current = null; liveKey.current = null;
      update(turn.key, t => (t.live && !t.stopped ? reduce(t, {
        event: 'error_msg',
        data: frames === 0 ? 'Couldn’t reach the research engine. Check that it is running, then ask again.' : 'The connection dropped mid-answer. Everything above arrived; the rest did not.',
      }) : t));
    };
  }, [pathname, refreshThreads, update]);

  const ask = useCallback((question: string, askMode: Mode = mode) => {
    const q = question.trim();
    if (liveKey.current) { setToast('Still working on the last one'); return; }
    if (q.length < 8) { setError('Ask a fuller question — a few words can’t be turned into a search.'); return; }
    setError(null);
    const turn = newTurn(q, askMode);
    setTurns(ts => [...ts, turn]);
    setSelected(turn.key);
    setDraft('');
    pinned.current = true;
    run(turn, threadId);
  }, [mode, run, threadId]);

  const startAfterClarify = (turn: Turn, answers: string[]) => {
    const rerun: Turn = { ...newTurn(turn.question, turn.mode, answers.map(a => a.trim())), asked: turn.clarify?.questions ?? [] };
    rerun.key = turn.key;
    setTurns(ts => ts.map(t => (t.key === turn.key ? rerun : t)));
    setSelected(turn.key);
    run(rerun, threadId);
  };

  const stop = () => {
    const key = liveKey.current;
    if (!key) return;
    es.current?.close(); es.current = null; liveKey.current = null;
    update(key, t => ({ ...t, live: false, stopped: true, doneAt: Date.now() }));
    setToast('Stopped — nothing more will be shown for this run');
  };

  const fork = async (turn: Turn) => {
    if (!threadId || !turn.messageId) { setToast('Nothing to fork yet — this answer was never saved'); return; }
    let seq = turn.seq;
    if (!seq) {
      const detail = await fetch(`/api/console/threads/${threadId}`).then(r => (r.ok ? r.json() as Promise<ThreadDetail> : null)).catch(() => null);
      seq = detail?.messages.find(m => m.id === turn.messageId)?.seq;
    }
    if (!seq) { setToast('Couldn’t find that answer in the saved thread'); return; }
    const res = await fetch(`/api/console/threads/${threadId}/fork`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seq }) }).catch(() => null);
    if (!res?.ok) { setToast('Couldn’t fork this thread. Try again.'); return; }
    const forked = (await res.json()) as { id: string };
    await refreshThreads();
    setToast('Forked at this answer — the original thread is untouched');
    router.push(`/t/${forked.id}`);
  };

  const newQuestion = () => {
    es.current?.close(); es.current = null; liveKey.current = null;
    setTurns([]); setThreadId(null); setSelected(null); setError(null); setPane('answer');
    if (window.location.pathname !== '/') router.push('/');
    setTimeout(() => document.getElementById('question')?.focus(), 50);
  };

  const running = !!turns.find(t => t.live);
  const activeTurn = turns.find(t => t.key === selected) ?? turns.findLast(t => !t.stored) ?? turns.at(-1) ?? null;
  const empty = turns.length === 0;

  return (
    <>
      <TopBar active="ask" onToggleHistory={() => setHistoryOpen(o => !o)} onNew={newQuestion} />
      <div className="pane-switch">
        <div className="seg">
          <button aria-pressed={pane === 'answer'} onClick={() => setPane('answer')}>Answer</button>
          <button aria-pressed={pane === 'activity'} onClick={() => setPane('activity')}>Activity{running ? ' •' : ''}</button>
        </div>
      </div>
      <div className="ask" data-pane={pane} data-collapsed={collapsed}
        style={{ '--w-history': collapsed ? '56px' : `${historyW.width}px`, '--w-activity': `${activityW.width}px` } as React.CSSProperties}>
        <ThreadList threads={threads} activeId={threadId} now={now} open={historyOpen} collapsed={collapsed} onCollapse={setCollapsed} onChanged={refreshThreads} panel={historyW} />
        {historyOpen && <div className="scrim only-narrow" onClick={() => setHistoryOpen(false)} />}

        <section className="convo" aria-label="Conversation">
          <div className="convo-scroll" ref={scroller} onScroll={onScroll}>
            {empty ? (
              <div className="hero">
                <Mark />
                <div className="eyebrow">Marketing OS</div>
                <h1>Ask it anything.</h1>
                <p>{MODES[mode].sub}</p>
                <div className="hero-composer">
                  <Composer mode={mode} onMode={setMode} onSubmit={q => ask(q)} running={running} followUp={false} error={error} value={draft} onValue={setDraft} autoFocus />
                </div>
                <div className="starters">
                  {SUGGESTED[mode].map(s => (
                    <button key={s} className="starter" onClick={() => ask(s)}>
                      <ModeIcon mode={mode} /><span>{s}</span>
                      <svg className="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="turns">
                {turns.map(t => (
                  <TurnView
                    key={t.key}
                    turn={t}
                    selected={activeTurn?.key === t.key}
                    canFork={!!threadId && !!t.messageId && !t.live}
                    onSelect={() => { setSelected(t.key); setPane('activity'); }}
                    onAsk={q => ask(q, t.mode)}
                    onFork={() => fork(t)}
                    onClarify={answers => startAfterClarify(t, answers)}
                    onFocusComposer={() => document.getElementById('question')?.focus()}
                    onToast={setToast}
                  />
                ))}
              </div>
            )}
          </div>
          {!empty && (
            <div className="convo-foot">
              <Composer mode={mode} onMode={setMode} onSubmit={q => ask(q)} onStop={stop} running={running} followUp error={error} value={draft} onValue={setDraft} />
            </div>
          )}
        </section>

        <aside className="side-activity" aria-label="Activity">
          <ResizeHandle label="Resize activity" panel={activityW} side="left" />
          <Activity turn={activeTurn} onStop={stop} onToast={setToast} onClose={() => setPane('answer')} />
        </aside>
      </div>
      {toast && <div className="toast" role="status" aria-live="polite">{toast}</div>}
    </>
  );
}
