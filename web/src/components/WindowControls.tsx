import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { cssColorToHex } from '../data/cssColor';
import type { Lang } from '../data/lang';
import { readUiZoom } from '../data/uiZoom';
import {
  fetchCloseAction,
  getCachedCloseAction,
  updateCloseAction,
} from '../data/shellExit';
import { WindowCloseDialog } from './WindowCloseDialog';

type ShellAction = 'minimize' | 'toggle-maximize' | 'close';

/**
 * Windows desktop shell (Weft.exe) messaging protocol contract:
 *
 * Web -> Shell:
 * - 'minimize': minimize window
 * - 'toggle-maximize': maximize or restore window
 * - 'theme:...': theme color reporting for shell pre-rendering
 * - 'hide-to-tray': hide window to system notification area / tray (service keeps running)
 * - 'quit': completely exit Weft and stop backend service
 *
 * Shell -> Web:
 * - 'confirm-quit': sent when user clicks "退出 Weft" in the tray context menu.
 *   Shell displays the window and instructs Web to pop up the exit confirmation dialog
 *   (with default focus on 'Exit Weft', and without the 'Do not ask again' checkbox).
 */

function shellOn(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.desktopShell === '1';
}

function maximizedOn(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.windowMaximized === '1';
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

interface ChromeWebView {
  postMessage(msg: string): void;
  addEventListener(type: string, listener: (ev: { data: unknown }) => void): void;
  removeEventListener?(type: string, listener: (ev: { data: unknown }) => void): void;
}

function getWebView(): ChromeWebView | null {
  if (typeof window === 'undefined') return null;
  const webview = (window as unknown as { chrome?: { webview?: ChromeWebView } })?.chrome?.webview;
  return webview ?? null;
}

export function postRaw(msg: string): void {
  const webview = getWebView();
  webview?.postMessage(msg);
}

/**
 * Tell the shell the colours it needs to draw the same window buttons before the page is up, and the page zoom:
 * `theme:` + --bg, --ink, --mute, --hover, --fail, --term as #rrggbb + the html zoom (--ui-zoom).
 * Stored by the shell and used on its next cold start.
 */
function reportTheme(): void {
  const style = getComputedStyle(document.documentElement);
  const colors = ['--bg', '--ink', '--mute', '--hover', '--fail', '--term'].map((name) => cssColorToHex(style.getPropertyValue(name)));
  if (colors.some((c) => c === null)) return;
  const zoom = Math.round(readUiZoom() * 1000) / 1000;
  postRaw(`theme:${colors.join(',')},${zoom}`);
}

function useReportTheme(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    // The first report doubles as "the page is drawn": wait two frames so what the shell uncovers is already painted.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(reportTheme); });
    const observer = new MutationObserver(reportTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      observer.disconnect();
    };
  }, [active]);
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
  const [dialogMode, setDialogMode] = useState<'normal' | 'confirm-quit' | null>(null);

  useReportTheme(shell);

  useEffect(() => {
    if (!shell) return;
    void fetchCloseAction();
  }, [shell]);

  useEffect(() => {
    if (!shell) return;

    const webview = getWebView();
    if (!webview) return;

    const onMessage = (event: { data: unknown }) => {
      if (event.data === 'confirm-quit') {
        setDialogMode('confirm-quit');
      }
    };

    webview.addEventListener('message', onMessage);
    return () => {
      webview.removeEventListener?.('message', onMessage);
    };
  }, [shell]);

  if (!shell) return null;

  const handleButtonClick = (action: ShellAction) => {
    if (action === 'minimize') {
      postRaw('minimize');
    } else if (action === 'toggle-maximize') {
      postRaw('toggle-maximize');
    } else if (action === 'close') {
      const pref = getCachedCloseAction();
      if (pref === 'tray') {
        postRaw('hide-to-tray');
      } else if (pref === 'quit') {
        postRaw('quit');
      } else {
        setDialogMode('normal');
      }
    }
  };

  const handleDialogAction = (action: 'tray' | 'quit', remember: boolean) => {
    if (dialogMode !== 'confirm-quit' && remember) {
      void updateCloseAction(action);
    }
    setDialogMode(null);
    if (action === 'tray') {
      postRaw('hide-to-tray');
    } else {
      postRaw('quit');
    }
  };

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
    <>
      <div className="wc-btns" data-testid="window-controls">
        {buttons.map((b) => (
          <button
            key={b.action}
            type="button"
            className={`icon-btn wc-btn${b.cls ?? ''}`}
            data-testid={`window-${b.action}`}
            title={b.label}
            aria-label={b.label}
            onClick={() => handleButtonClick(b.action)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              {ICONS[b.icon]}
            </svg>
          </button>
        ))}
      </div>
      {dialogMode ? (
        <WindowCloseDialog
          lang={lang}
          isConfirmQuit={dialogMode === 'confirm-quit'}
          onCancel={() => setDialogMode(null)}
          onAction={handleDialogAction}
        />
      ) : null}
    </>
  );
}
