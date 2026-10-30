import { describe, expect, it } from 'vitest';
import { filterSearchConversations } from './sidebarSearchModel';
import type { WorkspaceGroup } from './sidebarModel';
import type { ConversationSummary, Workspace } from './store';

function ws(id: string, name = id): Workspace {
  return {
    id,
    name,
    path: `/path/${id}`,
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

const mockGroups: WorkspaceGroup[] = [
  {
    workspace: ws('ws-weft', 'weft'),
    conversations: [
      conv('c1', 'ws-weft', { title: '重构会话列表', updatedAt: 3000, status: 'running' }),
      conv('c2', 'ws-weft', { title: 'heartbeat 单测', updatedAt: 2000, status: 'waiting' }),
      conv('c3', 'ws-weft', { title: '归档的会话', updatedAt: 1000, archived: true }),
    ],
  },
  {
    workspace: ws('ws-web', 'website'),
    conversations: [
      conv('c4', 'ws-web', { title: '首页文案改版', updatedAt: 4000, status: 'idle' }),
      conv('c5', 'ws-web', { title: '架构文档', updatedAt: 2500, status: 'idle' }),
    ],
  },
];

describe('filterSearchConversations', () => {
  it('returns all non-archived conversations sorted by updatedAt desc when query is empty', () => {
    const results = filterSearchConversations(mockGroups, '');
    expect(results.map((r) => r.conv.id)).toEqual(['c4', 'c1', 'c5', 'c2']);
    expect(results.find((r) => r.conv.id === 'c3')).toBeUndefined();
  });

  it('filters case-insensitively by title', () => {
    const results = filterSearchConversations(mockGroups, '单测');
    expect(results.length).toBe(1);
    expect(results[0].conv.id).toBe('c2');
    expect(results[0].workspace.name).toBe('weft');
  });

  it('returns empty array when no titles match', () => {
    const results = filterSearchConversations(mockGroups, '不存在的任务');
    expect(results).toEqual([]);
  });

  it('associates each conversation with its correct workspace', () => {
    const results = filterSearchConversations(mockGroups, '首页');
    expect(results[0].workspace.id).toBe('ws-web');
    expect(results[0].workspace.name).toBe('website');
  });

  it('includes extra chat conversations in the results', () => {
    const chatWs = ws('ws-chat', '代码咨询');
    chatWs.kind = 'chat';
    const extra = [{
      conv: conv('c-consult', 'ws-chat', { title: '代码咨询', updatedAt: 5000 }),
      workspace: chatWs,
    }];
    const results = filterSearchConversations(mockGroups, '咨询', extra);
    expect(results.map((r) => r.conv.id)).toEqual(['c-consult']);
    expect(results[0].workspace.kind).toBe('chat');
  });
});
