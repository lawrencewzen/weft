// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMockShell } from './mockShell';

describe('installMockShell', () => {
  beforeEach(() => {
    delete (window as unknown as { chrome?: unknown }).chrome;
    delete (window as unknown as { __protoShell?: unknown }).__protoShell;
    delete (window as unknown as { __protoShellMessages?: unknown }).__protoShellMessages;
  });

  afterEach(() => {
    delete (window as unknown as { chrome?: unknown }).chrome;
    delete (window as unknown as { __protoShell?: unknown }).__protoShell;
    delete (window as unknown as { __protoShellMessages?: unknown }).__protoShellMessages;
  });

  it('installs fake chrome.webview, __protoShellMessages, and __protoShell', () => {
    installMockShell();

    const win = window as unknown as {
      __protoShellMessages?: string[];
      __protoShell?: (action: string) => void;
      chrome?: {
        webview?: {
          postMessage(msg: string): void;
          addEventListener(type: string, listener: (ev: { data: unknown }) => void): void;
          removeEventListener(type: string, listener: (ev: { data: unknown }) => void): void;
        };
      };
    };

    expect(Array.isArray(win.__protoShellMessages)).toBe(true);
    expect(typeof win.__protoShell).toBe('function');
    expect(win.chrome?.webview).toBeDefined();

    // postMessage records to __protoShellMessages
    win.chrome?.webview?.postMessage('hide-to-tray');
    expect(win.__protoShellMessages).toEqual(['hide-to-tray']);

    // __protoShell dispatches to registered webview listeners
    const listener = vi.fn();
    win.chrome?.webview?.addEventListener('message', listener);

    win.__protoShell!('confirm-quit');
    expect(listener).toHaveBeenCalledWith({ data: 'confirm-quit' });

    // removeEventListener unregisters
    win.chrome?.webview?.removeEventListener('message', listener);
    win.__protoShell!('confirm-quit');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
