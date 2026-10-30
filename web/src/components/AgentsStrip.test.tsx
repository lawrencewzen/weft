// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../data/api';
import { FOCUS_SUBAGENT_EVENT } from '../data/focusSubagent';
import { SessionContext, type SessionValue } from '../data/session';
import { conversationTopic, createEntityStore, subagentTopic, type Subagent, type ToolCall } from '../data/store';
import { AgentsStrip } from './AgentsStrip';
import {
  countByIconStatus,
  extractSubagentSteps,
  formatAgentDoing,
  formatAgentElapsed,
  formatAgentsHeadline,
  hasUnendedAgents,
  isAllEndedAgents,
  stripMarkdownInline,
} from './agentsStripUtils';

function makeAgent(overrides: Partial<Subagent>): Subagent {
  return {
    id: 'c1:sub:a1',
    parentConversationId: 'c1',
    title: 'Agent 1',
    name: 'a1',
    mode: 'background',
    status: 'running',
    startedAt: 1000,
    lastActivityAt: 2000,
    endedAt: null,
    currentAction: 'Reading files',
    progress: null,
    toolCallId: null,
    ...overrides,
  };
}

describe('agentsStripUtils', () => {
  describe('summary and headline formatting & priorities', () => {
    it('counts statuses correctly', () => {
      const agents: Subagent[] = [
        makeAgent({ id: '1', status: 'running' }),
        makeAgent({ id: '2', status: 'running' }),
        makeAgent({ id: '3', status: 'stuck' }),
        makeAgent({ id: '4', status: 'waiting' }),
        makeAgent({ id: '5', status: 'done' }),
        makeAgent({ id: '6', status: 'failed' }),
      ];
      const counts = countByIconStatus(agents);
      expect(counts).toEqual([
        { status: 'running', count: 2 },
        { status: 'stuck', count: 1 },
        { status: 'queued', count: 1 },
        { status: 'done', count: 1 },
        { status: 'failed', count: 1 },
      ]);
    });

    it('prioritizes running/queued over completed/failed in headlines', () => {
      const liveAndEnded: Subagent[] = [
        makeAgent({ id: '1', status: 'running' }),
        makeAgent({ id: '2', status: 'waiting' }),
        makeAgent({ id: '3', status: 'done' }),
        makeAgent({ id: '4', status: 'failed' }),
      ];
      expect(formatAgentsHeadline(liveAndEnded, 'zh')).toBe('1 个运行中 · 1 个排队');
      expect(formatAgentsHeadline(liveAndEnded, 'en')).toBe('1 running · 1 queued');
    });

    it('formats running-only headline', () => {
      const agents: Subagent[] = [
        makeAgent({ id: '1', status: 'running' }),
        makeAgent({ id: '2', status: 'running' }),
      ];
      expect(formatAgentsHeadline(agents, 'zh')).toBe('2 个运行中');
      expect(formatAgentsHeadline(agents, 'en')).toBe('2 running');
    });

    it('formats running, stuck, and queued together', () => {
      const agents: Subagent[] = [
        makeAgent({ id: '1', status: 'running' }),
        makeAgent({ id: '2', status: 'running' }),
        makeAgent({ id: '3', status: 'stuck' }),
        makeAgent({ id: '4', status: 'waiting' }),
      ];
      expect(formatAgentsHeadline(agents, 'zh')).toBe('2 个运行中 · 1 个卡住 · 1 个排队');
      expect(formatAgentsHeadline(agents, 'en')).toBe('2 running · 1 stuck · 1 queued');
    });

    it('formats queued-only headline', () => {
      const agents: Subagent[] = [
        makeAgent({ id: '1', status: 'waiting' }),
      ];
      expect(formatAgentsHeadline(agents, 'zh')).toBe('1 个排队');
      expect(formatAgentsHeadline(agents, 'en')).toBe('1 queued');
    });

    it('formats all-ended headline with done and failed', () => {
      const agents: Subagent[] = [
        makeAgent({ id: '1', status: 'done' }),
        makeAgent({ id: '2', status: 'done' }),
        makeAgent({ id: '3', status: 'failed' }),
      ];
      expect(formatAgentsHeadline(agents, 'zh')).toBe('2 个已完成 · 1 个没完成');
      expect(formatAgentsHeadline(agents, 'en')).toBe('2 completed · 1 uncompleted');
    });

    it('formats all-done headline', () => {
      const agents: Subagent[] = [
        makeAgent({ id: '1', status: 'done' }),
        makeAgent({ id: '2', status: 'done' }),
      ];
      expect(formatAgentsHeadline(agents, 'zh')).toBe('2 个已完成');
      expect(formatAgentsHeadline(agents, 'en')).toBe('2 completed');
    });

    it('formats all-failed headline', () => {
      const agents: Subagent[] = [
        makeAgent({ id: '1', status: 'failed' }),
      ];
      expect(formatAgentsHeadline(agents, 'zh')).toBe('1 个没完成');
      expect(formatAgentsHeadline(agents, 'en')).toBe('1 uncompleted');
    });
  });

  describe('doing text and steps extraction', () => {
    it('formats doing text for various statuses and strips markdown', () => {
      const done = makeAgent({ status: 'done' });
      expect(formatAgentDoing(done, { lang: 'zh', resText: '补好了 `text.delta` 偏移的两条用例\n第二行' })).toBe('补好了 text.delta 偏移的两条用例');

      const queued = makeAgent({ status: 'waiting' });
      expect(formatAgentDoing(queued, { lang: 'zh' })).toBe('排队中');

      const failed = makeAgent({ status: 'failed' });
      expect(formatAgentDoing(failed, { lang: 'zh' })).toBe('没完成，原因已汇报给主 Agent');

      const running = makeAgent({ status: 'running', currentAction: '正在读取 `store.ts`' });
      expect(formatAgentDoing(running, { lang: 'zh' })).toBe('正在读取 store.ts');
    });

    it('strips inline markdown from plain text summaries', () => {
      expect(stripMarkdownInline('补好了 `text.delta` 偏移的两条用例，`npm run test:web` 全绿。')).toBe(
        '补好了 text.delta 偏移的两条用例，npm run test:web 全绿。',
      );
      expect(stripMarkdownInline('**粗体** 与 *斜体* 以及 [链接](http://example.com)')).toBe(
        '粗体 与 斜体 以及 链接',
      );
    });

    it('formats elapsed time only for unended, non-queued agents', () => {
      const running = makeAgent({ status: 'running', startedAt: 10_000 });
      expect(formatAgentElapsed(running, 75_000)).toBe('01:05');

      const stuck = makeAgent({ status: 'stuck', startedAt: 10_000 });
      expect(formatAgentElapsed(stuck, 75_000)).toBe('01:05');

      const queued = makeAgent({ status: 'waiting', startedAt: 10_000 });
      expect(formatAgentElapsed(queued, 75_000)).toBe('');

      const done = makeAgent({ status: 'done', startedAt: 10_000 });
      expect(formatAgentElapsed(done, 75_000)).toBe('');

      const failed = makeAgent({ status: 'failed', startedAt: 10_000 });
      expect(formatAgentElapsed(failed, 75_000)).toBe('');
    });

    it('extracts up to 3 recent steps from subagent topic items', () => {
      const toolsById: Record<string, ToolCall> = {
        t1: {
          id: 't1',
          groupId: 'g1',
          kind: 'read' as const,
          status: 'done' as const,
          heading: { title: 'read', detail: 'store.ts', fromIntent: false },
          path: 'store.ts',
          hint: { text: '', failed: false },
          failure: 'none' as const,
          diff: null,
          output: { preview: '', totalLines: 0, truncated: false },
        },
        t2: {
          id: 't2',
          groupId: 'g1',
          kind: 'grep' as const,
          status: 'done' as const,
          heading: { title: 'search', detail: 'applySnapshot', fromIntent: false },
          hint: { text: '', failed: false },
          failure: 'none' as const,
          diff: null,
          output: { preview: '', totalLines: 0, truncated: false },
        },
        t3: {
          id: 't3',
          groupId: 'g1',
          kind: 'bash' as const,
          status: 'running' as const,
          heading: { title: 'run', detail: 'npm test', fromIntent: false },
          hint: { text: '', failed: false },
          failure: 'none' as const,
          diff: null,
          output: { preview: '', totalLines: 0, truncated: false },
        },
      };
      const items = [
        { kind: 'tool_group' as const, id: 'g1', toolIds: ['t1', 't2', 't3'], summary: { text: '', running: false, failed: 0 }, live: false },
      ];
      const steps = extractSubagentSteps(items, toolsById, 'zh');
      expect(steps).toEqual([
        { verb: '读取', desc: 'store.ts' },
        { verb: '搜索', desc: 'applySnapshot' },
        { verb: '执行', desc: 'npm test' },
      ]);
    });
  });

  describe('unended and allEnded checks', () => {
    it('detects unended agents', () => {
      expect(hasUnendedAgents([makeAgent({ status: 'running' })])).toBe(true);
      expect(hasUnendedAgents([makeAgent({ status: 'waiting' })])).toBe(true);
      expect(hasUnendedAgents([makeAgent({ status: 'done' })])).toBe(false);
    });

    it('detects all ended agents', () => {
      expect(isAllEndedAgents([])).toBe(false);
      expect(isAllEndedAgents([makeAgent({ status: 'done' })])).toBe(true);
      expect(isAllEndedAgents([makeAgent({ status: 'done' }), makeAgent({ status: 'failed' })])).toBe(true);
      expect(isAllEndedAgents([makeAgent({ status: 'done' }), makeAgent({ status: 'running' })])).toBe(false);
    });
  });
});

