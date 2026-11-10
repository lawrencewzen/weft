// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCloseActionForTesting } from '../../data/shellExit';
import { GeneralPage, parseTriggerPercent } from './GeneralPage';

describe('parseTriggerPercent', () => {
  it('accepts whole numbers from 60 to 90', () => {
    expect(parseTriggerPercent('60')).toBe(60);
    expect(parseTriggerPercent(' 80 ')).toBe(80);
    expect(parseTriggerPercent('90')).toBe(90);
  });

  it('rejects out-of-range, fractional and non-numeric input', () => {
    for (const bad of ['59', '91', '1.5', '75.0', '', 'abc', '-70', '1e2', '080x']) {
      expect(parseTriggerPercent(bad), bad).toBeNull();
    }
  });
});

describe('GeneralPage closeAction setting', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
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
    resetCloseActionForTesting('ask');
    vi.restoreAllMocks();
  });

  it('does not render closeAction preference when not running in desktop shell', async () => {
    await act(async () => root.render(<GeneralPage lang="zh" />));
    expect(host.querySelector('[data-testid=next-pref-close-action]')).toBeNull();
  });

  it('renders closeAction preference in desktop shell and toggles options', async () => {
    document.documentElement.dataset.desktopShell = '1';
    await act(async () => root.render(<GeneralPage lang="zh" />));

    const seg = host.querySelector('[data-testid=next-pref-close-action]');
    expect(seg).not.toBeNull();
    const askBtn = seg?.querySelector<HTMLButtonElement>('button[data-action="ask"]');
    const trayBtn = seg?.querySelector<HTMLButtonElement>('button[data-action="tray"]');
    const quitBtn = seg?.querySelector<HTMLButtonElement>('button[data-action="quit"]');

    expect(askBtn).not.toBeNull();
    expect(trayBtn).not.toBeNull();
    expect(quitBtn).not.toBeNull();

    // Default is ask, note is not displayed
    expect(askBtn?.classList.contains('is-on')).toBe(true);
    expect(host.querySelector('[data-testid=next-pref-close-action-note]')).toBeNull();

    // Switch to tray
    await act(async () => {
      trayBtn?.click();
    });
    expect(trayBtn?.classList.contains('is-on')).toBe(true);
    expect(host.querySelector('[data-testid=next-pref-close-action-note]')).toBeNull();

    // Switch to quit: note is displayed
    await act(async () => {
      quitBtn?.click();
    });
    expect(quitBtn?.classList.contains('is-on')).toBe(true);
    const note = host.querySelector('[data-testid=next-pref-close-action-note]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('退出后定时任务不会执行。');
  });
});
