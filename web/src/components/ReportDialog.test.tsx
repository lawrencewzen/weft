/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportDialog } from './ReportDialog';
import { reportFileList, reportFileName } from '../data/reportDialog';

const createReport = vi.fn();
vi.mock('../data/api', () => ({ createDiagnosticsReport: (...a: unknown[]) => createReport(...a) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(node: Parameters<Root['render']>[0]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
}

function q(id: string): HTMLElement | null {
  return host?.querySelector(`[data-testid="${id}"]`) ?? null;
}

async function click(el: HTMLElement | null) {
  await act(async () => { el!.click(); });
}

function files(): string[] {
  return Array.from(q('next-report-files')?.querySelectorAll('li') ?? []).map((li) => li.textContent || '');
}

describe('reportFileList', () => {
  it('follows the options', () => {
    expect(reportFileList({ includeLogs: true, includeDoctor: true })).toEqual([
      'report.txt', 'system.txt', 'doctor.txt', 'logs/service.log…', 'logs/service-stdio.log', 'settings.json',
    ]);
    expect(reportFileList({ includeLogs: false, includeDoctor: false, conversationId: 'c1' })).toEqual([
      'report.txt', 'system.txt', 'settings.json', 'conversation-c1.json',
    ]);
  });

  it('names the zip with date and time', () => {
    expect(reportFileName(new Date(2026, 10, 9, 8, 7, 6))).toBe('weft-report-20261109-080706.zip');
  });
});

describe('ReportDialog', () => {
  beforeEach(() => {
    createReport.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await act(async () => { root!.unmount(); });
    host?.remove();
    root = null;
    host = null;
    delete (window as { chrome?: unknown }).chrome;
  });

  it('without a conversation: no conversation option, logs and doctor on', async () => {
    await render(<ReportDialog lang="zh" open={{}} />);
    expect(q('next-report-conversation')).toBeNull();
    expect((q('next-report-logs') as HTMLInputElement).checked).toBe(true);
    expect((q('next-report-doctor') as HTMLInputElement).checked).toBe(true);
    expect(files()).not.toContain('conversation-c1.json');
  });

  it('with a conversation: option is off by default and toggles the file list', async () => {
    await render(<ReportDialog lang="zh" open={{ conversationId: 'c1' }} />);
    const box = q('next-report-conversation') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(files()).not.toContain('conversation-c1.json');
    await click(box);
    expect(files()).toContain('conversation-c1.json');
    await click(q('next-report-logs'));
    expect(files().some((f) => f.startsWith('logs/'))).toBe(false);
  });

  it('exports through the API in a browser and shows done', async () => {
    createReport.mockResolvedValue(new Blob(['zip']));
    await render(<ReportDialog lang="en" open={{ conversationId: 'c1' }} />);
    await click(q('next-report-conversation'));
    await act(async () => {
      const area = q('next-report-text') as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(area, ' it broke ');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(q('next-report-export'));
    expect(createReport).toHaveBeenCalledWith({
      description: 'it broke', includeLogs: true, includeDoctor: true, conversationId: 'c1',
    });
    expect(q('next-report-status')?.textContent).toContain('Exported');
  });

  it('shows the error when the export fails', async () => {
    createReport.mockRejectedValue(new Error('boom'));
    await render(<ReportDialog lang="en" open={{}} />);
    await click(q('next-report-export'));
    expect(q('next-report-status')?.textContent).toContain('boom');
  });
});
