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
  minimize: <path d="M0 5.5h10" />,
  maximize: <rect x="0.5" y="0.5" width="9" height="9" />,
  restore: (
    <>
      <rect x="0.5" y="2.5" width="7" height="7" />
      <path d="M2.5 2.5V0.5h7v7h-2" />
    </>
  ),
  close: <path d="M0 0l10 10M10 0L0 10" />,
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
          className={`wc-btn${b.cls ?? ''}`}
          data-testid={`window-${b.action}`}
          title={b.label}
          aria-label={b.label}
          onClick={() => post(b.action)}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
            {ICONS[b.icon]}
          </svg>
        </button>
      ))}
    </div>
  );
}
