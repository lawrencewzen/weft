// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRow } from './ToolRow';
import { SessionContext, type SessionValue } from '../data/session';
import { RightPaneProvider } from '../data/rightPaneContext';
import { createEntityStore, type ToolCall } from '../data/store';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function makeBashTool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'bash-1',
    groupId: 'group-1',
    kind: 'bash',
    status: 'done',
    heading: { title: 'pytest -q', detail: '', fromIntent: false },
    hint: { text: '2 passed', failed: false },
    failure: 'none',
    diff: null,
    output: {
      preview: 'running tests...\npassed',
      truncated: false,
      totalLines: 2,
    },
    ...overrides,
  };
}

async function renderToolRow(
  tool: ToolCall,
  onLoadOutput: (id: string) => Promise<{ text: string }> = vi.fn().mockResolvedValue({ text: 'full output' }),
  store = createEntityStore(),
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  const sessionValue: SessionValue = {
    store,
    status: 'connected',
    conversationId: 'c1',
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
        <RightPaneProvider conversationId="c1" workspaceId={null} lang="zh" onToast={vi.fn()}>
          <ToolRow tool={tool} lang="zh" onLoadOutput={onLoadOutput} />
        </RightPaneProvider>
      </SessionContext.Provider>,
    );
  });
}

describe('ToolRow in-place bash command output', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  it('renders bash command without terminal jump button', async () => {
    const tool = makeBashTool();
    await renderToolRow(tool);

    expect(host!.querySelector('[data-testid="next-tool-row"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-tool-open-term"]')).toBeNull();
  });

  it('expands command output in place when tool row is clicked', async () => {
    const tool = makeBashTool({
      output: {
        preview: 'tick-0\ntick-1',
        truncated: false,
        totalLines: 2,
      },
    });
    await renderToolRow(tool);

    const detailCard = host!.querySelector<HTMLElement>('[data-testid="next-tool-row-detail"]');
    expect(detailCard?.style.display).toBe('none');

    const row = host!.querySelector<HTMLElement>('[data-testid="next-tool-row"]')!;
    await act(async () => {
      row.click();
    });

    expect(detailCard?.style.display).toBe('block');
    const block = host!.querySelector('[data-testid="next-tool-row-detail"] .tool-detail-block');
    expect(block?.textContent).toContain('tick-0\ntick-1');
  });

  it('已截断的完成输出，展开只显示预览，点显示全部才调用 onLoadOutput', async () => {
    const onLoadOutput = vi.fn().mockResolvedValue({ text: 'full output text: 100 lines' });
    const tool = makeBashTool({
      status: 'done',
      output: {
        preview: 'truncated preview...',
        truncated: true,
        totalLines: 100,
      },
    });
    await renderToolRow(tool, onLoadOutput);

    const row = host!.querySelector<HTMLElement>('[data-testid="next-tool-row"]')!;
    await act(async () => {
      row.click();
    });

    // 展开后仅显示预览，不自动拉取全文
    expect(onLoadOutput).not.toHaveBeenCalled();
    const block = host!.querySelector('[data-testid="next-tool-row-detail"] .tool-detail-block');
    expect(block?.textContent).toBe('truncated preview...');

    // 显示全部按钮可见，点击才触发 onLoadOutput 拉取全文
    const moreBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-tool-output-more"]');
    expect(moreBtn).not.toBeNull();

    await act(async () => {
      moreBtn!.click();
    });

    expect(onLoadOutput).toHaveBeenCalledTimes(1);
    expect(onLoadOutput).toHaveBeenCalledWith('bash-1');
    expect(block?.textContent).toBe('full output text: 100 lines');
  });

  it('shows live text while running, and returns to preview when done', async () => {
    const store = createEntityStore();
    store.applySnapshot({
      protocolVersion: '2.0',
      topics: ['topic:c1'],
      entities: [
        {
          topic: 'topic:c1',
          entity: 'tool',
          id: 'bash-1',
          value: {
            id: 'bash-1',
            groupId: 'g1',
            kind: 'bash',
            status: 'running',
            heading: { title: 'node test', detail: '', fromIntent: false },
            hint: { text: 'running', failed: false },
            failure: 'none',
            diff: null,
            output: { preview: 'initial', truncated: true, totalLines: 5 },
          },
        },
      ],
    });
    store.applyToolDelta({
      topic: 'topic:c1',
      toolId: 'bash-1',
      set: 'live tick-0\nlive tick-1',
    });

    const tool = store.tool('bash-1')!;
    await renderToolRow(tool, vi.fn(), store);

    const row = host!.querySelector<HTMLElement>('[data-testid="next-tool-row"]')!;
    await act(async () => {
      row.click();
    });

    const block = host!.querySelector('[data-testid="next-tool-row-detail"] .tool-detail-block');
    expect(block?.textContent).toBe('live tick-0\nlive tick-1');
  });
});
