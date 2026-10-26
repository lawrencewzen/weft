import { describe, expect, it } from 'vitest';
import { createEntityStore, WORKSPACES_TOPIC, type EntityRef } from './store';
import { groupWorkspaces } from './sidebarModel';

describe('useWorkspaces selectors', () => {
  it('reads grouped workspaces from the shared entity store', () => {
    const store = createEntityStore();
    store.applySnapshot({
      protocolVersion: '2.0.0',
      topics: [WORKSPACES_TOPIC],
      entities: [
        {
          topic: WORKSPACES_TOPIC,
          entity: 'workspace',
          id: 'w1',
          value: {
            id: 'w1', name: 'alpha', path: '/a', source: 'local', gitUrl: null, branch: null, git: null, conversationCount: 2, runningCount: 0,
          } as EntityRef['value'],
        },
        {
          topic: WORKSPACES_TOPIC,
          entity: 'workspace',
          id: 'w2',
          value: {
            id: 'w2', name: 'beta', path: '/b', source: 'local', gitUrl: null, branch: null, git: null, conversationCount: 1, runningCount: 1,
          } as EntityRef['value'],
        },
        {
          topic: WORKSPACES_TOPIC,
          entity: 'conversation_summary',
          id: 'c1',
          value: {
            id: 'c1', workspaceId: 'w1', title: 'old', updatedAt: 1, status: 'idle',
            runningAgents: 0, subagents: null, archived: false,
          } as EntityRef['value'],
        },
        {
          topic: WORKSPACES_TOPIC,
          entity: 'conversation_summary',
          id: 'c2',
          value: {
            id: 'c2', workspaceId: 'w1', title: 'new', updatedAt: 9, status: 'idle',
            runningAgents: 0, subagents: null, archived: false,
          } as EntityRef['value'],
        },
        {
          topic: WORKSPACES_TOPIC,
          entity: 'conversation_summary',
          id: 'c3',
          value: {
            id: 'c3', workspaceId: 'w2', title: 'run', updatedAt: 4, status: 'running',
            runningAgents: 1, subagents: { live: 0, total: 0 }, archived: false,
          } as EntityRef['value'],
        },
      ],
    });

    const groups = groupWorkspaces(store.workspaces(), store.conversationSummaries());
    expect(store.hasTopic(WORKSPACES_TOPIC)).toBe(true);
    expect(groups.map((group) => group.workspace.name)).toEqual(['alpha', 'beta']);
    expect(groups[0].conversations.map((item) => item.id)).toEqual(['c2', 'c1']);
    expect(groups[1].conversations[0]).toMatchObject({ id: 'c3', status: 'running' });
  });
});
