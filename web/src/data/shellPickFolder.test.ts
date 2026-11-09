// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateRequestId,
  isDesktopShellAvailable,
  shellPickFolder,
  SHELL_PICK_TIMEOUT_MS,
} from './shellPickFolder';

interface MockMessageEvent {
  data: unknown;
}

type MessageListener = (event: MockMessageEvent) => void;

describe('shellPickFolder', () => {
  let listeners: MessageListener[] = [];
  let postedMessages: string[] = [];
  let removeListenerSpy: ReturnType<typeof vi.fn>;

  const mockWebview = {
    postMessage: vi.fn((msg: unknown) => {
      postedMessages.push(String(msg));
    }),
    addEventListener: vi.fn((type: string, listener: MessageListener) => {
      if (type === 'message') {
        listeners.push(listener);
      }
    }),
    removeEventListener: vi.fn((type: string, listener: MessageListener) => {
      if (type === 'message') {
        listeners = listeners.filter((l) => l !== listener);
      }
    }),
  };

  const dispatchWebviewMessage = (data: unknown) => {
    // Deliver to all current listeners, copying array in case of removal during iteration
    [...listeners].forEach((listener) => listener({ data }));
  };

  beforeEach(() => {
    listeners = [];
    postedMessages = [];
    removeListenerSpy = mockWebview.removeEventListener;
    vi.clearAllMocks();

    document.documentElement.dataset.desktopShell = '1';
    (window as unknown as { chrome?: unknown }).chrome = {
      webview: mockWebview,
    };
  });

  afterEach(() => {
    delete document.documentElement.dataset.desktopShell;
    delete (window as unknown as { chrome?: unknown }).chrome;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('isDesktopShellAvailable', () => {
    it('returns true when in shell with valid webview', () => {
      expect(isDesktopShellAvailable()).toBe(true);
    });

    it('returns false when data-desktop-shell is missing', () => {
      delete document.documentElement.dataset.desktopShell;
      expect(isDesktopShellAvailable()).toBe(false);
    });

    it('returns false when data-desktop-shell is not 1', () => {
      document.documentElement.dataset.desktopShell = '0';
      expect(isDesktopShellAvailable()).toBe(false);
    });

    it('returns false when window.chrome is missing (e.g. prototype ?shell=1)', () => {
      delete (window as unknown as { chrome?: unknown }).chrome;
      expect(isDesktopShellAvailable()).toBe(false);
    });

    it('returns false when window.chrome.webview.postMessage is missing', () => {
      (window as unknown as { chrome?: unknown }).chrome = {
        webview: { addEventListener: vi.fn() },
      };
      expect(isDesktopShellAvailable()).toBe(false);
    });

    it('returns false when window.chrome.webview.addEventListener is missing', () => {
      (window as unknown as { chrome?: unknown }).chrome = {
        webview: { postMessage: vi.fn() },
      };
      expect(isDesktopShellAvailable()).toBe(false);
    });
  });

  describe('generateRequestId', () => {
    it('generates strictly matching [A-Za-z0-9_-]{1,40} IDs', () => {
      for (let i = 0; i < 20; i++) {
        const id = generateRequestId();
        expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
      }
    });

    it('generates unique IDs across calls', () => {
      const set = new Set<string>();
      for (let i = 0; i < 50; i++) {
        set.add(generateRequestId());
      }
      expect(set.size).toBe(50);
    });
  });

  describe('shellPickFolder execution', () => {
    it('returns null in non-shell environment without calling postMessage', async () => {
      delete document.documentElement.dataset.desktopShell;
      const res = await shellPickFolder();
      expect(res).toBeNull();
      expect(mockWebview.postMessage).not.toHaveBeenCalled();
    });

    it('returns null when webview is missing in prototype ?shell=1 mode', async () => {
      delete (window as unknown as { chrome?: unknown }).chrome;
      const res = await shellPickFolder();
      expect(res).toBeNull();
    });

    it('handles picked status: resolves with path and cleans up listener', async () => {
      const promise = shellPickFolder();

      expect(postedMessages.length).toBe(1);
      const m = postedMessages[0].match(/^pick-folder:([A-Za-z0-9_-]{1,40})$/);
      expect(m).not.toBeNull();
      const requestId = m![1];

      expect(listeners.length).toBe(1);

      dispatchWebviewMessage({
        type: 'pick-folder-result',
        id: requestId,
        status: 'picked',
        path: 'C:\\Projects\\Weft',
      });

      const result = await promise;
      expect(result).toEqual({ status: 'picked', path: 'C:\\Projects\\Weft' });
      expect(removeListenerSpy).toHaveBeenCalled();
      expect(listeners.length).toBe(0);
    });

    it('handles cancelled status: resolves with cancelled and cleans up', async () => {
      const promise = shellPickFolder();

      const m = postedMessages[0].match(/^pick-folder:([A-Za-z0-9_-]{1,40})$/);
      const requestId = m![1];

      dispatchWebviewMessage({
        type: 'pick-folder-result',
        id: requestId,
        status: 'cancelled',
      });

      const result = await promise;
      expect(result).toEqual({ status: 'cancelled' });
      expect(removeListenerSpy).toHaveBeenCalled();
      expect(listeners.length).toBe(0);
    });

    it('handles timeout: resolves with cancelled after timeoutMs', async () => {
      vi.useFakeTimers();

      const promise = shellPickFolder({ timeoutMs: 500 });
      expect(listeners.length).toBe(1);

      vi.advanceTimersByTime(550);

      const result = await promise;
      expect(result).toEqual({ status: 'cancelled' });
      expect(removeListenerSpy).toHaveBeenCalled();
      expect(listeners.length).toBe(0);
    });

    it('defaults to SHELL_PICK_TIMEOUT_MS (10 minutes) timeout', async () => {
      vi.useFakeTimers();

      const promise = shellPickFolder();
      expect(SHELL_PICK_TIMEOUT_MS).toBe(10 * 60 * 1000);

      // Advance by 9 minutes: should still be pending
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(listeners.length).toBe(1);

      // Advance past 10 minutes: should resolve to cancelled
      vi.advanceTimersByTime(2 * 60 * 1000);
      const result = await promise;
      expect(result).toEqual({ status: 'cancelled' });
    });

    it('ignores messages with mismatching requestId', async () => {
      const promise = shellPickFolder();
      const m = postedMessages[0].match(/^pick-folder:([A-Za-z0-9_-]{1,40})$/);
      const requestId = m![1];

      // Send result for another request
      dispatchWebviewMessage({
        type: 'pick-folder-result',
        id: 'some-other-req-id',
        status: 'picked',
        path: 'D:\\Ignore\\Me',
      });

      // Listener is still active
      expect(listeners.length).toBe(1);

      // Now send for the real request
      dispatchWebviewMessage({
        type: 'pick-folder-result',
        id: requestId,
        status: 'picked',
        path: 'C:\\Valid\\Path',
      });

      const result = await promise;
      expect(result).toEqual({ status: 'picked', path: 'C:\\Valid\\Path' });
    });

    it('ignores non-object messages (strings, numbers, null, undefined, primitives)', async () => {
      const promise = shellPickFolder();
      const m = postedMessages[0].match(/^pick-folder:([A-Za-z0-9_-]{1,40})$/);
      const requestId = m![1];

      // Send various non-object data
      dispatchWebviewMessage('minimize');
      dispatchWebviewMessage('theme:#fcfcfc,#1f1f1f,#6e6e6e,#efefef,#b94642,#1a1a1a,0.9');
      dispatchWebviewMessage(12345);
      dispatchWebviewMessage(true);
      dispatchWebviewMessage(null);
      dispatchWebviewMessage(undefined);

      // Listener is still waiting
      expect(listeners.length).toBe(1);

      // Now send the expected object
      dispatchWebviewMessage({
        type: 'pick-folder-result',
        id: requestId,
        status: 'picked',
        path: 'C:\\Expected\\Path',
      });

      const result = await promise;
      expect(result).toEqual({ status: 'picked', path: 'C:\\Expected\\Path' });
    });

    it('ignores messages with unexpected type', async () => {
      const promise = shellPickFolder();
      const m = postedMessages[0].match(/^pick-folder:([A-Za-z0-9_-]{1,40})$/);
      const requestId = m![1];

      dispatchWebviewMessage({
        type: 'other-type',
        id: requestId,
        status: 'picked',
        path: 'C:\\Ignored',
      });

      expect(listeners.length).toBe(1);

      dispatchWebviewMessage({
        type: 'pick-folder-result',
        id: requestId,
        status: 'cancelled',
      });

      const result = await promise;
      expect(result).toEqual({ status: 'cancelled' });
    });

    it('handles postMessage throwing an exception: cancels cleanly', async () => {
      mockWebview.postMessage.mockImplementationOnce(() => {
        throw new Error('IPC disconnected');
      });

      const result = await shellPickFolder();
      expect(result).toEqual({ status: 'cancelled' });
      expect(listeners.length).toBe(0);
    });
  });
});
