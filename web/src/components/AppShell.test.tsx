// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import * as shellModule from '../data/shellPickFolder';
import type { WorkspaceDialog } from './WorkspaceDialog';

import { createEntityStore } from '../data/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type WorkspaceDialogProps = React.ComponentProps<typeof WorkspaceDialog>;

let lastWorkspaceDialogProps: WorkspaceDialogProps | null = null;

vi.mock('./WorkspaceDialog', () => ({
  WorkspaceDialog: (props: WorkspaceDialogProps) => {
    lastWorkspaceDialogProps = props;
    return <div data-testid="mock-workspace-dialog" />;
  },
}));

vi.mock('../data/session', () => ({
  useSession: () => ({
    store: createEntityStore(),
    status: 'connected',
    conversationId: null,
    lang: 'zh',
    extraConversationIds: [],
    setExtraConversationIds: () => {},
    retainTopic: () => {},
    releaseTopic: () => {},
    topics: [],
  }),
}));

vi.mock('../data/useExtensions', () => ({
  useExtensions: () => ({ gitConnections: [], extensions: [], ready: true }),
}));

vi.mock('../data/useWorkspaces', () => ({
  useWorkspaces: () => ({
    workspaces: [],
    conversations: [],
    groups: [],
    chats: [],
    archived: [],
    latest: null,
    ready: true,
    busy: false,
  }),
}));

describe('AppShell - WorkspaceDialog pickFolder prop', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    lastWorkspaceDialogProps = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    delete document.documentElement.dataset.desktopShell;
    delete (window as unknown as { chrome?: unknown }).chrome;
    vi.restoreAllMocks();
  });

  it('passes pickFolder={shellPickFolder} when inside desktop shell', async () => {
    document.documentElement.dataset.desktopShell = '1';
    (window as unknown as { chrome?: unknown }).chrome = {
      webview: {
        postMessage: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    };

    expect(shellModule.isDesktopShellAvailable()).toBe(true);

    await act(async () => {
      root.render(
        <AppShell
          route={{ name: 'home' }}
          lang="zh"
          demo
          service={{ serviceVersion: '0.1.1' }}
        />,
      );
    });

    const addBtn = host.querySelector<HTMLButtonElement>('[data-testid="next-ws-new"], [data-testid="next-ws-empty-add"]');
    expect(addBtn).not.toBeNull();

    await act(async () => {
      addBtn?.click();
    });

    expect(lastWorkspaceDialogProps).not.toBeNull();
    expect(lastWorkspaceDialogProps?.pickFolder).toBe(shellModule.shellPickFolder);
  });

  it('does NOT pass pickFolder when outside desktop shell (server default)', async () => {
    delete document.documentElement.dataset.desktopShell;
    delete (window as unknown as { chrome?: unknown }).chrome;

    expect(shellModule.isDesktopShellAvailable()).toBe(false);

    await act(async () => {
      root.render(
        <AppShell
          route={{ name: 'home' }}
          lang="zh"
          demo
          service={{ serviceVersion: '0.1.1' }}
        />,
      );
    });

    const addBtn = host.querySelector<HTMLButtonElement>('[data-testid="next-ws-new"], [data-testid="next-ws-empty-add"]');
    expect(addBtn).not.toBeNull();

    await act(async () => {
      addBtn?.click();
    });

    expect(lastWorkspaceDialogProps).not.toBeNull();
    expect(lastWorkspaceDialogProps?.pickFolder).toBeUndefined();
  });
});
