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
    vi.spyOn(api, 'listWorkspaceDrives').mockResolvedValue({
      root: 'D:\\work',
      path: '',
      parent: null,
      selectable: false,
      git: false,
      entries: [
        { name: 'C:', path: 'C:\\', git: false },
        { name: 'D:', path: 'D:\\', git: false },
      ],
      truncated: false,
    });
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
      if (p === 'C:\\') {
        return {
          root: 'D:\\work',
          path: 'C:\\',
          parent: '',
          selectable: false,
          git: false,
          entries: [
            { name: 'Projects', path: 'C:\\Projects', git: false },
          ],
          truncated: false,
        };
      }
      if (p === 'C:\\Projects') {
        return {
          root: 'D:\\work',
          path: 'C:\\Projects',
          parent: 'C:\\',
          selectable: true,
          git: false,
          entries: [],
          truncated: false,
        };
      }
      if (p === '/Users/alice') {
        return {
          root: 'D:\\work',
          path: '/Users/alice',
          parent: '/Users',
          selectable: true,
          git: false,
          entries: [],
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

    // Breadcrumbs show 此电脑, D:\, work, sandbox
    const breadcrumbItems = host?.querySelectorAll('[data-testid="next-breadcrumb-item"]');
    expect(breadcrumbItems?.length).toBe(4);
    expect(breadcrumbItems?.[0].textContent).toBe('此电脑');
    expect(breadcrumbItems?.[1].textContent).toBe('D:\\');
    expect(breadcrumbItems?.[2].textContent).toBe('work');
    expect(breadcrumbItems?.[3].textContent).toBe('sandbox');
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

    const workCrumb = host?.querySelectorAll<HTMLButtonElement>('[data-testid="next-breadcrumb-item"]')[2];
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

  it('breadcrumb "此电脑" click enters drives list view and supports switching drives', async () => {
    const onClose = vi.fn();
    const onToast = vi.fn();

    await act(async () => {
      root?.render(<WorkspaceDialog lang="zh" onClose={onClose} onToast={onToast} />);
    });

    // Initial breadcrumbs: 此电脑 / D:\ / work
    const pcCrumb = host?.querySelectorAll<HTMLButtonElement>('[data-testid="next-breadcrumb-item"]')[0];
    expect(pcCrumb?.textContent).toBe('此电脑');

    await act(async () => {
      pcCrumb?.click();
    });

    expect(api.listWorkspaceDrives).toHaveBeenCalledWith('zh');

    // In drives list view:
    // Path input is empty
    const pathInput = host?.querySelector<HTMLInputElement>('[data-testid="next-ws-path"]');
    expect(pathInput?.value).toBe('');

    // Breadcrumbs only has "此电脑"
    const breadcrumbItems = host?.querySelectorAll('[data-testid="next-breadcrumb-item"]');
    expect(breadcrumbItems?.length).toBe(1);
    expect(breadcrumbItems?.[0].textContent).toBe('此电脑');

    // Create button is disabled
    const createBtn = host?.querySelector<HTMLButtonElement>('[data-testid="next-ws-create"]');
    expect(createBtn?.disabled).toBe(true);

    // Shows C: and D: rows
    const rows = host?.querySelectorAll('[data-testid="next-dir-row"]');
    expect(rows?.length).toBe(2);
    expect(rows?.[0].textContent).toContain('C:');
    expect(rows?.[1].textContent).toContain('D:');

    // Click C: enters C:\
    const cRow = host?.querySelector<HTMLDivElement>('[data-path="C:\\\\"]');
    await act(async () => {
      cRow?.click();
    });

    expect(pathInput?.value).toBe('C:\\');
    const cBreadcrumbs = host?.querySelectorAll('[data-testid="next-breadcrumb-item"]');
    expect(cBreadcrumbs?.length).toBe(2);
    expect(cBreadcrumbs?.[0].textContent).toBe('此电脑');
    expect(cBreadcrumbs?.[1].textContent).toBe('C:\\');

    // Under C:\, see Projects
    const projectsRow = host?.querySelector<HTMLDivElement>('[data-path="C:\\\\Projects"]');
    expect(projectsRow).not.toBeNull();

    // Click Projects to enter C:\Projects
    await act(async () => {
      projectsRow?.click();
    });

    expect(pathInput?.value).toBe('C:\\Projects');
    expect(createBtn?.disabled).toBe(false);

    // Click create creates workspace with name Projects
    await act(async () => {
      createBtn?.click();
    });

    expect(api.createWorkspace).toHaveBeenCalledWith(
      { name: 'Projects', source: 'local', path: 'C:\\Projects' },
      'zh',
    );
  });

  it('in drives view, pasting path and pressing Enter jumps to target path', async () => {
    const onClose = vi.fn();
    const onToast = vi.fn();

    await act(async () => {
      root?.render(<WorkspaceDialog lang="zh" onClose={onClose} onToast={onToast} />);
    });

    // Enter drives view
    const pcCrumb = host?.querySelectorAll<HTMLButtonElement>('[data-testid="next-breadcrumb-item"]')[0];
    await act(async () => {
      pcCrumb?.click();
    });

    const pathInput = host?.querySelector<HTMLInputElement>('[data-testid="next-ws-path"]');
    expect(pathInput?.value).toBe('');

    // Paste D:\work\sandbox and press Enter
    if (pathInput) {
      await act(async () => {
        setInputValue(pathInput, 'D:\\work\\sandbox');
      });
      await act(async () => {
        pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    }

    expect(pathInput?.value).toBe('D:\\work\\sandbox');
    const breadcrumbItems = host?.querySelectorAll('[data-testid="next-breadcrumb-item"]');
    expect(breadcrumbItems?.[3].textContent).toBe('sandbox');
  });

  it('non-Windows paths do not show "此电脑" in breadcrumbs', async () => {
    const onClose = vi.fn();
    const onToast = vi.fn();

    await act(async () => {
      root?.render(<WorkspaceDialog lang="zh" onClose={onClose} onToast={onToast} />);
    });

    const pathInput = host?.querySelector<HTMLInputElement>('[data-testid="next-ws-path"]');
    if (pathInput) {
      await act(async () => {
        setInputValue(pathInput, '/Users/alice');
      });
      await act(async () => {
        pathInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    }

    const breadcrumbItems = host?.querySelectorAll('[data-testid="next-breadcrumb-item"]');
    const texts = Array.from(breadcrumbItems || []).map((el) => el.textContent);
    expect(texts).not.toContain('此电脑');
    expect(texts).toEqual(['/', 'Users', 'alice']);
  });

  describe('typed path', () => {
    const q = (sel: string) => host?.querySelector<HTMLElement>(sel) ?? null;
    const create = () => q('[data-testid="next-ws-create"]') as HTMLButtonElement;
    const pathEl = () => q('[data-testid="next-ws-path"]') as HTMLInputElement;

    async function open() {
      await act(async () => {
        root?.render(<WorkspaceDialog lang="zh" onClose={vi.fn()} onToast={vi.fn()} />);
      });
    }

    it('create is disabled for an empty path and enabled once a path is typed', async () => {
      await open();
      await act(async () => { setInputValue(pathEl(), ''); });
      expect(create().disabled).toBe(true);
      await act(async () => { setInputValue(pathEl(), 'D:\\work\\sandbox'); });
      expect(create().disabled).toBe(false);
    });

    it('typing a path and clicking create validates it then creates with that path', async () => {
      await open();
      await act(async () => { setInputValue(pathEl(), 'D:\\work\\sandbox'); });
      await act(async () => { create().click(); });
      expect(api.listWorkspaceDirs).toHaveBeenCalledWith('D:\\work\\sandbox', 'zh');
      expect(api.createWorkspace).toHaveBeenCalledWith(
        { name: 'sandbox', source: 'local', path: 'D:\\work\\sandbox' },
        'zh',
      );
    });

    it('typing an invalid path and clicking create shows the error and does not create', async () => {
      const onClose = vi.fn();
      await act(async () => {
        root?.render(<WorkspaceDialog lang="zh" onClose={onClose} onToast={vi.fn()} />);
      });
      await act(async () => { setInputValue(pathEl(), 'D:\\invalid'); });
      await act(async () => { create().click(); });
      expect(q('[data-testid="next-ws-dir-error"]')?.textContent).toContain('Directory not found: D:\\invalid');
      expect(api.createWorkspace).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('browse button', () => {
    const q = (sel: string) => host?.querySelector<HTMLElement>(sel) ?? null;
    const browse = () => q('[data-testid="next-ws-browse"]') as HTMLButtonElement | null;
    const pathEl = () => q('[data-testid="next-ws-path"]') as HTMLInputElement;

    async function render(pickFolder?: () => Promise<api.WorkspacePickResult | null>) {
      await act(async () => {
        root?.render(
          <WorkspaceDialog lang="zh" onClose={vi.fn()} onToast={vi.fn()} pickFolder={pickFolder} />,
        );
      });
    }

    it('focuses the path input on open and shows the browse button', async () => {
      await render();
      expect(document.activeElement).toBe(pathEl());
      expect(browse()).not.toBeNull();
    });

    it('picked fills the path and enables create without creating', async () => {
      const pick = vi.fn().mockResolvedValue({ status: 'picked', path: 'D:\\work\\sandbox' });
      await render(pick);
      await act(async () => { browse()?.click(); });
      expect(pick).toHaveBeenCalledTimes(1);
      expect(pathEl().value).toBe('D:\\work\\sandbox');
      expect((q('[data-testid="next-ws-create"]') as HTMLButtonElement).disabled).toBe(false);
      expect(api.createWorkspace).not.toHaveBeenCalled();
      await act(async () => { q('[data-testid="next-ws-create"]')?.click(); });
      expect(api.createWorkspace).toHaveBeenCalledWith(
        { name: 'sandbox', source: 'local', path: 'D:\\work\\sandbox' },
        'zh',
      );
    });

    it('default implementation calls pickWorkspaceRoot with lang', async () => {
      const spy = vi.spyOn(api, 'pickWorkspaceRoot').mockResolvedValue({ status: 'cancelled' });
      await render();
      await act(async () => { browse()?.click(); });
      expect(spy).toHaveBeenCalledWith('zh');
    });

    it('cancelled leaves the path and create state unchanged', async () => {
      await render(vi.fn().mockResolvedValue({ status: 'cancelled' }));
      const before = pathEl().value;
      await act(async () => { browse()?.click(); });
      expect(pathEl().value).toBe(before);
      expect((q('[data-testid="next-ws-create"]') as HTMLButtonElement).disabled).toBe(true);
      expect(browse()).not.toBeNull();
      expect(q('[data-testid="next-ws-error"]')).toBeNull();
    });

    it('null return value leaves path unchanged without error', async () => {
      await render(vi.fn().mockResolvedValue(null));
      const before = pathEl().value;
      await act(async () => { browse()?.click(); });
      expect(pathEl().value).toBe(before);
      expect((q('[data-testid="next-ws-create"]') as HTMLButtonElement).disabled).toBe(true);
      expect(q('[data-testid="next-ws-error"]')).toBeNull();
    });

    it('unsupported hides the button and refocuses the input', async () => {
      await render(vi.fn().mockResolvedValue({ status: 'unsupported' }));
      await act(async () => { browse()?.click(); });
      expect(browse()).toBeNull();
      expect(document.activeElement).toBe(pathEl());
    });

    it('error is shown inside the dialog without closing it', async () => {
      const onClose = vi.fn();
      await act(async () => {
        root?.render(
          <WorkspaceDialog
            lang="zh"
            onClose={onClose}
            onToast={vi.fn()}
            pickFolder={vi.fn().mockRejectedValue(new Error('boom'))}
          />,
        );
      });
      await act(async () => { browse()?.click(); });
      expect(q('[data-testid="next-ws-error"]')?.textContent).toBe('boom');
      expect(onClose).not.toHaveBeenCalled();
      expect(browse()?.disabled).toBe(false);
    });

    it('is disabled while picking and ignores repeat clicks', async () => {
      let resolvePick: (v: api.WorkspacePickResult) => void = () => {};
      const pick = vi.fn().mockReturnValue(new Promise((r) => { resolvePick = r; }));
      await render(pick);
      await act(async () => { browse()?.click(); });
      expect(browse()?.disabled).toBe(true);
      await act(async () => { browse()?.click(); });
      expect(pick).toHaveBeenCalledTimes(1);
      await act(async () => { resolvePick({ status: 'cancelled' }); });
      expect(browse()?.disabled).toBe(false);
    });

    it('picked path that is not selectable keeps create disabled', async () => {
      await render(vi.fn().mockResolvedValue({ status: 'picked', path: '~/.ssh' }));
      await act(async () => { browse()?.click(); });
      expect((q('[data-testid="next-ws-create"]') as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
