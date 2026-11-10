/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore, WORKSPACES_TOPIC, type ConversationSummary, type Workspace } from '../data/store';
import { LeftPanelProvider } from '../data/leftPanelContext';
import type { ConfirmOpts } from './ConfirmDialog';
import type { ToastInput } from '../data/toast';
import * as api from '../data/api';
import * as nav from '../data/nav';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mockWs: Workspace = {
  id: 'w1',
  name: 'test-ws',
  path: '/tmp/test-ws',
  source: 'local',
  gitUrl: null,
  branch: null,
  git: null,
  conversationCount: 1,
  runningCount: 0,
  kind: 'project',
};

const mockConv: ConversationSummary = {
  id: 'c1',
  workspaceId: 'w1',
  title: 'Test conversation',
  updatedAt: Date.now(),
  status: 'idle',
  runningAgents: 0,
  subagents: null,
  archived: false,
};

const mockArchivedConv: ConversationSummary = {
  id: 'c2',
  workspaceId: 'w1',
  title: 'Archived conversation',
  updatedAt: Date.now() - 1000,
  status: 'idle',
  runningAgents: 0,
  subagents: null,
  archived: true,
};

function renderSidebar(props: {
  workspaces?: Workspace[];
  conversations?: ConversationSummary[];
  activeConversationId?: string | null;
  onToast?: (toast: ToastInput) => void;
  onConfirm?: (opts: ConfirmOpts) => Promise<boolean>;
} = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  const testStore = createEntityStore();
  const wsList = props.workspaces || [mockWs];
  const convList = props.conversations || [mockConv, mockArchivedConv];

  testStore.applySnapshot({
    protocolVersion: '2',
    topics: [WORKSPACES_TOPIC],
    entities: [
      ...wsList.map((ws) => ({
        topic: WORKSPACES_TOPIC,
        entity: 'workspace',
        id: ws.id,
        value: ws as unknown as Record<string, unknown>,
      })),
      ...convList.map((conv) => ({
        topic: WORKSPACES_TOPIC,
        entity: 'conversation_summary',
        id: conv.id,
        value: conv as unknown as Record<string, unknown>,
      })),
    ],
  });

  const sessionValue: SessionValue = {
    store: testStore,
    status: 'connected',
    conversationId: props.activeConversationId ?? 'c1',
    lang: 'zh',
    extraConversationIds: [],
    setExtraConversationIds: vi.fn(),
    retainTopic: vi.fn(),
    releaseTopic: vi.fn(),
    topics: [],
  };

  return act(async () => {
    root!.render(
      <SessionContext.Provider value={sessionValue}>
        <LeftPanelProvider>
          <RightPaneProvider conversationId="c1" workspaceId="w1" lang="zh" onToast={vi.fn()}>
            <Sidebar
              lang="zh"
              activeConversationId={props.activeConversationId ?? 'c1'}
              activeAgentId={null}
              draftWorkspaceId={null}
              onToast={props.onToast || vi.fn()}
              onConfirm={props.onConfirm || (async () => true)}
              onRemoveWorkspace={vi.fn()}
              onNewWorkspace={vi.fn()}
            />
          </RightPaneProvider>
        </LeftPanelProvider>
      </SessionContext.Provider>,
    );
  });
}

describe('Sidebar conversation actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (host && host.parentNode) {
      host.parentNode.removeChild(host);
      host = null;
    }
  });

  it('triggers archive and shows undo toast on normal conversation', async () => {
    const archiveSpy = vi.spyOn(api, 'archiveConversation').mockResolvedValue({} as Awaited<ReturnType<typeof api.archiveConversation>>);
    const onToast = vi.fn<(toast: ToastInput) => void>();
    await renderSidebar({ onToast });

    const moreBtn = host?.querySelector<HTMLButtonElement>('[data-id="c1"] .sb-conv-more');
    expect(moreBtn).not.toBeNull();

    await act(async () => {
      moreBtn?.click();
    });

    const archiveItem = document.querySelector<HTMLButtonElement>('[data-action="archive"]');
    expect(archiveItem).not.toBeNull();
    expect(archiveItem?.textContent).toContain('归档');

    await act(async () => {
      archiveItem?.click();
    });

    expect(archiveSpy).toHaveBeenCalledWith('c1', true);
    expect(onToast).toHaveBeenCalledWith(expect.objectContaining({
      message: '已归档「Test conversation」',
      action: expect.objectContaining({
        label: '撤销',
      }),
    }));
  });

  it('triggers unarchive on archived conversation', async () => {
    const archiveSpy = vi.spyOn(api, 'archiveConversation').mockResolvedValue({} as Awaited<ReturnType<typeof api.archiveConversation>>);
    await renderSidebar();

    // Toggle archived section
    const archivedBtn = host?.querySelector<HTMLButtonElement>('[data-testid="next-archived-toggle"]');
    await act(async () => {
      archivedBtn?.click();
    });

    const moreBtn = host?.querySelector<HTMLButtonElement>('[data-id="c2"] .sb-conv-more');
    expect(moreBtn).not.toBeNull();

    await act(async () => {
      moreBtn?.click();
    });

    const unarchiveItem = document.querySelector<HTMLButtonElement>('[data-action="unarchive"]');
    expect(unarchiveItem).not.toBeNull();
    expect(unarchiveItem?.textContent).toContain('取消归档');

    await act(async () => {
      unarchiveItem?.click();
    });

    expect(archiveSpy).toHaveBeenCalledWith('c2', false);
  });

  it('confirms and deletes conversation, navigating to draft if active', async () => {
    const deleteSpy = vi.spyOn(api, 'deleteConversation').mockResolvedValue(undefined);
    const navigateSpy = vi.spyOn(nav, 'navigate').mockImplementation(() => {});
    const onConfirm = vi.fn<(opts: ConfirmOpts) => Promise<boolean>>().mockResolvedValue(true);
    const onToast = vi.fn<(toast: ToastInput) => void>();

    await renderSidebar({ activeConversationId: 'c1', onConfirm, onToast });

    const moreBtn = host?.querySelector<HTMLButtonElement>('[data-id="c1"] .sb-conv-more');
    await act(async () => {
      moreBtn?.click();
    });

    const deleteItem = document.querySelector<HTMLButtonElement>('[data-action="delete"]');
    expect(deleteItem).not.toBeNull();

    await act(async () => {
      deleteItem?.click();
    });

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除对话？',
      message: '「Test conversation」的记录和历史会被删除，无法恢复。工作区里的文件不受影响。',
      confirmLabel: '删除',
      danger: true,
    }));

    expect(deleteSpy).toHaveBeenCalledWith('c1');
    expect(navigateSpy).toHaveBeenCalledWith('/w/w1/new');
    expect(onToast).toHaveBeenCalledWith('已删除「Test conversation」');
  });

  it('cancels deletion when confirm dialog is rejected', async () => {
    const deleteSpy = vi.spyOn(api, 'deleteConversation');
    const onConfirm = vi.fn<(opts: ConfirmOpts) => Promise<boolean>>().mockResolvedValue(false);

    await renderSidebar({ onConfirm });

    const moreBtn = host?.querySelector<HTMLButtonElement>('[data-id="c1"] .sb-conv-more');
    await act(async () => {
      moreBtn?.click();
    });

    const deleteItem = document.querySelector<HTMLButtonElement>('[data-action="delete"]');
    await act(async () => {
      deleteItem?.click();
    });

    expect(onConfirm).toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
