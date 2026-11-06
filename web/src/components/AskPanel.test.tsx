/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskPanel } from './AskPanel';
import * as api from '../data/api';
import { SessionContext, type SessionValue } from '../data/session';
import { createEntityStore } from '../data/store';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

function makeAskTool(questions: api.AskQuestion[], overrides: Partial<api.ToolCall> = {}): api.ToolCall {
  return {
    id: 'tool-ask-test',
    groupId: 'g-test',
    kind: 'ask',
    status: 'done',
    heading: { title: 'Test Questions', detail: '', fromIntent: false },
    hint: { text: '等待回答', failed: false },
    failure: null,
    diff: null,
    output: { preview: '', truncated: false, totalLines: 0 },
    ask: {
      questions,
      answer: null,
    },
    ...overrides,
  } as unknown as api.ToolCall;
}

const SINGLE_QUESTION: api.AskQuestion = {
  question: '用哪种包管理器？',
  header: '包管理器',
  multiSelect: false,
  options: [
    { label: 'npm', description: 'Node 自带' },
    { label: 'pnpm', description: '节省磁盘' },
  ],
};

const MULTI_QUESTION: api.AskQuestion = {
  question: '要跑哪些检查？',
  header: '检查',
  multiSelect: true,
  options: [
    { label: 'lint', description: '只看风格' },
    { label: 'test', description: '跑单元测试' },
    { label: 'typecheck', description: '查类型' },
  ],
};

