import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { Lang } from '../data/lang';

type ShellAction = 'minimize' | 'toggle-maximize' | 'close';

function shellOn(): boolean {
  return document.documentElement.dataset.desktopShell === '1';
}

function maximizedOn(): boolean {
  return document.documentElement.dataset.windowMaximized === '1';
}

/** Re-read the two <html> data attributes the desktop shell (or the prototype) sets. */
function useShellState(): { shell: boolean; maximized: boolean } {
  const [state, setState] = useState(() => ({ shell: shellOn(), maximized: maximizedOn() }));
  useEffect(() => {
    const sync = () => setState((prev) => {
      const next = { shell: shellOn(), maximized: maximizedOn() };
      return prev.shell === next.shell && prev.maximized === next.maximized ? prev : next;
    });
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-desktop-shell', 'data-window-maximized'],
    });
    return () => observer.disconnect();
  }, []);
  return state;
}

function post(action: ShellAction): void {
  // Only exists inside the WebView2 shell; in the prototype the buttons do nothing.
  const webview = (window as unknown as { chrome?: { webview?: { postMessage(msg: string): void } } }).chrome?.webview;
  webview?.postMessage(action);
}

const ICONS = {
  minimize: <path d="M2.5 7h9" />,
  maximize: <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" />,
  restore: (
    <>
      <rect x="2.5" y="4.5" width="7" height="7" rx="1.5" />
      <path d="M4.5 4.5V4A1.5 1.5 0 0 1 6 2.5h5.5V8a1.5 1.5 0 0 1-1.5 1.5h-.5" />
    </>
  ),
  close: <path d="M3 3l8 8M11 3l-8 8" />,
};

/** Windows-style caption buttons, drawn only when the Weft.exe desktop shell is active. */
export function WindowControls({ lang }: { lang: Lang }) {
  const { shell, maximized } = useShellState();
  if (!shell) return null;
  const buttons: { action: ShellAction; icon: keyof typeof ICONS; label: string; cls?: string }[] = [
    { action: 'minimize', icon: 'minimize', label: t(lang, 'window_minimize') },
    {
      action: 'toggle-maximize',
      icon: maximized ? 'restore' : 'maximize',
      label: maximized ? t(lang, 'window_restore') : t(lang, 'window_maximize'),
    },
    { action: 'close', icon: 'close', label: t(lang, 'window_close'), cls: ' is-close' },
  ];
  return (
    <div className="wc-btns" data-testid="window-controls">
      {buttons.map((b) => (
        <button
          key={b.action}
          type="button"
          className={`icon-btn wc-btn${b.cls ?? ''}`}
          data-testid={`window-${b.action}`}
          title={b.label}
          aria-label={b.label}
          onClick={() => post(b.action)}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            {ICONS[b.icon]}
          </svg>
        </button>
      ))}
    </div>
  );
}
