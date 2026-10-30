// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentReport } from './SubagentReport';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { conversationTopic, createEntityStore, type Subagent } from '../data/store';
import type { components } from '../../../src/v2/contract.gen';

type ThreadItemSubagentReport = components['schemas']['ThreadItemSubagentReport'];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function makeAgent(overrides: Partial<Subagent>): Subagent {
  return {
    id: 'c1:sub:sa-1',
    parentConversationId: 'c1',
    title: '补 text.delta 偏移的用例',
    name: 'sub-delta-test',
    mode: 'background',
    status: 'done',
    startedAt: 1000,
    lastActivityAt: 2000,
    endedAt: 2000,
    currentAction: null,
    progress: null,
    toolCallId: null,
    ...overrides,
  };
}

function makeReport(overrides: Partial<ThreadItemSubagentReport> = {}): ThreadItemSubagentReport {
  return {
    id: 'r1',
    kind: 'subagent_report',
    subagentId: 'c1:sub:sa-1',
    name: 'sub-delta-test',
    reportKind: 'answered',
    body: '所有测试通过。',
    ...overrides,
  };
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

describe('SubagentReport component', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await cleanup();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('displays subagent title when found in store', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    const store = createEntityStore();
    const cid = 'c1';
    const convTop = conversationTopic(cid);

    store.applySnapshot({
      protocolVersion: '2.0.0',
      topics: [convTop],
      entities: [
        {
          topic: convTop,
          entity: 'subagent',
          id: 'c1:sub:sa-1',
          value: makeAgent({ id: 'c1:sub:sa-1', title: '补 text.delta 偏移的用例' }),
        },
      ],
    });

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
            <SubagentReport item={makeReport()} lang="zh" conversationId={cid} />
          </RightPaneProvider>
        </SessionContext.Provider>,
      );
    });

    const summary = host!.querySelector('[data-testid="next-subagent-report-summary"]');
    expect(summary).toBeTruthy();
    expect(summary!.textContent).toContain('子 Agent「补 text.delta 偏移的用例」已交回结果');
    expect(summary!.textContent).not.toContain('sub-delta-test');
  });

  it('falls back to item.name when subagent is not found in store or title is empty', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    const store = createEntityStore();
    const cid = 'c1';

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
            <SubagentReport item={makeReport({ subagentId: 'c1:sub:unknown', name: 'fallback-worker' })} lang="zh" conversationId={cid} />
          </RightPaneProvider>
        </SessionContext.Provider>,
      );
    });

    const summary = host!.querySelector('[data-testid="next-subagent-report-summary"]');
    expect(summary).toBeTruthy();
    expect(summary!.textContent).toContain('子 Agent「fallback-worker」已交回结果');
  });

  it('refreshes title when subagent data arrives late via subscription', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    const store = createEntityStore();
    const cid = 'c1';
    const convTop = conversationTopic(cid);

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

    // 1. Initially no subagent in store: renders with fallback item.name
    await act(async () => {
      root!.render(
        <SessionContext.Provider value={sessionValue}>
          <RightPaneProvider conversationId={cid} workspaceId={null} lang="zh" onToast={vi.fn()}>
            <SubagentReport item={makeReport()} lang="zh" conversationId={cid} />
          </RightPaneProvider>
        </SessionContext.Provider>,
      );
    });

    const summaryBefore = host!.querySelector('[data-testid="next-subagent-report-summary"]');
    expect(summaryBefore!.textContent).toContain('子 Agent「sub-delta-test」已交回结果');

    // 2. Data arrives late: subagent snapshot is ingested and store is flushed
    await act(async () => {
      store.applySnapshot({
        protocolVersion: '2.0.0',
        topics: [convTop],
        entities: [
          {
            topic: convTop,
            entity: 'subagent',
            id: 'c1:sub:sa-1',
            value: makeAgent({ id: 'c1:sub:sa-1', title: '晚到的子 Agent 标题' }),
          },
        ],
      });
      store.flush();
    });

    // 3. SubagentReport automatically re-renders with the newly available title
    const summaryAfter = host!.querySelector('[data-testid="next-subagent-report-summary"]');
    expect(summaryAfter!.textContent).toContain('子 Agent「晚到的子 Agent 标题」已交回结果');
    expect(summaryAfter!.textContent).not.toContain('sub-delta-test');
  });
});
