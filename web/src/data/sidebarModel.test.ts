import { describe, expect, it } from 'vitest';
import {
  conversationMeta,
  conversationStatusKind,
  deleteOpenRecord,
  groupWorkspaces,
  hasLiveSubagents,
  latestConversation,
  pickDraftWorkspace,
  recordedFlag,
  runningCount,
  setOpenRecord,
  subagentTreeIsOpen,
  toggleOpenRecord,
  workspaceIsOpen,
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
    git: null,
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
    expect(conversationMeta(conv('c', 'w', { status: 'running', runningAgents: 3 }), 'zh').text).toBe('运行中');
    expect(conversationMeta(conv('c', 'w', { status: 'waiting' }), 'zh')).toMatchObject({
      text: '等待确认',
      cls: 'is-waiting',
    });
    expect(conversationMeta(conv('c', 'w', { status: 'failed' }), 'zh').cls).toBe('is-failed');
    expect(runningCount([
      conv('a', 'w', { status: 'running' }),
      conv('b', 'w', { status: 'idle' }),
    ])).toBe(1);
  });

  it('defaults the current workspace open and others closed until recorded', () => {
    expect(workspaceIsOpen('w1', true, {})).toBe(true);
    expect(workspaceIsOpen('w2', false, {})).toBe(false);
    expect(workspaceIsOpen('w1', true, { w1: false })).toBe(false);
    expect(workspaceIsOpen('w2', false, { w2: true })).toBe(true);
    const collapsed = toggleOpenRecord({}, 'w1', true);
    expect(collapsed).toEqual({ w1: false });
    expect(workspaceIsOpen('w1', true, collapsed)).toBe(false);
    const expanded = toggleOpenRecord(collapsed, 'w1', false);
    expect(expanded).toEqual({ w1: true });
    expect(setOpenRecord({}, 'w1', true)).toEqual({ w1: true });
    expect(deleteOpenRecord({ w1: false, w2: true }, 'w1')).toEqual({ w2: true });
    expect(recordedFlag({}, 'w1')).toBeUndefined();
  });

  it('defaults sub-agent trees open while live and closed when all have ended', () => {
    expect(hasLiveSubagents({ live: 1, total: 2 })).toBe(true);
    expect(hasLiveSubagents({ live: 0, total: 2 })).toBe(false);
    expect(hasLiveSubagents(null, [{ status: 'running' }])).toBe(true);
    expect(hasLiveSubagents({ live: 0 }, [{ status: 'waiting' }])).toBe(true);
    expect(hasLiveSubagents({ live: 1 }, [{ status: 'done' }, { status: 'failed' }])).toBe(false);
    expect(subagentTreeIsOpen('c1', {}, true)).toBe(true);
    expect(subagentTreeIsOpen('c1', {}, false)).toBe(false);
    expect(subagentTreeIsOpen('c1', { c1: false }, true)).toBe(false);
    expect(subagentTreeIsOpen('c1', { c1: true }, false)).toBe(true);
    expect(toggleOpenRecord({}, 'c1', true)).toEqual({ c1: false });
  });
});
