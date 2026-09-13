'use client';

import { useCallback, useEffect, useState } from 'react';
import { TABS, type ConsoleState, type Question, type RunStatus, type Tab } from '@/lib/watch';
import { TopBar } from '../../_components/top-bar';
import { RunPanel } from './run-panel';
import { ChangedPanel, CompetitorsPanel, ForecastsPanel, SourcesPanel } from './panels';
import { WeekPanel, ResearchPanel } from './streams';



type Props = { state: ConsoleState | null; questions: Question[] | null; status: RunStatus | null; initialTab: Tab };

export function Watch({ state: initialState, questions: initialQuestions, status, initialTab }: Props) {
  const [tab, setTabState] = useState<Tab>(initialTab);
  const [state, setState] = useState(initialState);
  const [questions, setQuestions] = useState(initialQuestions);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(initialState ? null : 'The engine isn’t reachable right now. Try Refresh in a moment.');

  const setTab = (t: Tab) => {
    setTabState(t);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', t);
    window.history.replaceState(null, '', url);
  };

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const [s, q] = await Promise.all([
      fetch('/api/console/state', { cache: 'no-store' }).then(r => (r.ok ? r.json() as Promise<ConsoleState> : null)).catch(() => null),
      fetch('/api/console/questions', { cache: 'no-store' }).then(r => (r.ok ? r.json() as Promise<Question[]> : null)).catch(() => null),
    ]);
    if (s) { setState(s); setError(null); } else setError('Couldn’t refresh — the engine didn’t answer.');
    if (q) setQuestions(q);
    setRefreshing(false);
  }, []);

  useEffect(() => { if (!initialState) void refresh(); }, [initialState, refresh]);

  const counts: Partial<Record<Tab, number>> = state ? {
    changed: state.findings.length,
    competitors: new Set(state.facts.map(f => f.company)).size,
    forecasts: state.preds.length,
    sources: state.sources.filter(s => s.health === 'needs_operator').length,
  } : {};

  return (
    <>
      <TopBar active="watch" />
      <div className="watch">
        <nav className="watch-nav" aria-label="Sections">
          <div className="lab watch-nav-lab">Watch</div>
          {TABS.map(t => (
            <button key={t.id} className="watch-tab" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"><path d={t.icon} /></svg>
              <span>{t.name}</span>
              {counts[t.id] ? <b className={t.id === 'sources' ? 'n attention' : 'n'}>{counts[t.id]}</b> : null}
            </button>
          ))}
          {state && (
            <div className="watch-stats">
              <div className="lab">On record</div>
              <dl>
                <div><dt>Facts</dt><dd className="num">{state.counts.facts}</dd></div>
                <div><dt>Entities</dt><dd className="num">{state.counts.entities}</dd></div>
                <div><dt>Findings</dt><dd className="num">{state.counts.findings}</dd></div>
                <div><dt>Signals</dt><dd className="num">{state.counts.signals}</dd></div>
                <div><dt>Model calls</dt><dd className="num">{state.counts.calls}</dd></div>
                <div><dt>Spent</dt><dd className="num">{Number(state.counts.cents ?? 0).toFixed(2)}¢</dd></div>
              </dl>
              <button className="link" onClick={refresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
            </div>
          )}
        </nav>

        <main className="watch-main">
          <div className="watch-inner">
            {error && <div className="alert" role="alert">{error}</div>}
            {/* Kept mounted so a draft or an answer survives switching tabs — neither is saved anywhere. */}
            <WeekPanel hidden={tab !== 'week'} />
            <ResearchPanel hidden={tab !== 'research'} />
            {tab === 'changed' && <ChangedPanel findings={state?.findings ?? null} />}
            {tab === 'competitors' && <CompetitorsPanel facts={state?.facts ?? null} />}
            {tab === 'forecasts' && <ForecastsPanel preds={state?.preds ?? null} questions={questions} onSaved={refresh} />}
            {tab === 'sources' && <SourcesPanel sources={state?.sources ?? null} />}
          </div>
        </main>

        <aside className="watch-run" aria-label="Runs">
          <RunPanel initial={status} onFinished={refresh} />
        </aside>
      </div>
    </>
  );
}

export function PanelHead({ title, lead, right }: { title: string; lead: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="panel-head">
      <div><h1>{title}</h1><p>{lead}</p></div>
      {right && <div className="panel-head-right">{right}</div>}
    </header>
  );
}
