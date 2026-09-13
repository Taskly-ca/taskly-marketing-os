'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Panel widths the team drags to taste, remembered per browser. The first render always uses the default
// (the server has no localStorage) and the saved value is read after mount — no hydration mismatch.

const read = (key: string) => { try { return window.localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { window.localStorage.setItem(key, value); } catch { /* private mode */ } };

export function usePanelWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const saved = Number(read(key));
    if (saved >= min && saved <= max) setWidth(saved);
  }, [key, min, max]);
  const set = useCallback((w: number) => {
    const next = Math.round(Math.min(max, Math.max(min, w)));
    setWidth(next);
    write(key, String(next));
  }, [key, min, max]);
  const reset = useCallback(() => set(initial), [set, initial]);
  return { width, set, reset, min, max };
}

export function useStoredFlag(key: string, initial: boolean) {
  const [on, setOn] = useState(initial);
  useEffect(() => { const v = read(key); if (v === '1' || v === '0') setOn(v === '1'); }, [key]);
  const set = useCallback((v: boolean) => { setOn(v); write(key, v ? '1' : '0'); }, [key]);
  return [on, set] as const;
}

type HandleProps = { label: string; panel: ReturnType<typeof usePanelWidth>; side?: 'right' | 'left' };

/** A drag handle on a panel's edge. Drag, use the arrow keys, or double-click to reset. */
export function ResizeHandle({ label, panel, side = 'right' }: HandleProps) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [active, setActive] = useState(false);
  const dir = side === 'right' ? 1 : -1;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: panel.width };
    setActive(true);
    document.documentElement.classList.add('is-resizing');
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    panel.set(drag.current.w + (e.clientX - drag.current.x) * dir);
  };
  const end = () => {
    drag.current = null;
    setActive(false);
    document.documentElement.classList.remove('is-resizing');
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') { e.preventDefault(); panel.set(panel.width - step * dir); }
    if (e.key === 'ArrowRight') { e.preventDefault(); panel.set(panel.width + step * dir); }
    if (e.key === 'Home') { e.preventDefault(); panel.reset(); }
  };

  return (
    <div
      className="resize-handle"
      data-side={side}
      data-active={active}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={panel.width}
      aria-valuemin={panel.min}
      aria-valuemax={panel.max}
      tabIndex={0}
      title={`${label} — drag, or double-click to reset`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={panel.reset}
      onKeyDown={onKeyDown}
    />
  );
}
