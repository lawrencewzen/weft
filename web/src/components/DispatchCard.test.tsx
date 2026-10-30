// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DispatchCard } from './DispatchCard';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore, type Subagent } from '../data/store';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function makeAgent(overrides: Partial<Subagent>): Subagent {
  return {
    id: 'c1:sub:sa-1',
    parentConversationId: 'c1',
    title: '修复加载顺序',
    name: 'sub-load-order',
    mode: 'background',
    status: 'running',
    startedAt: 1000,
    lastActivityAt: 2000,
    endedAt: null,
    currentAction: '正在核对',
    progress: null,
    toolCallId: null,
    ...overrides,
  };
}

async function renderCard(agents: Subagent[], cid = 'c1') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  const store = createEntityStore();
  const sessionValue: SessionValue = {
    store,
    status: 'connected',
    conversationId: cid,
    lang: 'zh',
    extraConversationIds: [],
    setExtraConversationIds: vi.fn(),
    retainTopic: vi.fn(),
    releaseTopic: vi.fn(),
    topics: [],
  };

  await act(async () => {
    root!.render(
      <SessionContext.Provider value={sessionValue}>
        <RightPaneProvider conversationId={cid} workspaceId={null} lang="zh" onToast={vi.fn()}>
          <DispatchCard cid={cid} agents={agents} lang="zh" />
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
  if (host && host.parentNode) {
    host.parentNode.removeChild(host);
    host = null;
  }
}

describe('DispatchCard component', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await cleanup();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders agent.title only and does not render next-dispatch-task column', async () => {
    const agent = makeAgent({
      title: '补 text.delta 偏移的用例',
      name: 'sub-delta-test',
    });

    await renderCard([agent]);

    const nameEl = host!.querySelector('[data-testid="next-dispatch-name"]');
    expect(nameEl).toBeTruthy();
    expect(nameEl!.textContent).toBe('补 text.delta 偏移的用例');

    // next-dispatch-task column is removed
    const taskEl = host!.querySelector('[data-testid="next-dispatch-task"]');
    expect(taskEl).toBeNull();

    // row does not contain the internal agent name
    const rowEl = host!.querySelector('[data-testid="next-dispatch-row"]');
    expect(rowEl!.textContent).not.toContain('sub-delta-test');
  });

  it('falls back to agent.name when agent.title is empty or whitespace', async () => {
    const agentEmpty = makeAgent({
      id: 'c1:sub:sa-empty',
      title: '',
      name: 'worker-delta',
    });
    const agentSpaces = makeAgent({
      id: 'c1:sub:sa-spaces',
      title: '   ',
      name: 'worker-spaces',
    });

    await renderCard([agentEmpty, agentSpaces]);

    const names = Array.from(host!.querySelectorAll('[data-testid="next-dispatch-name"]')).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(['worker-delta', 'worker-spaces']);
  });
});
