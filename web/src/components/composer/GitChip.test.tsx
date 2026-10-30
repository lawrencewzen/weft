/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitStatus } from '../../data/gitBar';
import type { Workspace } from '../../data/store';
import { GitChip } from './GitChip';

function git(partial: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    detached: false,
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    ahead: null,
    behind: null,
    ...partial,
  };
}

function workspace(id: string, status: GitStatus | null): Workspace {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    source: 'local',
    gitUrl: null,
    branch: null,
    git: status,
    conversationCount: 0,
    runningCount: 0,
  };
}

const { mockState } = vi.hoisted(() => ({
  mockState: { list: [] as Workspace[] },
}));

vi.mock('../../data/useWorkspaces', () => ({
  useWorkspaces: () => ({
    workspaces: mockState.list,
    conversations: [],
    groups: [],
    latest: undefined,
    ready: true,
    status: 'open',
  }),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function renderChip(workspaceId: string | null = 'w1') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(GitChip, { lang: 'zh', workspaceId }));
  });
}

async function cleanup() {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  if (host && host.parentNode) {
    host.parentNode.removeChild(host);
  }
  root = null;
  host = null;
}

describe('GitChip', () => {
  afterEach(async () => {
    mockState.list = [];
    await cleanup();
  });

  it('renders nothing when git is missing', async () => {
    mockState.list = [workspace('w1', null)];
    await renderChip();
    expect(host!.querySelector('[data-testid="next-composer-git"]')).toBeNull();
  });

  it('renders nothing when the branch name is empty', async () => {
    mockState.list = [workspace('w1', git({ branch: '' }))];
    await renderChip();
    expect(host!.querySelector('[data-testid="next-composer-git"]')).toBeNull();
  });

  it('shows the branch name without diff or ahead when clean', async () => {
    mockState.list = [workspace('w1', git({ branch: 'main' }))];
    await renderChip();
    expect(host!.querySelector('[data-testid="next-composer-git-branch"]')?.textContent).toBe('main');
    expect(host!.querySelector('[data-testid="next-composer-git-ins"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-composer-git-del"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-composer-git-ahead"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-composer-git"]')?.getAttribute('title')).toBe('分支 main');
  });

  it('shows insertions and deletions when there is a diff', async () => {
    mockState.list = [workspace('w1', git({ insertions: 42, deletions: 7 }))];
    await renderChip();
    expect(host!.querySelector('[data-testid="next-composer-git-ins"]')?.textContent).toBe('+42');
    expect(host!.querySelector('[data-testid="next-composer-git-del"]')?.textContent).toBe('−7');
    expect(host!.querySelector('[data-testid="next-composer-git"]')?.getAttribute('title')).toContain('未提交 +42');
  });

  it('shows ahead when the branch is ahead of upstream', async () => {
    mockState.list = [workspace('w1', git({ ahead: 2 }))];
    await renderChip();
    expect(host!.querySelector('[data-testid="next-composer-git-ahead"]')?.textContent).toBe('↑2');
    expect(host!.querySelector('[data-testid="next-composer-git-ins"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-composer-git"]')?.getAttribute('title')).toBe('分支 main · 领先远端 2 个提交');
  });

  it('reads git from the current workspace id', async () => {
    mockState.list = [
      workspace('w1', git({ branch: 'main', insertions: 1 })),
      workspace('w2', git({ branch: 'feat/landing-page', insertions: 18, deletions: 4 })),
    ];
    await renderChip('w2');
    expect(host!.querySelector('[data-testid="next-composer-git-branch"]')?.textContent).toBe('feat/landing-page');
    expect(host!.querySelector('[data-testid="next-composer-git-ins"]')?.textContent).toBe('+18');
    expect(host!.querySelector('[data-testid="next-composer-git-del"]')?.textContent).toBe('−4');
    expect(host!.querySelector('[data-testid="next-composer-git-ahead"]')).toBeNull();
  });
});
