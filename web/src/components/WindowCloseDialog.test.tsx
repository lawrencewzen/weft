// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WindowCloseDialog } from './WindowCloseDialog';

describe('WindowCloseDialog', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('renders two option cards, remember checkbox, and settings hint in normal mode', async () => {
    const onAction = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      root.render(
        <WindowCloseDialog
          lang="zh"
          onCancel={onCancel}
          onAction={onAction}
        />
      );
    });

    const dialog = host.querySelector('[data-testid=window-close-dialog]');
    expect(dialog).not.toBeNull();
    const tray = host.querySelector<HTMLButtonElement>('[data-testid=window-close-tray]');
    const quit = host.querySelector<HTMLButtonElement>('[data-testid=window-close-quit]');
    expect(tray?.textContent).toContain('缩到托盘');
    expect(tray?.textContent).toContain('后台继续运行，定时任务照常执行');
    expect(quit?.textContent).toContain('退出 Weft');
    expect(quit?.textContent).toContain('停止服务，定时任务不会执行');

    // Default focus is on tray card
    expect(document.activeElement).toBe(tray);

    // Clicking tray card invokes onAction('tray', false)
    await act(async () => {
      tray?.click();
    });
    expect(onAction).toHaveBeenCalledWith('tray', false);
  });

  it('toggling remember checkbox passes remember=true on card click', async () => {
    const onAction = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      root.render(
        <WindowCloseDialog
          lang="en"
          onCancel={onCancel}
          onAction={onAction}
        />
      );
    });

    const chk = host.querySelector<HTMLInputElement>('.window-close-remember input');
    expect(chk).not.toBeNull();
    await act(async () => {
      chk?.click();
    });
    expect(chk?.checked).toBe(true);

    const quit = host.querySelector<HTMLButtonElement>('[data-testid=window-close-quit]');
    await act(async () => {
      quit?.click();
    });
    expect(onAction).toHaveBeenCalledWith('quit', true);
  });

  it('supports keyboard ArrowLeft/ArrowRight to switch focus and Escape to cancel', async () => {
    const onAction = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      root.render(
        <WindowCloseDialog
          lang="zh"
          onCancel={onCancel}
          onAction={onAction}
        />
      );
    });

    const tray = host.querySelector<HTMLButtonElement>('[data-testid=window-close-tray]')!;
    const quit = host.querySelector<HTMLButtonElement>('[data-testid=window-close-quit]')!;
    expect(document.activeElement).toBe(tray);

    await act(async () => {
      tray.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(quit);

    await act(async () => {
      quit.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.activeElement).toBe(tray);

    // Escape cancels
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders standard ConfirmDialog when isConfirmQuit is true', async () => {
    const onAction = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      root.render(
        <WindowCloseDialog
          lang="zh"
          isConfirmQuit={true}
          onCancel={onCancel}
          onAction={onAction}
        />
      );
    });

    const confirmDialog = host.querySelector('[data-testid=confirm-quit-dialog]');
    expect(confirmDialog).not.toBeNull();
    expect(confirmDialog?.querySelector('h3')?.textContent).toContain('退出 Weft？');
    expect(confirmDialog?.querySelector('[data-testid=next-confirm-message]')?.textContent).toBe('退出后定时任务不会执行。');

    // Cards and remember checkbox are absent
    expect(host.querySelector('.window-close-cards')).toBeNull();
    expect(host.querySelector('[data-testid=window-close-remember]')).toBeNull();

    // Default focus is on quit button
    const quitBtn = host.querySelector<HTMLButtonElement>('[data-testid=confirm-quit-ok]');
    expect(document.activeElement).toBe(quitBtn);

    // Clicking quit button calls onAction('quit', false)
    await act(async () => {
      quitBtn?.click();
    });
    expect(onAction).toHaveBeenCalledWith('quit', false);
  });
});
