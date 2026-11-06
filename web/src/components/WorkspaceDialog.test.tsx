/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDialog } from './WorkspaceDialog';
import * as api from '../data/api';

vi.mock('../data/nav', () => ({
  draftPath: (id: string) => `/w/${id}/new`,
  navigate: vi.fn(),
}));

vi.mock('../data/layout', () => ({
  writeActiveWorkspace: vi.fn(),
}));

vi.mock('../data/useExtensions', () => ({
  useExtensions: () => ({ gitConnections: [], ready: true }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe('WorkspaceDialog', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    vi.spyOn(api, 'getWorkspaceRoot').mockResolvedValue({ root: 'D:\\work' });
    vi.spyOn(api, 'listWorkspaceDirs').mockImplementation(async (targetPath?: string) => {
      const p = targetPath || 'D:\\work';
      if (p === 'D:\\work') {
        return {
          root: 'D:\\work',
          path: 'D:\\work',
          parent: 'D:\\',
          selectable: true,
          git: false,
          entries: [
            { name: 'weft', path: 'D:\\work\\weft', git: true },
            { name: 'sandbox', path: 'D:\\work\\sandbox', git: false },
          ],
          truncated: false,
        };
      }
      if (p === 'D:\\work\\sandbox') {
        return {
          root: 'D:\\work',
          path: 'D:\\work\\sandbox',
          parent: 'D:\\work',
          selectable: true,
          git: false,
          entries: [
            { name: 'playground', path: 'D:\\work\\sandbox\\playground', git: false },
          ],
          truncated: false,
        };
      }
      if (p === '~/.ssh' || p === '~\\.ssh') {
        return {
          root: 'D:\\work',
          path: '~/.ssh',
          parent: '~',
          selectable: false,
          git: false,
          entries: [],
          truncated: false,
        };
      }
      throw new Error(`Directory not found: ${p}`);
    });
    vi.spyOn(api, 'createWorkspace').mockResolvedValue({
      id: 'ws-new',
      name: 'sandbox',
      path: 'D:\\work\\sandbox',
      source: 'local',
      gitUrl: null,
      branch: null,
      git: null,
      conversationCount: 0,
      runningCount: 0,
      kind: 'project',
    });
  });

  afterEach(() => {
    if (root && host) {
      act(() => {
        root?.unmount();
      });
      host.remove();
    }
    root = null;
    host = null;
    vi.restoreAllMocks();
  });

  it('initially opens with create disabled, no git tab, no name input', async () => {
    const onClose = vi.fn();
    const onToast = vi.fn();

    await act(async () => {
      root?.render(<WorkspaceDialog lang="zh" onClose={onClose} onToast={onToast} />);
    });

    const createBtn = host?.querySelector<HTMLButtonElement>('[data-testid="next-ws-create"]');
    expect(createBtn).not.toBeNull();
    expect(createBtn?.disabled).toBe(true);

    expect(host?.querySelector('[data-testid="next-ws-tab-git"]')).toBeNull();
    expect(host?.querySelector('[data-testid="next-ws-name"]')).toBeNull();

    const gitBadge = host?.querySelector('[data-testid="next-dir-git-badge"]');
    expect(gitBadge).not.toBeNull();
    expect(gitBadge?.textContent).toBe('Git');
  });

  it('clicking a folder enters it and enables the create button', async () => {
    const onClose = vi.fn();
    const onToast = vi.fn();

    await act(async () => {
      root?.render(<WorkspaceDialog lang="zh" onClose={onClose} onToast={onToast} />);
    });

    const sandboxRow = host?.querySelector<HTMLDivElement>('[data-path="D:\\\\work\\\\sandbox"]');
    expect(sandboxRow).not.toBeNull();

    await act(async () => {
      sandboxRow?.click();
    });

    const createBtn = host?.querySelector<HTMLButtonElement>('[data-testid="next-ws-create"]');
    expect(createBtn?.disabled).toBe(false);

    const pathInput = host?.querySelector<HTMLInputElement>('[data-testid="next-ws-path"]');
    expect(pathInput?.value).toBe('D:\\work\\sandbox');

    // Breadcrumbs show D:\, work, sandbox
    const breadcrumbItems = host?.querySelectorAll('[data-testid="next-breadcrumb-item"]');
    expect(breadcrumbItems?.length).toBe(3);
    expect(breadcrumbItems?.[0].textContent).toBe('D:\\');
    expect(breadcrumbItems?.[1].textContent).toBe('work');
    expect(breadcrumbItems?.[2].textContent).toBe('sandbox');
  });

  it('breadcrumb click navigates up', async () => {
    const onClose = vi.fn();
    const onToast = vi.fn();

    await act(async () => {
      root?.render(<WorkspaceDialog lang="zh" onClose={onClose} onToast={onToast} />);
    });

    const sandboxRow = host?.querySelector<HTMLDivElement>('[data-path="D:\\\\work\\\\sandbox"]');
    await act(async () => {
      sandboxRow?.click();
    });

    const workCrumb = host?.querySelectorAll<HTMLButtonElement>('[data-testid="next-breadcrumb-item"]')[1];
    expect(workCrumb?.textContent).toBe('work');

    await act(async () => {
      workCrumb?.click();
    });

    const pathInput = host?.querySelector<HTMLInputElement>('[data-testid="next-ws-path"]');
    expect(pathInput?.value).toBe('D:\\work');
  });

  it('typing path and pressing Enter navigates or shows inline error', async () => {
    const onClose = vi.fn();
    const onToast = vi.fn();

    await act(async () => {
      root?.render(<WorkspaceDialog lang="zh" onClose={onClose} onToast={onToast} />);
    });

    const pathInput = host?.querySelector<HTMLInputElement>('[data-testid="next-ws-path"]');
    expect(pathInput).not.toBeNull();

    // Enter bad path
    if (pathInput) {
      await act(async () => {
        setInputValue(pathInput, 'D:\\invalid');
      });
      await act(async () => {
        pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    }

    const err = host?.querySelector('[data-testid="next-ws-dir-error"]');
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain('Directory not found: D:\\invalid');

    // Enter valid path
    if (pathInput) {
      await act(async () => {
        setInputValue(pathInput, 'D:\\work\\sandbox');
      });
      await act(async () => {
        pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    }

    expect(host?.querySelector('[data-testid="next-ws-dir-error"]')).toBeNull();
    const createBtn = host?.querySelector<HTMLButtonElement>('[data-testid="next-ws-create"]');
    expect(createBtn?.disabled).toBe(false);
  });

  it('blocked directory disables create button', async () => {
    const onClose = vi.fn();
    const onToast = vi.fn();

    await act(async () => {
      root?.render(<WorkspaceDialog lang="zh" onClose={onClose} onToast={onToast} />);
    });

    const pathInput = host?.querySelector<HTMLInputElement>('[data-testid="next-ws-path"]');
    if (pathInput) {
      await act(async () => {
        setInputValue(pathInput, '~/.ssh');
      });
      await act(async () => {
        pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    }

    const createBtn = host?.querySelector<HTMLButtonElement>('[data-testid="next-ws-create"]');
    expect(createBtn?.disabled).toBe(true);
  });

  it('clicking create calls createWorkspace with dirBasename and toasts', async () => {
    const onClose = vi.fn();
    const onToast = vi.fn();

    await act(async () => {
      root?.render(<WorkspaceDialog lang="zh" onClose={onClose} onToast={onToast} />);
    });

    const sandboxRow = host?.querySelector<HTMLDivElement>('[data-path="D:\\\\work\\\\sandbox"]');
    await act(async () => {
      sandboxRow?.click();
    });

    const createBtn = host?.querySelector<HTMLButtonElement>('[data-testid="next-ws-create"]');
    await act(async () => {
      createBtn?.click();
    });

    expect(api.createWorkspace).toHaveBeenCalledWith(
      { name: 'sandbox', source: 'local', path: 'D:\\work\\sandbox' },
      'zh',
    );
    expect(onToast).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