describe('AskPanel', () => {
  let store: ReturnType<typeof createEntityStore>;
  let sendAnswerSpy: ReturnType<typeof vi.spyOn>;
  let getSnapshotSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sessionStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store = createEntityStore();

    sendAnswerSpy = vi.spyOn(api, 'sendAnswer').mockResolvedValue({ runId: 'run-1' });
    getSnapshotSpy = vi.spyOn(api, 'getSnapshot').mockResolvedValue({
      conversation: {
        id: 'c1',
        title: 'test',
        workspaceId: 'ws1',
        updatedAt: 0,
        status: 'idle',
        model: null,
        run: {
          status: 'idle',
          startedAt: null,
          pendingText: null,
          canSend: true,
          canStop: false,
          lockedReason: null,
          error: null,
          lastActivityAt: null,
          stalledSince: null,
          activeTool: null,
        },
        context: { used: 0, window: 128000, percent: 0, level: 'ok' },
        itemIds: [],
      },
      items: [],
      tools: [],
    });
  });

  afterEach(() => {
    if (root && host) {
      act(() => {
        root?.unmount();
      });
      host.remove();
    }
    root = null;
    host = null;
    vi.restoreAllMocks();
  });

  async function renderPanel(
    tool: api.ToolCall,
    props: {
      canStop?: boolean;
      onStop?: () => void;
      onAnswered?: () => void;
      onDismiss?: () => void;
    } = {},
  ) {
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
      root?.render(
        <SessionContext.Provider value={sessionValue}>
          <AskPanel
            cid="c1"
            tool={tool}
            lang="zh"
            canStop={props.canStop}
            onStop={props.onStop}
            onAnswered={props.onAnswered}
            onDismiss={props.onDismiss}
          />
        </SessionContext.Provider>,
      );
    });
  }

  it('renders single question layout: no tabs or progress, shows compact options and permanent textarea', async () => {
    const tool = makeAskTool([SINGLE_QUESTION]);
    await renderPanel(tool);

    expect(host!.querySelector('[data-testid="next-ask-tab"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-ask-progress"]')).toBeNull();

    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');
    expect(options).toHaveLength(2);
    expect(options[0].querySelector('.ask-option-num')?.textContent).toBe('1');
    expect(options[0].querySelector('.ask-option-label')?.textContent).toBe('npm');
    expect(options[0].querySelector('.ask-option-desc')?.textContent).toBe('Node 自带');

    const textarea = host!.querySelector<HTMLTextAreaElement>('[data-testid="next-ask-other-input"]');
    expect(textarea).not.toBeNull();
    expect(textarea!.placeholder).toBe('其他…');

    // Only Skip and Submit buttons in single question
    expect(host!.querySelector('[data-testid="next-ask-prev"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-ask-next"]')).toBeNull();
    expect(host!.querySelector('[data-testid="next-ask-skip"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-ask-submit"]')).not.toBeNull();
  });

  it('handles single-select and textarea mutual exclusivity', async () => {
    const tool = makeAskTool([SINGLE_QUESTION]);
    await renderPanel(tool);

    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');
    const textarea = host!.querySelector<HTMLTextAreaElement>('[data-testid="next-ask-other-input"]')!;
    const submitBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-ask-submit"]')!;

    expect(submitBtn.disabled).toBe(true);

    // 1. Click option 0 ('npm')
    await act(async () => {
      options[0].click();
    });
    expect(options[0].getAttribute('aria-checked')).toBe('true');
    expect(submitBtn.disabled).toBe(false);

    // 2. Type in textarea -> clears option selection
    await act(async () => {
      setTextareaValue(textarea, 'bun');
    });
    expect(options[0].getAttribute('aria-checked')).toBe('false');
    expect(textarea.value).toBe('bun');
    expect(submitBtn.disabled).toBe(false);

    // 3. Click option 1 ('pnpm') -> selects pnpm, preserves text in textarea but mutes it
    await act(async () => {
      options[1].click();
    });
    expect(options[1].getAttribute('aria-checked')).toBe('true');
    expect(textarea.value).toBe('bun');
    expect(textarea.className).toContain('is-muted');

    // 4. Submit -> must NOT send 'bun', only sends selected: ['pnpm']
    await act(async () => {
      submitBtn.click();
    });

    expect(sendAnswerSpy).toHaveBeenCalledWith('c1', {
      toolCallId: 'tool-ask-test',
      answers: [{ questionIndex: 0, selected: ['pnpm'] }],
    });
  });

  it('handles multi-select: options and textarea submit together', async () => {
    const tool = makeAskTool([MULTI_QUESTION]);
    await renderPanel(tool);

    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');
    const textarea = host!.querySelector<HTMLTextAreaElement>('[data-testid="next-ask-other-input"]')!;
    const submitBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-ask-submit"]')!;

    // Select lint and typecheck
    await act(async () => {
      options[0].click();
      options[2].click();
    });

    // Add extra custom check
    await act(async () => {
      setTextareaValue(textarea, 'coverage');
    });

    expect(options[0].getAttribute('aria-checked')).toBe('true');
    expect(options[2].getAttribute('aria-checked')).toBe('true');
    expect(submitBtn.disabled).toBe(false);

    await act(async () => {
      submitBtn.click();
    });

    expect(sendAnswerSpy).toHaveBeenCalledWith('c1', {
      toolCallId: 'tool-ask-test',
      answers: [{ questionIndex: 0, selected: ['lint', 'typecheck'], other: 'coverage' }],
    });
  });

  it('auto-advances to next unanswered question after 150ms on single-select', async () => {
    vi.useFakeTimers();
    try {
      const tool = makeAskTool([SINGLE_QUESTION, MULTI_QUESTION]);
      await renderPanel(tool);

      const tabs = host!.querySelectorAll<HTMLButtonElement>('[data-testid="next-ask-tab"]');
      expect(tabs).toHaveLength(2);
      expect(tabs[0].getAttribute('aria-selected')).toBe('true');

      const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');
      // Click pnpm on question 1
      await act(async () => {
        options[1].click();
      });

      // Before timer finishes, still on tab 0
      expect(host!.querySelector('[data-testid="next-ask-progress"]')?.textContent).toBe('1 / 2');

      // Fast-forward 150ms
      await act(async () => {
        vi.advanceTimersByTime(150);
      });

      // Now automatically on tab 1!
      expect(host!.querySelector('[data-testid="next-ask-progress"]')?.textContent).toBe('2 / 2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders multi-question tabs, progress, and prev/next buttons', async () => {
    const tool = makeAskTool([SINGLE_QUESTION, MULTI_QUESTION]);
    await renderPanel(tool);

    const tabs = host!.querySelectorAll<HTMLButtonElement>('[data-testid="next-ask-tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toContain('包管理器');
    expect(tabs[1].textContent).toContain('检查');
    expect(host!.querySelector('[data-testid="next-ask-progress"]')?.textContent).toBe('1 / 2');

    // On question 1: no Prev, has Next
    expect(host!.querySelector('[data-testid="next-ask-prev"]')).toBeNull();
    const nextBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-ask-next"]');
    expect(nextBtn).not.toBeNull();
    expect(nextBtn!.textContent).toBe('下一题');

    // Click next -> switches to question 2
    await act(async () => {
      nextBtn!.click();
    });
    expect(host!.querySelector('[data-testid="next-ask-progress"]')?.textContent).toBe('2 / 2');

    // On question 2: has Prev, Next becomes Submit
    const prevBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-ask-prev"]');
    expect(prevBtn).not.toBeNull();
    expect(prevBtn!.textContent).toBe('上一题');

    const submitBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-ask-submit"]');
    expect(submitBtn).not.toBeNull();
    expect(submitBtn!.disabled).toBe(true); // not answered yet
  });

  it('shows Stop button when canStop is true and invokes onStop', async () => {
    const onStop = vi.fn();
    const tool = makeAskTool([SINGLE_QUESTION]);
    await renderPanel(tool, { canStop: true, onStop });

    const stopBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-ask-stop"]');
    expect(stopBtn).not.toBeNull();
    expect(stopBtn!.textContent).toBe('停止');

    await act(async () => {
      stopBtn!.click();
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('supports full keyboard navigation in options area: arrows, 1-4, space, and Enter', async () => {
    const tool = makeAskTool([SINGLE_QUESTION, MULTI_QUESTION]);
    await renderPanel(tool);

    const optionsContainer = host!.querySelector<HTMLDivElement>('.ask-options')!;
    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');

    // Press digit '2' to select second option ('pnpm')
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    });
    expect(options[1].getAttribute('aria-checked')).toBe('true');

    // Right arrow switches to question 2
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(host!.querySelector('[data-testid="next-ask-progress"]')?.textContent).toBe('2 / 2');

    // Down arrow then space selects option 1 on question 2
    const optionsContainer2 = host!.querySelector<HTMLDivElement>('.ask-options')!;
    await act(async () => {
      optionsContainer2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => {
      optionsContainer2.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    const options2 = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');
    expect(options2[1].getAttribute('aria-checked')).toBe('true');

    // ArrowUp back to option 0, then Enter on option 0 selects it and submits since all questions are now answered
    await act(async () => {
      optionsContainer2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    await act(async () => {
      optionsContainer2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sendAnswerSpy).toHaveBeenCalledTimes(1);
    expect(sendAnswerSpy).toHaveBeenCalledWith('c1', {
      toolCallId: 'tool-ask-test',
      answers: [
        { questionIndex: 0, selected: ['pnpm'] },
        { questionIndex: 1, selected: ['test', 'lint'] },
      ],
    });
  });

  it('handles textarea keyboard: ignores composing Enter, advances on Enter, returns to options on Esc', async () => {
    const tool = makeAskTool([SINGLE_QUESTION, MULTI_QUESTION]);
    await renderPanel(tool);

    const textarea = host!.querySelector<HTMLTextAreaElement>('[data-testid="next-ask-other-input"]')!;

    // Type text in textarea
    await act(async () => {
      setTextareaValue(textarea, 'yarn');
    });

    // IME composing Enter -> should NOT advance
    await act(async () => {
      const composingEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
      });
      Object.defineProperty(composingEvent, 'isComposing', { value: true });
      textarea.dispatchEvent(composingEvent);
    });
    expect(host!.querySelector('[data-testid="next-ask-progress"]')?.textContent).toBe('1 / 2');

    // Non-composing Enter -> advances to question 2
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(host!.querySelector('[data-testid="next-ask-progress"]')?.textContent).toBe('2 / 2');

    // Press Esc inside textarea -> returns focus to options area
    const textarea2 = host!.querySelector<HTMLTextAreaElement>('[data-testid="next-ask-other-input"]')!;
    await act(async () => {
      textarea2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    const options2 = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');
    expect(document.activeElement).toBe(options2[0]);
  });

  it('Enter on already-checked option never unchecks it in multi-select and submits when answered', async () => {
    const tool = makeAskTool([MULTI_QUESTION]);
    await renderPanel(tool);

    const optionsContainer = host!.querySelector<HTMLDivElement>('.ask-options')!;
    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');

    // Select option 0 ('lint') with Space
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(options[0].getAttribute('aria-checked')).toBe('true');

    // Arrow down to option 1 ('test') and select with Space
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(options[1].getAttribute('aria-checked')).toBe('true');

    // Arrow up back to option 0 ('lint') which is already checked
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });

    // Press Enter on already-checked option 0: must NOT uncheck it!
    // Since question is answered (and only 1 question), Enter submits with both options intact
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(options[0].getAttribute('aria-checked')).toBe('true');
    expect(options[1].getAttribute('aria-checked')).toBe('true');
    expect(sendAnswerSpy).toHaveBeenCalledTimes(1);
    expect(sendAnswerSpy).toHaveBeenCalledWith('c1', {
      toolCallId: 'tool-ask-test',
      answers: [
        { questionIndex: 0, selected: ['lint', 'test'] },
      ],
    });

    // Now test that Space DOES toggle/uncheck
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(options[0].getAttribute('aria-checked')).toBe('false');
  });

  it('Enter on already-selected option in single-select preserves selection and advances', async () => {
    const tool = makeAskTool([SINGLE_QUESTION, MULTI_QUESTION]);
    await renderPanel(tool);

    const optionsContainer = host!.querySelector<HTMLDivElement>('.ask-options')!;
    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');

    // Select option 0 ('npm') with Space
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(options[0].getAttribute('aria-checked')).toBe('true');

    // Press Enter on option 0 ('npm') which is already selected
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // Advances to question 2 without deselecting
    expect(host!.querySelector('[data-testid="next-ask-progress"]')?.textContent).toBe('2 / 2');
  });

  it('ignores modifier keys (Cmd/Ctrl/Alt) in options area to preserve selections for global shortcuts', async () => {
    const tool = makeAskTool([MULTI_QUESTION]);
    await renderPanel(tool);

    const optionsContainer = host!.querySelector<HTMLDivElement>('.ask-options')!;
    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');

    // Cmd+1 should NOT select option 0
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true }));
    });
    expect(options[0].getAttribute('aria-checked')).toBe('false');

    // Select option 0 with Space
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(options[0].getAttribute('aria-checked')).toBe('true');

    // Cmd+Enter on option 0 should NOT toggle option 0
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    });
    expect(options[0].getAttribute('aria-checked')).toBe('true');
  });

  it('handles Cmd/Ctrl+Enter in textarea: submits immediately without newline or toggling options', async () => {
    const tool = makeAskTool([SINGLE_QUESTION]);
    await renderPanel(tool);

    // Answer the question
    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');
    await act(async () => {
      options[0].click();
    });

    const textarea = host!.querySelector<HTMLTextAreaElement>('[data-testid="next-ask-other-input"]')!;

    // Shift+Enter allows newline (default not prevented)
    let shiftEnterEvt!: KeyboardEvent;
    await act(async () => {
      shiftEnterEvt = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true, bubbles: true });
      textarea.dispatchEvent(shiftEnterEvt);
    });
    expect(shiftEnterEvt.defaultPrevented).toBe(false);

    // Cmd+Enter prevents newline and submits
    let cmdEnterEvt!: KeyboardEvent;
    await act(async () => {
      cmdEnterEvt = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true, bubbles: true });
      textarea.dispatchEvent(cmdEnterEvt);
    });
    expect(cmdEnterEvt.defaultPrevented).toBe(true);
    expect(sendAnswerSpy).toHaveBeenCalledTimes(1);
    expect(sendAnswerSpy).toHaveBeenCalledWith('c1', {
      toolCallId: 'tool-ask-test',
      answers: [{ questionIndex: 0, selected: ['npm'] }],
    });
  });

  it('manages is-keyboard state: initial focus does not have is-focused, keyboard navigation activates it, click deactivates', async () => {
    const tool = makeAskTool([SINGLE_QUESTION]);
    await renderPanel(tool);

    const optionsContainer = host!.querySelector<HTMLDivElement>('.ask-options')!;
    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');

    // On initial mount: is-keyboard is not set, option 0 does NOT have is-focused class
    expect(optionsContainer.classList.contains('is-keyboard')).toBe(false);
    expect(options[0].classList.contains('is-focused')).toBe(false);

    // Press ArrowDown -> activates is-keyboard and option 1 becomes focused
    await act(async () => {
      optionsContainer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(optionsContainer.classList.contains('is-keyboard')).toBe(true);
    expect(options[1].classList.contains('is-focused')).toBe(true);

    // Mouse click on option -> deactivates is-keyboard
    await act(async () => {
      options[0].click();
    });
    expect(optionsContainer.classList.contains('is-keyboard')).toBe(false);
    expect(options[0].classList.contains('is-focused')).toBe(false);
  });

  it('persists draft in sessionStorage and clears on successful submission', async () => {
    const tool = makeAskTool([SINGLE_QUESTION]);
    await renderPanel(tool);

    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');
    await act(async () => {
      options[0].click();
    });

    const storageKey = 'weft:ask:c1:tool-ask-test';
    const saved = sessionStorage.getItem(storageKey);
    expect(saved).not.toBeNull();
    expect(saved).toContain('npm');

    // Submit successfully
    const submitBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-ask-submit"]')!;
    await act(async () => {
      submitBtn.click();
    });

    // sessionStorage cleared
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it('handles 409 conflict by refreshing snapshot and calling onDismiss', async () => {
    const onDismiss = vi.fn();
    sendAnswerSpy.mockRejectedValueOnce({ status: 409, code: 'E_ASK_ANSWERED' });

    const tool = makeAskTool([SINGLE_QUESTION]);
    await renderPanel(tool, { onDismiss });

    const options = host!.querySelectorAll<HTMLDivElement>('[data-testid="next-ask-option"]');
    await act(async () => {
      options[0].click();
    });

    const submitBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-ask-submit"]')!;
    await act(async () => {
      submitBtn.click();
    });

    expect(getSnapshotSpy).toHaveBeenCalledWith('c1', 'zh');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('handles skip action and calls onDismiss immediately', async () => {
    const onDismiss = vi.fn();
    const tool = makeAskTool([SINGLE_QUESTION]);
    await renderPanel(tool, { onDismiss });

    const skipBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-ask-skip"]')!;
    await act(async () => {
      skipBtn.click();
    });

    expect(sendAnswerSpy).toHaveBeenCalledWith('c1', {
      toolCallId: 'tool-ask-test',
      answers: [],
      skipped: true,
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
