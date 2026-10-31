/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../data/api';
import * as ext from '../../data/useExtensions';
import { GitPage } from './GitPage';

vi.mock('../../data/api', () => ({
  createGitConnection: vi.fn(),
  deleteGitConnection: vi.fn(),
  patchGitConnection: vi.fn(),
  testGitConnection: vi.fn(),
  testGitConnectionDraft: vi.fn(),
}));

vi.mock('../../data/useExtensions', () => ({
  useExtensions: vi.fn(),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(node: Parameters<Root['render']>[0]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

async function cleanup() {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  if (host?.parentNode) host.parentNode.removeChild(host);
  host = null;
}

const mockConnection: api.GitConnection = {
  id: 'conn-1',
  name: 'Internal GitLab',
  kind: 'gitlab-self',
  baseUrl: 'https://gitlab.corp.local',
  token: 'glpat-sec',
  hasToken: true,
  allowHttp: false,
  caFile: '',
  lastTest: {
    ok: true,
    username: 'alice',
    error: '',
    errorText: '',
    at: '2026-10-31T00:00:00.000Z',
  },
};

describe('GitPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ext.useExtensions).mockReturnValue({
      gitConnections: [mockConnection],
      ready: true,
      reload: vi.fn(),
    } as unknown as ReturnType<typeof ext.useExtensions>);
  });

  afterEach(async () => {
    await cleanup();
    vi.useRealTimers();
  });

  it('drawer test: shows "测试中…" for at least 500ms even if testGitConnectionDraft immediately resolves, then displays result', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.testGitConnectionDraft).mockResolvedValue({
        ok: true,
        username: 'octocat',
        code: '',
        statusText: 'Connection OK',
      });

      await render(<GitPage lang="zh" onToast={vi.fn()} onConfirm={vi.fn()} />);
      await act(async () => {
        await Promise.resolve();
      });

      const addBtn = host!.querySelector('[data-testid="next-git-add"]') as HTMLButtonElement;
      await act(async () => {
        addBtn.click();
      });

      const testBtn = host!.querySelector('[data-testid="next-git-test"]') as HTMLButtonElement;
      expect(testBtn.textContent).toBe('测试');
      expect(testBtn.disabled).toBe(false);

      await act(async () => {
        testBtn.click();
      });

      // Immediately testing
      expect(testBtn.textContent).toBe('测试中…');
      expect(testBtn.disabled).toBe(true);

      // At 499ms, still testing
      await act(async () => {
        vi.advanceTimersByTime(499);
      });
      expect(testBtn.textContent).toBe('测试中…');
      expect(testBtn.disabled).toBe(true);
      expect(host!.querySelector('[data-testid="next-git-test-result"]')?.textContent).not.toContain('Connection OK');

      // At 500ms, resolved with result
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(testBtn.textContent).toBe('测试');
      expect(testBtn.disabled).toBe(false);

      const result = host!.querySelector('[data-testid="next-git-test-result"]');
      expect(result).not.toBeNull();
      expect(result?.textContent).toContain('octocat');
      expect(result?.textContent).toContain('Connection OK');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drawer test: closing drawer within 500ms produces no errors and does not setState after close or unmount', async () => {
    vi.useFakeTimers();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      vi.mocked(api.testGitConnectionDraft).mockResolvedValue({
        ok: true,
        username: 'octocat',
        code: '',
        statusText: 'Connection OK',
      });

      await render(<GitPage lang="zh" onToast={vi.fn()} onConfirm={vi.fn()} />);
      await act(async () => {
        await Promise.resolve();
      });

      // Open drawer
      await act(async () => {
        (host!.querySelector('[data-testid="next-git-add"]') as HTMLButtonElement).click();
      });

      const testBtn = host!.querySelector('[data-testid="next-git-test"]') as HTMLButtonElement;
      await act(async () => {
        testBtn.click();
      });
      expect(testBtn.textContent).toBe('测试中…');

      // Advance 200ms (within 500ms)
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Close drawer via cancel button
      const cancelBtn = host!.querySelector('.ns-drawer-foot .ns-btn-ghost') as HTMLButtonElement;
      await act(async () => {
        cancelBtn.click();
      });

      expect(host!.querySelector('[data-testid="next-git-drawer"]')).toBeNull();

      // Advance well past 500ms
      await act(async () => {
        vi.advanceTimersByTime(800);
      });

      // Also unmount component completely
      await cleanup();
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      // Ensure no React unmounted component warning was emitted
      for (const call of consoleErrorSpy.mock.calls) {
        const msg = String(call[0] || '');
        expect(msg).not.toMatch(/unmounted/i);
        expect(msg).not.toMatch(/Can't perform a React state update/i);
      }
    } finally {
      consoleErrorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('row test: shows "测试中…" and disables button for at least 500ms even if testGitConnection immediately resolves', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.testGitConnection).mockResolvedValue({
        ok: true,
        username: 'alice',
        code: '',
        statusText: 'Connected',
      });

      await render(<GitPage lang="zh" onToast={vi.fn()} onConfirm={vi.fn()} />);
      await act(async () => {
        await Promise.resolve();
      });

      const rowTestBtn = host!.querySelector('[data-testid="next-git-row-test"]') as HTMLButtonElement;
      expect(rowTestBtn.disabled).toBe(false);

      await act(async () => {
        rowTestBtn.click();
      });

      // Immediately testing
      expect(rowTestBtn.disabled).toBe(true);
      expect(host!.querySelector('.ns-git-meta')?.textContent).toContain('测试中…');

      // At 499ms, still testing
      await act(async () => {
        vi.advanceTimersByTime(499);
      });
      expect(rowTestBtn.disabled).toBe(true);
      expect(host!.querySelector('.ns-git-meta')?.textContent).toContain('测试中…');

      // At 500ms, completed
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(rowTestBtn.disabled).toBe(false);
      expect(host!.querySelector('.ns-git-meta')?.textContent).not.toContain('测试中…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drawer test: switching kind or modifying form fields resets test result', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.testGitConnectionDraft).mockResolvedValue({
        ok: true,
        username: 'bob',
        code: '',
        statusText: 'All good',
      });

      await render(<GitPage lang="zh" onToast={vi.fn()} onConfirm={vi.fn()} />);
      await act(async () => {
        await Promise.resolve();
      });

      // Open drawer
      await act(async () => {
        (host!.querySelector('[data-testid="next-git-add"]') as HTMLButtonElement).click();
      });

      // Run test
      await act(async () => {
        (host!.querySelector('[data-testid="next-git-test"]') as HTMLButtonElement).click();
      });

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(host!.querySelector('[data-testid="next-git-test-result"]')?.textContent).toContain('bob');

      // Change input field
      const nameInput = host!.querySelector('[data-testid="next-git-name"]') as HTMLInputElement;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(nameInput, 'New Name');
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Result card should be cleared
      expect(host!.querySelector('[data-testid="next-git-test-result"]')).toBeNull();

      // Test again
      await act(async () => {
        (host!.querySelector('[data-testid="next-git-test"]') as HTMLButtonElement).click();
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(host!.querySelector('[data-testid="next-git-test-result"]')?.textContent).toContain('bob');

      // Switch kind
      await act(async () => {
        (host!.querySelector('[data-testid="next-git-kind-other"]') as HTMLButtonElement).click();
      });

      // Result card should be cleared again
      expect(host!.querySelector('[data-testid="next-git-test-result"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
