'use client';

import { useEffect, useRef, useState } from 'react';
import { STAGES, STAGE_INFO, lineClass, type RunStatus, type Stage } from '@/lib/watch';

type Props = { initial: RunStatus | null; onFinished: () => void };
type RunState = 'idle' | 'running' | 'ok' | 'failed' | 'disconnected';

const FREE_KEY = 'tmos.run.free';
const RULE = '\u0000rule';

/** The worker frames sections with rows of ━ and blank lines; draw a rule once and drop runs of blanks. */
function tidy(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const next = /^\s*━{8,}\s*$/.test(l) ? RULE : l;
    const prev = out.at(-1);
    if (next === RULE && prev === RULE) continue;
    if (next.trim() === '' && (prev === undefined || prev.trim() === '' || prev === RULE)) continue;
    out.push(next);
  }
  return out;
}

/**
 * Runs a pass and shows its log as it prints. A second run is refused by the
 * console while one is in flight — two interleaved passes can lose a real
 * competitor change — so every run button disables while one is going, in
 * this tab and, via the status check on load, in any other.
 */
export function RunPanel({ initial, onFinished }: Props) {
  const [stage, setStage] = useState<Stage | null>(initial?.running ? initial.stage : null);
  const [state, setState] = useState<RunState>(initial?.running ? 'running' : 'idle');
  const [lines, setLines] = useState<string[]>(initial?.running ? initial.lines : []);
  const [free, setFree] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(initial?.running ? Date.now() : null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [choose, setChoose] = useState(false);
  const es = useRef<EventSource | null>(null);
  const log = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => { try { setFree(window.localStorage.getItem(FREE_KEY) === '1'); } catch { /* private mode */ } }, []);
  const toggleFree = (v: boolean) => { setFree(v); try { window.localStorage.setItem(FREE_KEY, v ? '1' : '0'); } catch { /* private mode */ } };

  const attach = () => {
    es.current?.close();
    setLines([]);
    const source = new EventSource('/api/console/stream');
    es.current = source;
    source.addEventListener('line', (e: MessageEvent<string>) => {
      let line = e.data;
      try { line = JSON.parse(e.data) as string; } catch { /* raw */ }
      setLines(l => [...l, line]);
    });
    source.addEventListener('end', (e: MessageEvent<string>) => {
      const code = Number(e.data);
      setState(code === 0 ? 'ok' : 'failed');
      setEndedAt(Date.now());
      source.close(); es.current = null;
      onFinished();
    });
    source.onerror = () => { source.close(); es.current = null; setEndedAt(Date.now()); setState(s => (s === 'running' ? 'disconnected' : s)); };
  };

  useEffect(() => {
    if (initial?.running) attach();
    return () => es.current?.close();
  }, []);

  useEffect(() => {
    if (state !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state]);

  useEffect(() => { const el = log.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [lines]);

  const start = async (s: Stage) => {
    setChoose(false);
    setError(null);
    const res = await fetch('/api/console/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage: s, free }) }).catch(() => null);
    if (!res?.ok) { setError(res ? await res.text() : 'Couldn’t reach the engine.'); return; }
    setStage(s); setState('running'); setStartedAt(Date.now()); setEndedAt(null); setNow(Date.now());
    attach();
  };

  const stop = async () => { await fetch('/api/console/stop', { method: 'POST' }).catch(() => null); };

  const running = state === 'running';
  const failedLines = lines.filter(l => lineClass(l) === 'bad').length;
  const elapsed = startedAt ? Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000)) : 0;
  const label = { idle: 'Idle', running: 'Running', ok: 'Finished', failed: 'Finished with errors', disconnected: 'Disconnected' }[state];

  return (
    <div className="run">
      <div className="run-head">
        <div className="eyebrow">Run a pass</div>
        <p className="fine">A pass runs when you press it. It also runs on its own every morning at 7:30 Toronto time.</p>
        <button className="btn run-primary" disabled={running} onClick={() => start('all')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z" /></svg>
          Run full pass
        </button>
        <button className="btn ghost sm" disabled={running} onClick={() => setChoose(c => !c)} aria-expanded={choose}>{choose ? 'Hide single stages' : 'Run a single stage'}</button>
        {choose && (
          <div className="stages">
            {STAGES.filter(s => s !== 'all').map(s => (
              <button key={s} className="stage" disabled={running} onClick={() => start(s)}>
                <b>{STAGE_INFO[s].name}{STAGE_INFO[s].spends && <span className="tag">spends</span>}</b>
                <small>{STAGE_INFO[s].why}</small>
              </button>
            ))}
          </div>
        )}
        <label className="toggle-row">
          <input type="checkbox" checked={free} onChange={e => toggleFree(e.target.checked)} disabled={running} />
          <span><b>Free only</b><small>Skips the stages that spend on a model</small></span>
        </label>
        {error && <div className="alert" role="alert">{error}</div>}
      </div>

      <div className="run-status">
        <span className={`run-dot s-${state}`} />
        <b>{label}{stage ? ` · ${STAGE_INFO[stage].name}` : ''}</b>
        {startedAt && <span className="num muted">{elapsed}s</span>}
        {running && <button className="btn sm ghost run-stop" onClick={stop}>Stop</button>}
      </div>
      {failedLines > 0 && !running && <div className="warn">{failedLines} line{failedLines === 1 ? '' : 's'} mention a failure. A failed stage doesn’t stop the pass — read the log.</div>}

      <pre className="run-log" ref={log} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {lines.length === 0
          ? <span className="muted">{running ? 'Starting…' : 'The log of the next run prints here, line by line.'}</span>
          : tidy(lines).map((l, i) => (l === RULE ? <span key={i} className="rule" /> : <span key={i} className={lineClass(l)}>{l}{'\n'}</span>))}
      </pre>
    </div>
  );
}
