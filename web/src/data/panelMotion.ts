import { useEffect, useState } from 'react';

/** Keep in sync with `--panel-slide-ms` in `web/src/styles/app.css`. */
export const PANEL_SLIDE_MS = 220;

export function usePanelMotionReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setReady(true));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, []);
  return ready;
}

export function useClosedSettled(open: boolean, motionReady: boolean): boolean {
  const [settled, setSettled] = useState(() => !open);
  useEffect(() => {
    if (open) {
      setSettled(false);
      return;
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!motionReady || reduce) {
      setSettled(true);
      return;
    }
    const id = window.setTimeout(() => setSettled(true), PANEL_SLIDE_MS);
    return () => window.clearTimeout(id);
  }, [open, motionReady]);
  return settled;
}
