// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowControls } from './WindowControls';

describe('WindowControls', () => {
  let root: Root;
  let host: HTMLDivElement;
  const posted: string[] = [];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    posted.length = 0;
    (window as unknown as { chrome?: unknown }).chrome = { webview: { postMessage: (m: string) => posted.push(m) } };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete document.documentElement.dataset.desktopShell;
    delete document.documentElement.dataset.windowMaximized;
    delete (window as unknown as { chrome?: unknown }).chrome;
    vi.restoreAllMocks();
  });

  it('renders nothing without data-desktop-shell', async () => {
    await act(async () => root.render(<WindowControls lang="zh" />));
    expect(host.querySelector('[data-testid=window-controls]')).toBeNull();
  });

  it('posts the three actions and follows the maximized flag', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="en" />));
    const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid=${id}]`)!;
    expect(q('window-toggle-maximize').title).toBe('Maximize');
    await act(async () => {
      q('window-minimize').click();
      q('window-toggle-maximize').click();
      q('window-close').click();
    });
    expect(posted).toEqual(['minimize', 'toggle-maximize', 'close']);
    await act(async () => {
      document.documentElement.dataset.windowMaximized = '1';
      await Promise.resolve();
    });
    expect(q('window-toggle-maximize').title).toBe('Restore');
  });

  it('reports the page background to the shell and again when the theme changes', async () => {
    const root_ = document.documentElement;
    root_.dataset.desktopShell = '1';
    root_.style.setProperty('--bg', '#181818');
    await act(async () => root.render(<WindowControls lang="en" />));
    expect(posted).toEqual([]); // not before the page had a chance to paint
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(posted).toEqual(['theme:#181818']);
    await act(async () => {
      root_.style.setProperty('--bg', '#fcfcfc');
      root_.setAttribute('data-theme', 'white-light');
      await Promise.resolve();
    });
    expect(posted).toEqual(['theme:#181818', 'theme:#fcfcfc']);
    root_.style.removeProperty('--bg');
    root_.removeAttribute('data-theme');
  });
});
