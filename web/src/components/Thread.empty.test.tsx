/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Thread } from './Thread';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore, WORKSPACES_TOPIC } from '../data/store';
import type { ConversationActions } from '../data/useConversation';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function makeActions(): ConversationActions {
  return {
    send: vi.fn(),
    stop: vi.fn(),
    continueRun: vi.fn(),
    loadToolOutput: vi.fn(),
    withdraw: vi.fn(),
  };
}

function renderThread(props: {
  lang?: 'zh' | 'en';
  draftWorkspaceId?: string | null;
  draftWorkspaceName?: string | null;
}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  const testStore = createEntityStore();
  if (props.draftWorkspaceId) {
    testStore.applySnapshot({
      protocolVersion: '2',
      topics: [WORKSPACES_TOPIC],
      entities: [
        {
          topic: WORKSPACES_TOPIC,
          entity: 'workspace',
          id: props.draftWorkspaceId,
          value: {
            id: props.draftWorkspaceId,
            name: props.draftWorkspaceName || 'weft',
            path: '/path/to/weft',
          },
        },
      ],
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
        <RightPaneProvider conversationId="c1" workspaceId={null} lang={props.lang || 'zh'} onToast={vi.fn()}>
          <Thread
            items={[]}
            toolsById={{}}
            lang={props.lang || 'zh'}
            running={false}
            actions={makeActions()}
            stickNonce={0}
            draftWorkspaceId={props.draftWorkspaceId}
            draftWorkspaceName={props.draftWorkspaceName}
          />
        </RightPaneProvider>
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

describe('Thread empty state hero title (T119-2)', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('renders "今天想做点什么？" in zh when no project is selected', async () => {
    await renderThread({ lang: 'zh', draftWorkspaceId: null, draftWorkspaceName: null });
    const hint = host?.querySelector('[data-testid="next-draft-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('今天想做点什么？');
    expect(host?.querySelector('[data-testid="next-draft-hero-ws"]')).toBeNull();
  });

  it('renders "What would you like to do today?" in en when no project is selected', async () => {
    await renderThread({ lang: 'en', draftWorkspaceId: null, draftWorkspaceName: null });
    const hint = host?.querySelector('[data-testid="next-draft-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('What would you like to do today?');
    expect(host?.querySelector('[data-testid="next-draft-hero-ws"]')).toBeNull();
  });

  it('renders "在 <项目名> 里做点什么？" in zh when project is present', async () => {
    await renderThread({ lang: 'zh', draftWorkspaceId: 'ws-1', draftWorkspaceName: 'weft' });
    const hint = host?.querySelector('[data-testid="next-draft-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('在');
    expect(hint?.textContent).toContain('里做点什么？');
    const chip = host?.querySelector('[data-testid="next-draft-hero-ws"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('weft');
  });

  it('renders "What would you like to do in <project>?" in en when project is present', async () => {
    await renderThread({ lang: 'en', draftWorkspaceId: 'ws-1', draftWorkspaceName: 'weft' });
    const hint = host?.querySelector('[data-testid="next-draft-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('What would you like to do in');
    expect(hint?.textContent).toContain('?');
    const chip = host?.querySelector('[data-testid="next-draft-hero-ws"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('weft');
  });
});
