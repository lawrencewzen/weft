import type { WorkspacePickResult } from './api';

export const SHELL_PICK_TIMEOUT_MS = 10 * 60 * 1000;

interface ChromeWebView {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: string, listener: (event: { data: unknown }) => void): void;
}

function getWebView(): ChromeWebView | null {
  if (typeof window === 'undefined') return null;
  const chrome = (window as unknown as { chrome?: { webview?: ChromeWebView } })?.chrome;
  if (
    chrome?.webview &&
    typeof chrome.webview.postMessage === 'function' &&
    typeof chrome.webview.addEventListener === 'function'
  ) {
    return chrome.webview;
  }
  return null;
}

export function isDesktopShellAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  const isShell =
    document.documentElement?.dataset?.desktopShell === '1' ||
    document.documentElement?.getAttribute('data-desktop-shell') === '1';
  return Boolean(isShell && getWebView());
}

let reqCounter = 0;

export function generateRequestId(): string {
  reqCounter = (reqCounter + 1) & 0xffffff;
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const seq = reqCounter.toString(36);
  const id = `pk_${time}_${seq}_${rand}`;
  return id.slice(0, 40);
}

export interface ShellPickFolderOptions {
  timeoutMs?: number;
}

/**
 * Modern folder picker via desktop shell (Weft.exe WebView2).
 * Returns null if not running in the desktop shell.
 */
export async function shellPickFolder(
  options?: ShellPickFolderOptions,
): Promise<WorkspacePickResult | null> {
  if (!isDesktopShellAvailable()) {
    return null;
  }

  const webview = getWebView();
  if (!webview) {
    return null;
  }

  const timeoutMs = options?.timeoutMs ?? SHELL_PICK_TIMEOUT_MS;
  const requestId = generateRequestId();

  return new Promise<WorkspacePickResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        webview.removeEventListener?.('message', onMessage);
      } catch {
        // Ignore errors during cleanup
      }
    };

    const finish = (result: WorkspacePickResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onMessage = (event: { data: unknown }) => {
      const data = event?.data;
      if (!data || typeof data !== 'object') {
        return; // Ignore non-object messages
      }

      const msg = data as { type?: unknown; id?: unknown; status?: unknown; path?: unknown };
      if (msg.type !== 'pick-folder-result' || msg.id !== requestId) {
        return; // Ignore messages not matching this request
      }

      if (msg.status === 'picked' && typeof msg.path === 'string') {
        finish({ status: 'picked', path: msg.path });
      } else {
        finish({ status: 'cancelled' });
      }
    };

    try {
      webview.addEventListener('message', onMessage);
      webview.postMessage(`pick-folder:${requestId}`);
    } catch {
      finish({ status: 'cancelled' });
      return;
    }

    timer = setTimeout(() => {
      finish({ status: 'cancelled' });
    }, timeoutMs);
  });
}
