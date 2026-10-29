// @vitest-environment jsdom
import { act, createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lang } from '../data/lang';
import {
  conversationTopic,
  createEntityStore,
  EXTENSIONS_TOPIC,
  PROVIDERS_TOPIC,
  subagentTopic,
  WORKSPACES_TOPIC,
} from '../data/store';
import { SessionContext, type SessionValue } from '../data/session';
import { LeftPanelProvider } from '../data/leftPanelContext';
import { RightPaneProvider } from '../data/rightPaneContext';
import { Sidebar } from './Sidebar';
import { RightPane } from './RightPane';
import { Thread } from './Thread';
import { useConversation } from '../data/useConversation';

describe('streamPerf: 20,000 chars across 2,000 deltas (T55-2b)', () => {
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

  afterEach(async () => {
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
  });

  it('measures render counts and asserts per-topic isolation and batching', async () => {
    const store = createEntityStore();
    const cid = 'c1';
    const otherCid = 'c2';
    const convTop = conversationTopic(cid);
    const otherConvTop = conversationTopic(otherCid);
    const saTop = subagentTopic(cid, 'sa-1');
    const lang: Lang = 'zh';

    // Initial snapshot setup
    store.applySnapshot({
      protocolVersion: '2.0',
      topics: [WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC, convTop, otherConvTop, saTop],
      entities: [
        {
          topic: WORKSPACES_TOPIC,
          entity: 'workspace',
          id: 'w1',
          value: { id: 'w1', name: 'Test Workspace', path: '/test', source: 'local' },
        },
        {
          topic: WORKSPACES_TOPIC,
          entity: 'conversation_summary',
          id: cid,
          value: { id: cid, workspaceId: 'w1', title: 'Conversation 1', updatedAt: Date.now() },
        },
        {
          topic: WORKSPACES_TOPIC,
          entity: 'conversation_summary',
          id: otherCid,
          value: { id: otherCid, workspaceId: 'w1', title: 'Conversation 2', updatedAt: Date.now() },
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
            run: { status: 'running', startedAt: Date.now(), pendingText: null, canSend: false, canStop: true, lockedReason: null, error: null },
            context: { used: 0, window: 128000, percent: 0, level: 'ok' },
            itemIds: ['u1', 'tg1', 'a1'],
          },
        },
        {
          topic: otherConvTop,
          entity: 'conversation',
          id: otherCid,
          value: {
            id: otherCid,
            workspaceId: 'w1',
            title: 'Conversation 2',
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
          entity: 'item',
          id: 'u1',
          value: { kind: 'user', id: 'u1', text: 'Hello', pathRefs: [] },
        },
        {
          topic: convTop,
          entity: 'item',
          id: 'tg1',
          value: {
            kind: 'tool_group',
            id: 'tg1',
            toolIds: ['t1'],
            live: false,
            summary: { title: 'Dispatch', running: false, failed: false, succeeded: true, count: 1 },
          },
        },
        {
          topic: convTop,
          entity: 'tool',
          id: 't1',
          value: {
            id: 't1',
            kind: 'subagent',
            status: 'success',
            heading: { title: 'Spawn subagent', detail: '' },
            output: { preview: 'done', text: 'done' },
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
        {
          topic: convTop,
          entity: 'item',
          id: 'a1',
          value: {
            kind: 'assistant',
            id: 'a1',
            text: '',
            streaming: true,
            pathRefs: [],
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
      setExtraConversationIds: () => {},
      retainTopic: () => {},
      releaseTopic: () => {},
      topics: [WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC, convTop, otherConvTop, saTop],
    };

    let threadRenders = 0;
    let rightPaneRenders = 0;
    let sidebarRenders = 0;
    let toolGroupItemRenders = 0;
    let otherConversationRenders = 0;
    let notifyCount = 0;

    store.subscribe(() => {
      notifyCount++;
    });

    let currentDeltaIndex = -1;

    const handleToolGroupRender = () => { toolGroupItemRenders++; };

    function ThreadContainer() {
      const { items, toolsById, changes, actions } = useConversation(cid);
      return createElement(
        Profiler,
        { id: 'Thread', onRender: () => { threadRenders++; } },
        createElement(Thread, {
          items,
          toolsById,
          lang,
          running: true,
          actions,
          stickNonce: 0,
          conversationId: cid,
          changes,
          onToolGroupRender: handleToolGroupRender,
        }),
      );
    }

    function OtherConversationTracker() {
      const { conversation } = useConversation(otherCid);
      return createElement(
        Profiler,
        { id: 'OtherConversation', onRender: (_id, phase) => {
          otherConversationRenders++;
          console.log('OtherConversation rendered phase:', phase, 'renders:', otherConversationRenders);
        } },
        createElement('div', { 'data-other': conversation?.id || '' }),
      );
    }

    function TestApp() {
      return createElement(
        SessionContext.Provider,
        { value: sessionValue },
        createElement(
          LeftPanelProvider,
          null,
          createElement(
            RightPaneProvider,
            { conversationId: cid, workspaceId: 'w1', lang, onToast: () => {} },
            createElement('div', null, [
              createElement(
                Profiler,
                { key: 'sidebar', id: 'Sidebar', onRender: (_id, phase) => {
                  sidebarRenders++;
                  console.log('Sidebar rendered phase:', phase, 'renders:', sidebarRenders, 'at i =', currentDeltaIndex);
                } },
                createElement(Sidebar, {
                  lang,
                  activeConversationId: cid,
                  activeAgentId: null,
                  draftWorkspaceId: null,
                  onCollapse: () => {},
                  onToast: () => {},
                  onConfirm: async () => true,
                  onRemoveWorkspace: async () => {},
                  onNewWorkspace: () => {},
                }),
              ),
              createElement(ThreadContainer, { key: 'thread' }),
              createElement(
                Profiler,
                { key: 'rightpane', id: 'RightPane', onRender: () => { rightPaneRenders++; } },
                createElement(RightPane, { lang, workspaceLabel: 'w1' }),
              ),
              createElement(OtherConversationTracker, { key: 'other' }),
            ]),
          ),
        ),
      );
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(createElement(TestApp));
    });
    // Wait for entrance animation timers to settle
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // Reset counters after initial mount is completely settled
    threadRenders = 0;
    rightPaneRenders = 0;
    sidebarRenders = 0;
    toolGroupItemRenders = 0;
    otherConversationRenders = 0;
    notifyCount = 0;

    // Simulate 20,000 chars across 2,000 deltas (10 chars each)
    const chunk = '1234567890';
    const totalDeltas = 2000;
    let frames = 0;

    await act(async () => {
      for (let i = 0; i < totalDeltas; i++) {
        currentDeltaIndex = i;
        store.applyTextDelta({
          topic: convTop,
          itemId: 'a1',
          offset: i * 10,
          append: chunk,
        });

        // Batch deltas in groups of 20 per frame
        if (i % 20 === 0) {
          store.flush();
          frames++;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      store.flush();
      frames++;
    });

    const finalItem = store.items(cid).find((it) => it.id === 'a1') as { text?: string } | undefined;
    const textLength = (finalItem?.text ?? '').length;

    console.log('AFTER COUNTS:', {
      totalDeltas,
      frames,
      notifyCount,
      threadRenders,
      rightPaneRenders,
      sidebarRenders,
      toolGroupItemRenders,
      otherConversationRenders,
      textLength,
    });

    // 1. Text is correctly reconstructed
    expect(textLength).toBe(20000);

    // 2. Notification batching: notification count does not exceed number of frames
    expect(notifyCount).toBeLessThanOrEqual(frames);

    // 3. Components unrelated to this conversation (Sidebar, other conversations) DO NOT grow with deltas count
    expect(sidebarRenders).toBe(0);
    expect(otherConversationRenders).toBe(0);

    // 4. ToolGroupItem only subscribes to its subagent and is not re-rendered by text streaming deltas
    expect(toolGroupItemRenders).toBe(0);
  });

  it('batches 2,000 deltas arriving in a single synchronous burst into a single notification', async () => {
    const store = createEntityStore();
    const cid = 'c1';
    const convTop = conversationTopic(cid);
    const saTop = subagentTopic(cid, 'sa-1');

    store.applySnapshot({
      protocolVersion: '2.0',
      topics: [WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC, convTop, saTop],
      entities: [
        {
          topic: WORKSPACES_TOPIC,
          entity: 'workspace',
          id: 'w1',
          value: { id: 'w1', name: 'Test Workspace', path: '/test', source: 'local' },
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
            run: { status: 'running', startedAt: Date.now(), pendingText: null, canSend: false, canStop: true, lockedReason: null, error: null },
            context: { used: 0, window: 128000, percent: 0, level: 'ok' },
            itemIds: ['a1'],
          },
        },
        {
          topic: convTop,
          entity: 'item',
          id: 'a1',
          value: {
            kind: 'assistant',
            id: 'a1',
            text: '',
            streaming: true,
            pathRefs: [],
          },
        },
      ],
    });

    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });

    // 2,000 deltas arriving in a single synchronous burst
    for (let i = 0; i < 2000; i++) {
      store.applyTextDelta({
        topic: convTop,
        itemId: 'a1',
        offset: i * 10,
        append: '1234567890',
      });
    }

    expect(notifications).toBe(0);

    store.flush();
    expect(notifications).toBe(1);

    const finalItem = store.items(cid).find((it) => it.id === 'a1') as { text?: string } | undefined;
    expect(finalItem?.text?.length).toBe(20000);
  });
});
