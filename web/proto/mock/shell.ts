/**
 * Fake desktop shell, only with `?shell=1`: lets the prototype show the shell
 * branch of the report dialog. Real shells answer the same messages natively
 * (see src/data/desktopShell.ts).
 */
export function installMockShell(): void {
  if (typeof window === 'undefined' || !new URLSearchParams(window.location.search).has('shell')) return;
  const listeners = new Set<(ev: { data: unknown }) => void>();
  const reply = (data: unknown) => { for (const fn of [...listeners]) fn({ data }); };
  const w = window as unknown as { chrome?: Record<string, unknown>; __protoShellMessages?: unknown[] };
  w.__protoShellMessages = [];
  w.chrome = {
    ...(w.chrome || {}),
    webview: {
      postMessage(message: { type?: string; id?: string; suggestedName?: string; url?: string; body?: unknown }) {
        w.__protoShellMessages!.push(message);
        if (message.type !== 'weft.saveReport') return;
        void (async () => {
          try {
            const res = await fetch(message.url || '', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(message.body),
            });
            if (!res.ok) throw new Error(String(res.status));
            await res.blob();
            await new Promise((r) => window.setTimeout(r, 400));
            reply({ type: 'weft.saveReport.result', id: message.id, ok: true, path: `C:\\Users\\demo\\Documents\\${message.suggestedName}` });
          } catch (err) {
            reply({ type: 'weft.saveReport.result', id: message.id, ok: false, error: String(err) });
          }
        })();
      },
      addEventListener(_type: string, fn: (ev: { data: unknown }) => void) { listeners.add(fn); },
      removeEventListener(_type: string, fn: (ev: { data: unknown }) => void) { listeners.delete(fn); },
    },
  };
}
