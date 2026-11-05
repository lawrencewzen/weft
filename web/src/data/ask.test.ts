import { describe, expect, it } from 'vitest';
import { findPendingAsk, type ThreadItem, type ToolCall } from './ask';

describe('findPendingAsk', () => {
  it('returns the last pending ask tool and ignores answered or failed asks', () => {
    const askAnswered: ToolCall = {
      id: 'ask-1',
      groupId: 'g-1',
      kind: 'ask',
      status: 'done',
      failure: 'none',
      output: { preview: '', truncated: false, totalLines: 0 },
      heading: { title: 'Q1', detail: '', fromIntent: false },
      hint: { text: '', failed: false },
      diff: null,
      ask: {
        questions: [{ question: 'q1', header: 'h1', multiSelect: false, options: [] }],
        answer: { answers: [{ questionIndex: 0, selected: ['opt1'] }], skipped: false },
      },
    };

    const askPending: ToolCall = {
      id: 'ask-2',
      groupId: 'g-2',
      kind: 'ask',
      status: 'done',
      failure: 'none',
      output: { preview: '', truncated: false, totalLines: 0 },
      heading: { title: 'Q2', detail: '', fromIntent: false },
      hint: { text: '', failed: false },
      diff: null,
      ask: {
        questions: [{ question: 'q2', header: 'h2', multiSelect: false, options: [] }],
        answer: null,
      },
    };

    const tools: Record<string, ToolCall> = {
      'ask-1': askAnswered,
      'ask-2': askPending,
    };

    const items: ThreadItem[] = [
      {
        id: 'g-1',
        kind: 'tool_group',
        toolIds: ['ask-1'],
        live: false,
        summary: { text: 'ask 1', running: false, failed: 0 },
      },
      {
        id: 'g-2',
        kind: 'tool_group',
        toolIds: ['ask-2'],
        live: false,
        summary: { text: 'ask 2', running: false, failed: 0 },
      },
    ];

    expect(findPendingAsk(items, tools)).toBe(askPending);

    // If answered, findPendingAsk returns null
    askPending.ask!.answer = { answers: [], skipped: true };
    expect(findPendingAsk(items, tools)).toBeNull();

    // If failed, findPendingAsk returns null
    askPending.ask!.answer = null;
    askPending.failure = 'real';
    expect(findPendingAsk(items, tools)).toBeNull();
  });
});
