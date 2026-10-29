// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lang } from '../data/lang';
import {
  conversationTopic,
  createEntityStore,
  subagentTopic,
  WORKSPACES_TOPIC,
} from '../data/store';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { TerminalPane } from './TerminalPane';
import { RightPane } from './RightPane';

describe('RightPane & TerminalPane subagent command subscription', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    if (!window.matchMedia) {
      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
    }
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    if (host && host.parentNode) {
      host.parentNode.removeChild(host);
      host = null;
    }
  });

  it('updates command tabs and live terminal output when subagent tool is upserted and streamed', async () => {
    const store = createEntityStore();
    const cid = 'c1';
    const lang: Lang = 'zh';
    const convTop = conversationTopic(cid);
    const saTop = subagentTopic(cid, 'sa-1');

    store.applySnapshot({
      protocolVersion: '2.0',
      topics: [WORKSPACES_TOPIC, convTop, saTop],
      entities: [
        {
          topic: WORKSPACES_TOPIC,
          entity: 'workspace',
          id: 'w1',
          value: { id: 'w1', name: 'Workspace 1', path: '/test', source: 'local' },
        },
        {
          topic: WORKSPACES_TOPIC,
          entity: 'conversation_summary',
          id: cid,
          value: { id: cid, workspaceId: 'w1', title: 'Conversation 1', updatedAt: Date.now() },
        },
        {
          topic: convTop,
          entity: 'conversation',
          id: cid,
          value: {
            id: cid,
            workspaceId: 'w1',
            title: 'Conversation 1',
            updatedAt: Date.now(),
            status: 'idle',
            model: null,
            run: { status: 'idle', startedAt: null, pendingText: null, canSend: true, canStop: false, lockedReason: null, error: null },
            context: { used: 0, window: 128000, percent: 0, level: 'ok' },
            itemIds: [],
          },
        },
        {
          topic: convTop,
          entity: 'subagent',
          id: 'sa-1',
          value: {
            id: 'sa-1',
            parentConversationId: cid,
            title: 'Subagent 1',
            name: 'sa-1',
            mode: 'background',
            status: 'running',
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
            endedAt: null,
            currentAction: null,
            progress: null,
            toolCallId: 't1',
          },
        },
      ],
    });

    const sessionValue: SessionValue = {
      store,
      status: 'connected',
      conversationId: cid,
      lang,
      extraConversationIds: [],
      setExtraConversationIds: vi.fn(),
      retainTopic: vi.fn(),
      releaseTopic: vi.fn(),
      topics: [],
    };

    function TestApp() {
      return createElement(
        SessionContext.Provider,
        { value: sessionValue },
        createElement(
          RightPaneProvider,
          { conversationId: cid, workspaceId: 'w1', lang, onToast: () => {} },
          createElement('div', null, [
            createElement(TerminalPane, { key: 'term', lang }),
            createElement(RightPane, { key: 'rp', lang, workspaceLabel: 'w1' }),
          ]),
        ),
      );
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(createElement(TestApp));
    });

    // 1. Initial: no commands in subagent
    const emptyPane = host.querySelector('.pane-empty');
    expect(emptyPane).not.toBeNull();
    expect(host.querySelector('[data-testid="next-term-cmds"]')).toBeNull();

    // 2. Subagent executes a bash command -> upsert bash tool to subagentTopic
    await act(async () => {
      store.applySnapshot({
        protocolVersion: '2.0',
        topics: [saTop],
        entities: [
          {
            topic: saTop,
            entity: 'tool',
            id: 'bash-1',
            value: {
              id: 'bash-1',
              kind: 'bash',
              status: 'running',
              heading: { title: 'pytest -q', detail: '' },
              output: { preview: 'running tests...', text: 'running tests...' },
            },
          },
        ],
      });
      store.flush();
    });

    // TerminalPane and RightPane re-rendered and have the new command tab
    const cmdTab = host.querySelector('[data-testid="next-term-cmd"]');
    expect(cmdTab).not.toBeNull();
    expect(cmdTab?.textContent).toContain('pytest -q');

    const termBody = host.querySelector('[data-testid="next-term-body"]');
    expect(termBody).not.toBeNull();
    expect(termBody?.textContent).toBe('running tests...');

    // 3. Subagent bash command outputs streaming delta
    await act(async () => {
      store.applyToolDelta({
        topic: saTop,
        toolId: 'bash-1',
        offset: 16,
        append: ' [100% passed]',
      });
      store.flush();
    });

    // TerminalPane output updated with toolLiveText
    expect(host.querySelector('[data-testid="next-term-body"]')?.textContent).toBe(
      'running tests... [100% passed]',
    );
  });
});
