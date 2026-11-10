// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDocumentPrefs, toggleAppearance, watchSystemAppearance } from '../data/prefs';
import { resetCloseActionForTesting } from '../data/shellExit';
import { WindowControls } from './WindowControls';

const LIGHT = 'theme:#fcfcfc,#1f1f1f,#6e6e6e,#f3f3f3,#b94642,#1a1a1a,0.9';
const DARK = 'theme:#181818,#e4e4e4,#8f8f8f,#232323,#b94642,#111111,0.9';

const themesCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles/themes.css'), 'utf8');

describe('WindowControls', () => {
  let root: Root;
  let host: HTMLDivElement;
  const posted: string[] = [];
  const webviewListeners = new Set<(ev: { data: unknown }) => void>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    posted.length = 0;
    webviewListeners.clear();
    (window as unknown as { chrome?: unknown }).chrome = {
      webview: {
        postMessage: (m: string) => posted.push(m),
        addEventListener: (type: string, fn: (ev: { data: unknown }) => void) => {
          if (type === 'message') webviewListeners.add(fn);
        },
        removeEventListener: (type: string, fn: (ev: { data: unknown }) => void) => {
          if (type === 'message') webviewListeners.delete(fn);
        },
      },
    };
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

  it('clicking close pops up dialog with 2 option cards, default focus on tray card, cancel dismisses it without posting messages', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="zh" />));
    const closeBtn = host.querySelector<HTMLButtonElement>('[data-testid=window-close]')!;

    await act(async () => {
      closeBtn.click();
    });

    const dialog = host.querySelector('[data-testid=window-close-dialog]');
    expect(dialog).not.toBeNull();
    const trayCard = host.querySelector<HTMLButtonElement>('[data-testid=window-close-tray]');
    const quitCard = host.querySelector<HTMLButtonElement>('[data-testid=window-close-quit]');
    expect(trayCard).not.toBeNull();
    expect(quitCard).not.toBeNull();
    expect(trayCard?.textContent).toContain('缩到托盘');
    expect(trayCard?.textContent).toContain('后台继续运行，定时任务照常执行');
    expect(quitCard?.textContent).toContain('退出 Weft');
    expect(quitCard?.textContent).toContain('停止服务，定时任务不会执行');
    expect(host.querySelector('[data-testid=window-close-remember]')).not.toBeNull();
    expect(host.querySelector('[data-testid=window-close-settings-hint]')?.textContent).toContain('可在 设置 › 通用 中修改');

    // Default focus is on the tray card
    expect(document.activeElement).toBe(trayCard);

    // Click cancel button
    const cancelBtn = host.querySelector<HTMLButtonElement>('[data-testid=window-close-cancel]')!;
    await act(async () => {
      cancelBtn.click();
    });
    expect(host.querySelector('[data-testid=window-close-dialog]')).toBeNull();
    expect(posted).toEqual([]);
  });

  it('keyboard navigation switches between cards using ArrowLeft/ArrowRight, and Enter executes focused card', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="zh" />));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid=window-close]')!.click();
    });

    const trayCard = host.querySelector<HTMLButtonElement>('[data-testid=window-close-tray]')!;
    const quitCard = host.querySelector<HTMLButtonElement>('[data-testid=window-close-quit]')!;
    expect(document.activeElement).toBe(trayCard);

    // ArrowRight switches focus to quit card
    await act(async () => {
      trayCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(quitCard);

    // ArrowLeft switches focus back to tray card
    await act(async () => {
      quitCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.activeElement).toBe(trayCard);

    // ArrowRight to quitCard and press Enter
    await act(async () => {
      trayCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(quitCard);

    await act(async () => {
      quitCard.click();
    });
    expect(posted).toEqual(['quit']);
    expect(host.querySelector('[data-testid=window-close-dialog]')).toBeNull();
  });

  it('clicking tray card in dialog sends hide-to-tray', async () => {
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

  it('clicking quit card in dialog sends quit', async () => {
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

    const chk = host.querySelector<HTMLInputElement>('.window-close-remember input')!;
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

  it('receiving confirm-quit via webview opens confirm dialog with quit focused on right, cancel posts nothing, quit posts quit', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<WindowControls lang="zh" />));

    await act(async () => {
      webviewListeners.forEach((l) => l({ data: 'confirm-quit' }));
    });

    const dialog = host.querySelector('[data-testid=confirm-quit-dialog]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('h3')?.textContent).toContain('退出 Weft？');
    expect(dialog?.querySelector('[data-testid=next-confirm-message]')?.textContent).toBe('退出后定时任务不会执行。');

    // Cards and remember checkbox are NOT present
    expect(host.querySelector('.window-close-cards')).toBeNull();
    expect(host.querySelector('[data-testid=window-close-remember]')).toBeNull();

    // Cancel on left, Quit on right as primary (p) and focused
    const cancelBtn = host.querySelector<HTMLButtonElement>('[data-testid=confirm-quit-cancel]')!;
    const quitBtn = host.querySelector<HTMLButtonElement>('[data-testid=confirm-quit-ok]')!;
    expect(cancelBtn).not.toBeNull();
    expect(quitBtn).not.toBeNull();
    expect(cancelBtn.textContent).toBe('取消');
    expect(quitBtn.textContent).toBe('退出');
    expect(quitBtn.classList.contains('p')).toBe(true);
    expect(document.activeElement).toBe(quitBtn);

    // Cancel dismisses without posting
    await act(async () => {
      cancelBtn.click();
    });
    expect(host.querySelector('[data-testid=confirm-quit-dialog]')).toBeNull();
    expect(posted).toEqual([]);

    // Re-trigger confirm-quit and click quit
    await act(async () => {
      webviewListeners.forEach((l) => l({ data: 'confirm-quit' }));
    });
    const quitBtn2 = host.querySelector<HTMLButtonElement>('[data-testid=confirm-quit-ok]')!;
    await act(async () => {
      quitBtn2.click();
    });
    expect(posted).toEqual(['quit']);
    expect(host.querySelector('[data-testid=confirm-quit-dialog]')).toBeNull();
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
