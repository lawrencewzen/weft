// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDocumentPrefs, toggleAppearance, watchSystemAppearance } from '../data/prefs';
import { resetCloseActionForTesting, setCachedCloseAction } from '../data/shellExit';
import { WindowControls } from './WindowControls';

const LIGHT = 'theme:#fcfcfc,#1f1f1f,#6e6e6e,#f3f3f3,#b94642,#1a1a1a,0.9';
const DARK = 'theme:#181818,#e4e4e4,#8f8f8f,#232323,#b94642,#111111,0.9';

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
    resetCloseActionForTesting('ask');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ compaction: { triggerPercent: 80 }, closeAction: 'ask' }),
      json: async () => ({ compaction: { triggerPercent: 80 }, closeAction: 'ask' }),
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete document.documentElement.dataset.desktopShell;
    delete document.documentElement.dataset.windowMaximized;
    delete (window as unknown as { chrome?: unknown }).chrome;
    delete (window as unknown as { __protoShell?: unknown }).__protoShell;
    delete (window as unknown as { __protoShellMessages?: unknown }).__protoShellMessages;
    resetCloseActionForTesting('ask');
    vi.restoreAllMocks();
  });

  it('renders nothing without data-desktop-shell', async () => {
    await act(async () => root.render(<WindowControls lang="zh" />));
    expect(host.querySelector('[data-testid=window-controls]')).toBeNull();
  });

  it('posts minimize and toggle-maximize and follows the maximized flag', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="en" />));
    const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid=${id}]`)!;
    expect(q('window-toggle-maximize').title).toBe('Maximize');
    await act(async () => {
      q('window-minimize').click();
      q('window-toggle-maximize').click();
    });
    expect(posted).toEqual(['minimize', 'toggle-maximize']);
    await act(async () => {
      document.documentElement.dataset.windowMaximized = '1';
      await Promise.resolve();
    });
    expect(q('window-toggle-maximize').title).toBe('Restore');
  });

  it('clicking close pops up dialog, cancel dismisses it without posting messages', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="zh" />));
    const closeBtn = host.querySelector<HTMLButtonElement>('[data-testid=window-close]')!;

    await act(async () => {
      closeBtn.click();
    });

    const dialog = host.querySelector('[data-testid=window-close-dialog]');
    expect(dialog).not.toBeNull();
    expect(host.querySelector('[data-testid=window-close-tray]')).not.toBeNull();
    expect(host.querySelector('[data-testid=window-close-quit]')).not.toBeNull();
    expect(host.querySelector('[data-testid=window-close-remember]')).not.toBeNull();
    expect(host.querySelector('[data-testid=window-close-note]')?.textContent).toContain('退出后定时任务不会执行。');

    // Click cancel button
    const cancelBtn = host.querySelector<HTMLButtonElement>('[data-testid=window-close-cancel]')!;
    await act(async () => {
      cancelBtn.click();
    });
    expect(host.querySelector('[data-testid=window-close-dialog]')).toBeNull();
    expect(posted).toEqual([]);
  });

  it('clicking tray button in dialog sends hide-to-tray', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="zh" />));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=window-close]')!.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=window-close-tray]')!.click();
    });
    expect(posted).toEqual(['hide-to-tray']);
    expect(host.querySelector('[data-testid=window-close-dialog]')).toBeNull();
  });

  it('clicking quit button in dialog sends quit', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="zh" />));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=window-close]')!.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=window-close-quit]')!.click();
    });
    expect(posted).toEqual(['quit']);
    expect(host.querySelector('[data-testid=window-close-dialog]')).toBeNull();
  });

  it('checking remember saves preference and subsequent close skips dialog', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="zh" />));

    // First click: opens dialog
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=window-close]')!.click();
    });

    const chk = host.querySelector<HTMLInputElement>('[data-testid=window-close-remember]')!;
    await act(async () => {
      chk.click();
    });
    expect(chk.checked).toBe(true);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=window-close-tray]')!.click();
    });
    expect(posted).toEqual(['hide-to-tray']);

    // Second click: directly sends hide-to-tray without opening dialog
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=window-close]')!.click();
    });
    expect(posted).toEqual(['hide-to-tray', 'hide-to-tray']);
    expect(host.querySelector('[data-testid=window-close-dialog]')).toBeNull();
  });

  it('simulating confirm-quit opens dialog with quit focused and hides remember checkbox', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="zh" />));

    const protoShell = (window as unknown as { __protoShell?: (action: string) => void }).__protoShell;
    expect(typeof protoShell).toBe('function');

    await act(async () => {
      protoShell!('confirm-quit');
    });

    const dialog = host.querySelector('[data-testid=window-close-dialog]');
    expect(dialog).not.toBeNull();
    // Remember checkbox is NOT shown
    expect(host.querySelector('[data-testid=window-close-remember]')).toBeNull();
    // Default focus is on quit button
    const quitBtn = host.querySelector<HTMLButtonElement>('[data-testid=window-close-quit]')!;
    expect(document.activeElement).toBe(quitBtn);

    // Clicking quit button posts quit
    await act(async () => {
      quitBtn.click();
    });
    expect(posted).toEqual(['quit']);
  });

  it('records posted messages to window.__protoShellMessages', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="en" />));
    setCachedCloseAction('quit');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=window-minimize]')!.click();
      host.querySelector<HTMLButtonElement>('[data-testid=window-close]')!.click();
    });

    const msgs = (window as unknown as { __protoShellMessages?: string[] }).__protoShellMessages;
    expect(msgs).toContain('minimize');
    expect(msgs).toContain('quit');
  });

  describe('theme report (real themes.css, real prefs)', () => {
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 80)); });

    beforeEach(() => {
      // jsdom does not resolve custom properties from stylesheets: answer them from the real themes.css rule
      // for the current data-theme (falling back to :root), like a browser would. --ui-zoom lives in app.css.
      vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
        getPropertyValue: (name: string) => {
          if (name === '--ui-zoom') return '0.9';
          const attr = document.documentElement.getAttribute('data-theme');
          const find = (selector: string) =>
            new RegExp(`${selector}\\{[^}]*?${name}:([^;}]+)`).exec(themesCss)?.[1];
          // :root comes after the theme blocks in themes.css with equal specificity, so it wins where both define a variable
          // (--fail: the per-theme --fail values are shadowed in the real page, which the browser confirms).
          return ` ${find(':root') ?? find(`\\[data-theme="${attr}"\\]`) ?? ''}`;
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
      expect(posted).toEqual([DARK]);
    });

    it('stored dark with the claude family reports its own dark background', async () => {
      localStorage.setItem('weft_appearance', 'dark');
      localStorage.setItem('weft_theme', 'claude');
      applyDocumentPrefs();
      await act(async () => root.render(<WindowControls lang="en" />));
      await settle();
      expect(posted).toEqual(['theme:#262624,#ebe8e1,#99948a,#32312d,#b94642,#1a1917,0.9']);
    });

    it('switching the theme reports again, every time', async () => {
      applyDocumentPrefs(); // default: light
      await act(async () => root.render(<WindowControls lang="en" />));
      await settle();
      expect(posted).toEqual([LIGHT]);
      await act(async () => { toggleAppearance(); await Promise.resolve(); });
      expect(posted).toEqual([LIGHT, DARK]);
      await act(async () => { toggleAppearance(); await Promise.resolve(); });
      expect(posted).toEqual([LIGHT, DARK, LIGHT]);
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
      expect(posted).toEqual([DARK]);
      dark = false;
      await act(async () => { listener?.(); await Promise.resolve(); });
      expect(posted).toEqual([DARK, LIGHT]);
      stop();
    });
  });
});
