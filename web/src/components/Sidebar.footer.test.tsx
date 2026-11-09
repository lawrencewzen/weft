/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore, WORKSPACES_TOPIC, type ConversationSummary } from '../data/store';
import { LeftPanelProvider } from '../data/leftPanelContext';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function renderSidebar(props: {
  archived?: ConversationSummary[];
  lang?: 'zh' | 'en';
} = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  const testStore = createEntityStore();
  if (props.archived?.length) {
    testStore.applySnapshot({
      protocolVersion: '2',
      topics: [WORKSPACES_TOPIC],
      entities: props.archived.map((conv) => ({
        topic: WORKSPACES_TOPIC,
        entity: 'conversation_summary',
        id: conv.id,
        value: conv as unknown as Record<string, unknown>,
      })),
    });
  }

  const sessionValue: SessionValue = {
    store: testStore,
    status: 'connected',
    conversationId: 'c1',
    lang: props.lang || 'zh',
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
          <RightPaneProvider conversationId="c1" workspaceId={null} lang={props.lang || 'zh'} onToast={vi.fn()}>
            <Sidebar
              lang={props.lang || 'zh'}
              activeConversationId="c1"
              activeAgentId={null}
              draftWorkspaceId={null}
              onToast={vi.fn()}
              onConfirm={vi.fn()}
              onRemoveWorkspace={vi.fn()}
              onNewWorkspace={vi.fn()}
            />
          </RightPaneProvider>
        </LeftPanelProvider>
      </SessionContext.Provider>,
    );
  });
}

async function cleanup() {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  if (host?.parentNode) {
    host.parentNode.removeChild(host);
    host = null;
  }
}

describe('Sidebar footer layout (T119-2)', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('renders single row at bottom with settings on left and icon buttons on right', async () => {
    await renderSidebar();

    const footer = host?.querySelector<HTMLElement>('.left-footer');
    expect(footer).not.toBeNull();

    const settingsBtn = footer?.querySelector<HTMLButtonElement>('[data-testid="next-open-settings"]');
    expect(settingsBtn).not.toBeNull();
    expect(settingsBtn?.textContent).toContain('设置');

    const serviceDot = footer?.querySelector('[data-testid="next-service-dot"]');
    expect(serviceDot).not.toBeNull();
    expect(serviceDot?.classList.contains('is-ok')).toBe(true);

    const archivedBtn = footer?.querySelector<HTMLButtonElement>('[data-testid="next-archived-toggle"]');
    expect(archivedBtn).not.toBeNull();
    expect(archivedBtn?.getAttribute('aria-label')).toBe('已归档');
    expect(archivedBtn?.getAttribute('title')).toBe('已归档');
    // Count badge should not be present when archived is empty
    expect(archivedBtn?.querySelector('[data-testid="next-archived-count"]')).toBeNull();

    const appearanceBtn = footer?.querySelector<HTMLButtonElement>('[data-testid="next-appearance-toggle"]');
    expect(appearanceBtn).not.toBeNull();
    expect(appearanceBtn?.getAttribute('aria-label')).toBeTruthy();
  });

  it('displays badge count on archived button and toggles list open', async () => {
    const mockArchived: ConversationSummary[] = [
      {
        id: 'arch-1',
        workspaceId: 'ws-1',
        title: '归档对话1',
        status: 'idle',
        updatedAt: Date.now() - 10000,
        runningAgents: 0,
        subagents: null,
        archived: true,
      },
    ];

    await renderSidebar({ archived: mockArchived });

    const archivedBtn = host?.querySelector<HTMLButtonElement>('[data-testid="next-archived-toggle"]');
    expect(archivedBtn).not.toBeNull();
    const badge = archivedBtn?.querySelector('[data-testid="next-archived-count"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('1');

    // List is collapsed by default
    expect(host?.querySelector('[data-testid="next-archived-list"]')).toBeNull();

    // Click toggle to open
    await act(async () => {
      archivedBtn?.click();
    });

    const list = host?.querySelector('[data-testid="next-archived-list"]');
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain('归档对话1');

    // Click toggle to close
    await act(async () => {
      archivedBtn?.click();
    });
    expect(host?.querySelector('[data-testid="next-archived-list"]')).toBeNull();
  });
});