describe('AgentsStrip component', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderStrip(store: ReturnType<typeof createEntityStore>, cid: string) {
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
    act(() => {
      root!.render(
        createElement(
          SessionContext.Provider,
          { value: sessionValue },
          createElement(AgentsStrip, { cid, lang: 'zh' }),
        ),
      );
    });
  }

  it('does not auto-expand when loaded; clicking toggle expands and collapses list', () => {
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
          id: 'sa1',
          value: makeAgent({ id: 'sa1', title: 'Task Alpha', name: 'agent-one', status: 'running' }),
        },
        {
          topic: convTop,
          entity: 'subagent',
          id: 'sa2',
          value: makeAgent({ id: 'sa2', title: '', name: 'agent-two', status: 'waiting' }),
        },
      ],
    });

    renderStrip(store, cid);

    const strip = host!.querySelector('[data-testid="next-agents-strip"]');
    expect(strip).toBeTruthy();
    expect(strip!.classList.contains('open')).toBe(false);
    expect(strip!.getAttribute('data-open')).toBe('false');

    // List should not be rendered when collapsed
    expect(host!.querySelector('[data-testid="next-agents-strip-list"]')).toBeNull();

    // Click header to expand
    const toggle = host!.querySelector('[data-testid="next-agents-strip-toggle"]');
    expect(toggle).toBeTruthy();
    act(() => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(strip!.classList.contains('open')).toBe(true);
    expect(strip!.getAttribute('data-open')).toBe('true');
    expect(host!.querySelector('[data-testid="next-agents-strip-list"]')).toBeTruthy();
    const rows = host!.querySelectorAll('[data-testid="next-agents-strip-row"]');
    expect(rows.length).toBe(2);

    // Row 1 prefers title, Row 2 falls back to name
    const names = host!.querySelectorAll('[data-testid="next-agents-strip-name"]');
    expect(names[0]?.textContent?.trim()).toBe('Task Alpha');
    expect(names[1]?.textContent?.trim()).toBe('agent-two');

    // Click header again to collapse
    act(() => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(strip!.classList.contains('open')).toBe(false);
    expect(strip!.getAttribute('data-open')).toBe('false');
    expect(host!.querySelector('[data-testid="next-agents-strip-list"]')).toBeNull();
  });

  it('supports in-place row expansion for running, queued, done, and failed', () => {
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
          id: 'sa-run',
          value: makeAgent({ id: 'sa-run', name: 'agent-run', status: 'running', currentAction: 'Doing work' }),
        },
        {
          topic: convTop,
          entity: 'subagent',
          id: 'sa-wait',
          value: makeAgent({ id: 'sa-wait', name: 'agent-wait', status: 'waiting' }),
        },
        {
          topic: convTop,
          entity: 'subagent',
          id: 'sa-done',
          value: makeAgent({ id: 'sa-done', name: 'agent-done', status: 'done' }),
        },
        {
          topic: convTop,
          entity: 'subagent',
          id: 'sa-fail',
          value: makeAgent({ id: 'sa-fail', name: 'agent-fail', status: 'failed' }),
        },
      ],
    });

    // Subagent topics with last assistant text
    const doneTop = subagentTopic(cid, 'sa-done');
    const failTop = subagentTopic(cid, 'sa-fail');
    store.applySnapshot({
      protocolVersion: '2.0.0',
      topics: [doneTop, failTop],
      entities: [
        {
          topic: doneTop,
          entity: 'item',
          id: 'item-d1',
          value: { kind: 'assistant', id: 'a1', text: '执行成功，结论已汇总。' },
        },
        {
          topic: failTop,
          entity: 'item',
          id: 'item-f1',
          value: { kind: 'assistant', id: 'a2', text: '用例执行失败，退出码 1。' },
        },
      ],
    });

    renderStrip(store, cid);

    // Expand strip
    act(() => {
      host!.querySelector('[data-testid="next-agents-strip-toggle"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Expand done row
    const doneRow = host!.querySelector('[data-row="sa-done"]');
    act(() => {
      doneRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const doneDetail = host!.querySelector('[data-testid="next-agents-strip-detail-text"]');
    expect(doneDetail?.textContent).toContain('执行成功，结论已汇总');

    // Expand wait row
    const waitRow = host!.querySelector('[data-row="sa-wait"]');
    act(() => {
      waitRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const waitDetail = host!.querySelector('[data-testid="next-agents-strip-detail-text"]');
    expect(waitDetail?.textContent).toContain('还没开始');

    // Expand fail row
    const failRow = host!.querySelector('[data-row="sa-fail"]');
    act(() => {
      failRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const failDetail = host!.querySelector('[data-testid="next-agents-strip-detail-text"]');
    expect(failDetail?.textContent).toContain('没完成：');
    expect(failDetail?.textContent).toContain('用例执行失败');
  });

  it('clicking stop button calls stopSubagent API without toggling row', async () => {
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
          id: 'sa1',
          value: makeAgent({ id: 'sa1', name: 'agent-run', status: 'running' }),
        },
      ],
    });

    const stopSpy = vi.spyOn(api, 'stopSubagent').mockResolvedValue({ stopping: true });

    renderStrip(store, cid);

    // Expand strip
    act(() => {
      host!.querySelector('[data-testid="next-agents-strip-toggle"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const stopBtn = host!.querySelector('[data-testid="next-agents-strip-stop"]');
    expect(stopBtn).toBeTruthy();

    await act(async () => {
      stopBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(stopSpy).toHaveBeenCalledWith('c1', 'sa1');
    // Row detail should NOT be opened because ev.stopPropagation was called
    expect(host!.querySelector('[data-testid="next-agents-strip-detail"]')).toBeNull();
  });

  it('focus subagent event opens strip and expands that subagent row', () => {
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
          id: 'sa1',
          value: makeAgent({ id: 'sa1', name: 'agent-1', status: 'running' }),
        },
      ],
    });

    renderStrip(store, cid);

    const strip = host!.querySelector('[data-testid="next-agents-strip"]');
    expect(strip!.classList.contains('open')).toBe(false);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(FOCUS_SUBAGENT_EVENT, { detail: { agentId: 'sa1' } }),
      );
    });

    expect(strip!.classList.contains('open')).toBe(true);
    expect(host!.querySelector('[data-testid="next-agents-strip-detail"]')).toBeTruthy();
  });

  it('transitions to all-ended: waits 6s, then fades out, then disappears', () => {
    const store = createEntityStore();
    const cid = 'c1';
    const convTop = conversationTopic(cid);
    // Initially running
    store.applySnapshot({
      protocolVersion: '2.0.0',
      topics: [convTop],
      entities: [
        {
          topic: convTop,
          entity: 'subagent',
          id: 'sa1',
          value: makeAgent({ id: 'sa1', name: 'agent-1', status: 'running' }),
        },
      ],
    });

    renderStrip(store, cid);
    let strip = host!.querySelector('[data-testid="next-agents-strip"]');
    expect(strip).toBeTruthy();

    // Now all complete
    act(() => {
      store.applyUpsert({
        topic: convTop,
        entity: 'subagent',
        id: 'sa1',
        value: makeAgent({ id: 'sa1', name: 'agent-1', status: 'done' }) as unknown as Record<string, unknown>,
      });
      store.flush();
    });

    // Should still be visible showing completed headline
    strip = host!.querySelector('[data-testid="next-agents-strip"]');
    expect(strip).toBeTruthy();
    expect(host!.querySelector('[data-testid="next-agents-strip-headline"]')?.textContent).toBe('1 个已完成');
    expect(strip!.classList.contains('fade')).toBe(false);

    // Fast-forward 5.9 seconds: still visible, not faded yet
    act(() => {
      vi.advanceTimersByTime(5900);
    });
    expect(strip!.classList.contains('fade')).toBe(false);

    // Fast-forward another 200ms (reaches 6.1s): starts fading
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(strip!.classList.contains('fade')).toBe(true);

    // Fast-forward 450ms (transition ends): hidden
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(host!.querySelector('[data-testid="next-agents-strip"]')).toBeNull();
  });
});
