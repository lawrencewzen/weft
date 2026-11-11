/**
 * Messages to the desktop shell (WebView2 host). The shell side is not built yet;
 * this only fixes the wire format. Browsers have no `window.chrome.webview`, so
 * every helper reports "no shell" and callers fall back to plain web behaviour.
 *
 * Page -> shell:
 *   { type: 'weft.saveReport', id, suggestedName, url, body }  shell POSTs `body` to `url`,
 *                                                              shows a save dialog, writes the zip
 *   { type: 'weft.revealInFolder', path }
 * Shell -> page:
 *   { type: 'weft.saveReport.result', id, ok, canceled?, path?, error? }
 */

type WebviewHost = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: 'message', listener: (ev: { data: unknown }) => void) => void;
  removeEventListener: (type: 'message', listener: (ev: { data: unknown }) => void) => void;
};

export type ShellSaveResult = {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
};

function host(): WebviewHost | null {
  if (typeof window === 'undefined') return null;
  const webview = (window as unknown as { chrome?: { webview?: WebviewHost } }).chrome?.webview;
  return webview && typeof webview.postMessage === 'function' ? webview : null;
}

export function hasDesktopShell(): boolean {
  return host() !== null;
}

export function shellSaveReport(args: { suggestedName: string; url: string; body: unknown }): Promise<ShellSaveResult> {
  const webview = host();
  if (!webview) return Promise.reject(new Error('no desktop shell'));
  const id = `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<ShellSaveResult>((resolve) => {
    const listener = (ev: { data: unknown }) => {
      const data = ev.data as { type?: string; id?: string } & ShellSaveResult;
      if (!data || data.type !== 'weft.saveReport.result' || data.id !== id) return;
      webview.removeEventListener('message', listener);
      resolve({ ok: Boolean(data.ok), canceled: data.canceled, path: data.path, error: data.error });
    };
    webview.addEventListener('message', listener);
    webview.postMessage({ type: 'weft.saveReport', id, suggestedName: args.suggestedName, url: args.url, body: args.body });
  });
}

export function shellRevealInFolder(path: string): void {
  host()?.postMessage({ type: 'weft.revealInFolder', path });
}
