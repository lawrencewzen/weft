import { describe, expect, it } from 'vitest';
import { matchDispatchSubagents } from './dispatchCard';
import type { Subagent } from './store';

function fakeSubagent(id: string, toolCallId: string | null, extra: Partial<Subagent> = {}): Subagent {
  return {
    id,
    parentConversationId: 'c1',
    title: `Task ${id}`,
    name: `agent-${id}`,
    mode: 'background',
    status: 'running',
    startedAt: 1000,
    lastActivityAt: 1000,
    endedAt: null,
    currentAction: null,
    progress: null,
    toolCallId,
    ...extra,
  };
}

describe('matchDispatchSubagents', () => {
  it('handles 全是派发 (all dispatch tools in group match subagents)', () => {
    const group = { toolIds: ['call-1', 'call-2'] };
    const subagents: Subagent[] = [
      fakeSubagent('sa-2', 'call-2'),
      fakeSubagent('sa-1', 'call-1'),
    ];

    const result = matchDispatchSubagents(group, subagents);
    expect(result).not.toBeNull();
    expect(result?.allDispatch).toBe(true);
    // Should be sorted by toolIds order: call-1 first, then call-2
    expect(result?.subagents.map((s) => s.id)).toEqual(['sa-1', 'sa-2']);
  });

  it('handles 混合 (mixed: some dispatch tools, some non-dispatch tools)', () => {
    const group = { toolIds: ['read-file-1', 'call-sa-1', 'bash-test'] };
    const subagents: Subagent[] = [
      fakeSubagent('sa-1', 'call-sa-1'),
    ];

    const result = matchDispatchSubagents(group, subagents);
    expect(result).not.toBeNull();
    expect(result?.allDispatch).toBe(false);
    expect(result?.subagents.map((s) => s.id)).toEqual(['sa-1']);
  });

  it('handles 没有匹配 (no matching subagents)', () => {
    const group = { toolIds: ['read-file-1', 'bash-test'] };
    const subagents: Subagent[] = [
      fakeSubagent('sa-1', 'other-call-id'),
    ];

    const result = matchDispatchSubagents(group, subagents);
    expect(result).toBeNull();
  });

  it('handles toolCallId 为 null (null toolCallId is ignored)', () => {
    const group = { toolIds: ['call-1'] };
    const subagents: Subagent[] = [
      fakeSubagent('roster-agent', null),
    ];

    const result = matchDispatchSubagents(group, subagents);
    expect(result).toBeNull();

    // If another subagent matches, null toolCallId is still ignored
    const mixedSubagents: Subagent[] = [
      fakeSubagent('roster-agent', null),
      fakeSubagent('sa-1', 'call-1'),
    ];
    const mixedResult = matchDispatchSubagents(group, mixedSubagents);
    expect(mixedResult).not.toBeNull();
    expect(mixedResult?.allDispatch).toBe(true);
    expect(mixedResult?.subagents.map((s) => s.id)).toEqual(['sa-1']);
  });

  it('handles multiple subagents sharing the same toolCallId (batch dispatch)', () => {
    const group = { toolIds: ['batch-spawn'] };
    const subagents: Subagent[] = [
      fakeSubagent('sa-1', 'batch-spawn', { title: 'First' }),
      fakeSubagent('sa-2', 'batch-spawn', { title: 'Second' }),
      fakeSubagent('sa-3', 'batch-spawn', { title: 'Third' }),
    ];

    const result = matchDispatchSubagents(group, subagents);
    expect(result).not.toBeNull();
    expect(result?.allDispatch).toBe(true);
    expect(result?.subagents.map((s) => s.id)).toEqual(['sa-1', 'sa-2', 'sa-3']);
  });

  it('accepts raw array of toolIds as argument', () => {
    const toolIds = ['call-1'];
    const subagents: Subagent[] = [fakeSubagent('sa-1', 'call-1')];
    const result = matchDispatchSubagents(toolIds, subagents);
    expect(result?.allDispatch).toBe(true);
    expect(result?.subagents[0].id).toBe('sa-1');
  });

  it('returns null on empty or invalid inputs', () => {
    expect(matchDispatchSubagents(null, [])).toBeNull();
    expect(matchDispatchSubagents({ toolIds: [] }, [fakeSubagent('sa-1', 'call-1')])).toBeNull();
    expect(matchDispatchSubagents({ toolIds: ['call-1'] }, [])).toBeNull();
  });
});
