import { describe, expect, it } from 'vitest';
import {
  conversationMeta,
  conversationStatusKind,
  groupWorkspaces,
  latestConversation,
  pickDraftWorkspace,
  runningCount,
} from './sidebarModel';
import type { ConversationSummary, Workspace } from './store';

function ws(id: string, name = id): Workspace {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    source: 'local',
    gitUrl: null,
    branch: null,
    conversationCount: 0,
    runningCount: 0,
  };
}

function conv(id: string, workspaceId: string, extra?: Partial<ConversationSummary>): ConversationSummary {
  return {
    id,
    workspaceId,
    title: id,
    updatedAt: 1,
    status: 'idle',
    runningAgents: 0,
    subagents: null,
    archived: false,
    ...extra,
  };
}

describe('sidebarModel', () => {
  it('groups conversations under workspaces in server order and sorts by updatedAt desc', () => {
    const groups = groupWorkspaces(
      [ws('w1', 'alpha'), ws('w2', 'beta')],
      [
        conv('old', 'w1', { updatedAt: 10 }),
        conv('new', 'w1', { updatedAt: 30 }),
        conv('mid', 'w1', { updatedAt: 20 }),
        conv('b', 'w2', { updatedAt: 5 }),
        conv('archived', 'w1', { updatedAt: 99, archived: true }),
      ],
    );
    expect(groups.map((group) => group.workspace.name)).toEqual(['alpha', 'beta']);
    expect(groups[0].conversations.map((item) => item.id)).toEqual(['new', 'mid', 'old']);
    expect(groups[1].conversations.map((item) => item.id)).toEqual(['b']);
  });

  it('picks the latest non-archived conversation', () => {
    expect(latestConversation([
      conv('a', 'w1', { updatedAt: 10 }),
      conv('b', 'w2', { updatedAt: 40, archived: true }),
      conv('c', 'w1', { updatedAt: 30 }),
    ])?.id).toBe('c');
  });

  it('uses saved workspace for drafts when it still exists', () => {
    const list = [ws('w1'), ws('w2')];
    expect(pickDraftWorkspace(list, 'w2')?.id).toBe('w2');
    expect(pickDraftWorkspace(list, 'gone')?.id).toBe('w1');
    expect(pickDraftWorkspace([], 'w1')).toBeUndefined();
  });

  it('builds conversation meta like the old quiet list', () => {
    expect(conversationStatusKind('idle')).toBe('');
    expect(conversationStatusKind('running')).toBe('running');
    expect(conversationMeta(conv('c', 'w', { status: 'running', runningAgents: 1 }), 'zh').text).toBe('运行中');
    expect(conversationMeta(conv('c', 'w', { status: 'running', runningAgents: 3 }), 'zh').text).toBe('3 个 Agent 运行中');
    expect(conversationMeta(conv('c', 'w', { status: 'waiting' }), 'zh')).toMatchObject({
      text: '等待中',
      cls: 'is-waiting',
    });
    expect(conversationMeta(conv('c', 'w', { status: 'failed' }), 'zh').cls).toBe('is-failed');
    expect(runningCount([
      conv('a', 'w', { status: 'running' }),
      conv('b', 'w', { status: 'idle' }),
    ])).toBe(1);
  });
});
