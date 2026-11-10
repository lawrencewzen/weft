export function installMockShell(): void {
  const win = window as unknown as {
    __protoShellMessages?: string[];
    __protoShell?: (action: string) => void;
    chrome?: {
      webview?: {
        postMessage(msg: string): void;
        addEventListener(type: string, listener: (ev: { data: unknown }) => void): void;
        removeEventListener?(type: string, listener: (ev: { data: unknown }) => void): void;
      };
    };
  };

  const messages: string[] = [];
  win.__protoShellMessages = messages;

  const listeners = new Set<(ev: { data: unknown }) => void>();

  const fakeWebview = {
    postMessage(msg: string): void {
      messages.push(msg);
    },
    addEventListener(type: string, listener: (ev: { data: unknown }) => void): void {
      if (type === 'message') {
        listeners.add(listener);
      }
    },
    removeEventListener(type: string, listener: (ev: { data: unknown }) => void): void {
      if (type === 'message') {
        listeners.delete(listener);
      }
    },
  };

  win.chrome = win.chrome || {};
  win.chrome.webview = fakeWebview;

  win.__protoShell = (action: string) => {
    for (const listener of listeners) {
      listener({ data: action });
    }
  };
}
