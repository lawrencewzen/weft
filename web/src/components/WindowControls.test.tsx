// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDocumentPrefs, toggleAppearance, watchSystemAppearance } from '../data/prefs';
import { WindowControls } from './WindowControls';

const themesCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles/themes.css'), 'utf8');

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

  describe('theme report (real themes.css, real prefs)', () => {
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 80)); });

    beforeEach(() => {
      // jsdom does not resolve custom properties from stylesheets: answer --bg from the real themes.css rule
      // that matches the current data-theme, like a browser would.
      vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
        getPropertyValue: (name: string) => {
          const attr = document.documentElement.getAttribute('data-theme');
          const m = new RegExp(`\\[data-theme="${attr}"\\]\\{[^}]*?--bg:(#[0-9a-fA-F]{6})`).exec(themesCss);
          return name === '--bg' && m ? ` ${m[1]}` : '';
        },
      }) as unknown as CSSStyleDeclaration);
      document.documentElement.dataset.desktopShell = '1';
      localStorage.clear();
    });

    afterEach(() => {
      localStorage.clear();
      document.documentElement.removeAttribute('data-theme');
      delete (globalThis as { matchMedia?: unknown }).matchMedia;
    });

    it('stored dark: the very first report is the dark background', async () => {
      localStorage.setItem('weft_appearance', 'dark');
      applyDocumentPrefs();
      await act(async () => root.render(<WindowControls lang="en" />));
      await settle();
      expect(posted).toEqual(['theme:#181818']);
    });

    it('stored dark with the claude family reports its own dark background', async () => {
      localStorage.setItem('weft_appearance', 'dark');
      localStorage.setItem('weft_theme', 'claude');
      applyDocumentPrefs();
      await act(async () => root.render(<WindowControls lang="en" />));
      await settle();
      expect(posted).toEqual(['theme:#262624']);
    });

    it('switching the theme reports again, every time', async () => {
      applyDocumentPrefs(); // default: light
      await act(async () => root.render(<WindowControls lang="en" />));
      await settle();
      expect(posted).toEqual(['theme:#fcfcfc']);
      await act(async () => { toggleAppearance(); await Promise.resolve(); });
      expect(posted).toEqual(['theme:#fcfcfc', 'theme:#181818']);
      await act(async () => { toggleAppearance(); await Promise.resolve(); });
      expect(posted).toEqual(['theme:#fcfcfc', 'theme:#181818', 'theme:#fcfcfc']);
    });

    it('system appearance: follows the OS at start and when the OS flips', async () => {
      let dark = true;
      let listener: (() => void) | null = null;
      (globalThis as { matchMedia?: unknown }).matchMedia = () => ({
        get matches() { return dark; },
        addEventListener: (_: string, fn: () => void) => { listener = fn; },
        removeEventListener: () => { listener = null; },
      });
      localStorage.setItem('weft_appearance', 'system');
      applyDocumentPrefs();
      const stop = watchSystemAppearance();
      await act(async () => root.render(<WindowControls lang="en" />));
      await settle();
      expect(posted).toEqual(['theme:#181818']);
      dark = false;
      await act(async () => { listener?.(); await Promise.resolve(); });
      expect(posted).toEqual(['theme:#181818', 'theme:#fcfcfc']);
      stop();
    });
  });
});
