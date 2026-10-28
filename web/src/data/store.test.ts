import { describe, expect, it } from 'vitest';
import {
  conversationTopic,
  createEntityStore,
  EXTENSIONS_TOPIC,
  PROVIDERS_TOPIC,
  sessionTopics,
  subagentTopic,
  WORKSPACES_TOPIC,
  type ConversationSummary,
  type ConversationView,
  type EntityRef,
  type SnapshotEvent,
  type Subagent,
  type ThreadItem,
  type ToolCall,
  type Workspace,
} from './store';

const CID = 'c1';
const TOPIC = conversationTopic(CID);

function runState(): ConversationView['run'] {
  return {
    status: 'idle',
    startedAt: null,
    pendingText: null,
    canSend: true,
    canStop: false,
    lockedReason: null,
    error: null,
  };
}

function conv(id: string, itemIds: string[], extra?: Partial<ConversationView>): ConversationView {
  return {
    id,
    workspaceId: 'ws',
    title: `title-${id}`,
    updatedAt: 1,
    status: 'idle',
    model: null,
    run: runState(),
    context: { used: 0, window: 128000, percent: 0, level: 'ok' },
    itemIds,
    ...extra,
  };
}

function user(id: string, text: string): ThreadItem {
  return { kind: 'user', id, text, pathRefs: [] };
}

function assistant(id: string, text: string, streaming = false): ThreadItem {
  return { kind: 'assistant', id, text, pathRefs: [], streaming, truncated: false };
}

function tool(id: string): ToolCall {
  return {
    id,
    groupId: 'g1',
    kind: 'read',
    status: 'done',
    heading: { title: id, detail: '', fromIntent: false },
    hint: { text: '', failed: false },
    failure: 'none',
    diff: null,
    output: { preview: '', truncated: false, totalLines: 0 },
  };
}

function ref(entity: string, id: string, value: object, topic = TOPIC): EntityRef {
  return { topic, entity, id, value: value as EntityRef['value'] };
}

function snapshot(entities: EntityRef[], extra?: Partial<SnapshotEvent>): SnapshotEvent {
  const topics = extra?.topics ?? [...new Set(entities.map((item) => item.topic))];
  return {
    protocolVersion: '2.0.0',
    topics: topics.length ? topics : [TOPIC],
    entities,
    ...extra,
  };
}

describe('entity store', () => {
  it('replaces a topic wholesale on snapshot', () => {
    const store = createEntityStore();
    store.applySnapshot(snapshot([
      ref('conversation', CID, conv(CID, ['u1', 'a1'])),
      ref('item', 'u1', user('u1', 'hi')),
      ref('item', 'a1', assistant('a1', 'hello')),
      ref('tool', 't1', tool('t1')),
    ]));
    expect(store.items(CID).map((item) => item.id)).toEqual(['u1', 'a1']);
    expect(store.tool('t1')?.id).toBe('t1');

    store.applySnapshot(snapshot([
      ref('conversation', CID, conv(CID, ['u2'])),
      ref('item', 'u2', user('u2', 'next')),
    ]));
    expect(store.conversation(CID)?.itemIds).toEqual(['u2']);
    expect(store.items(CID).map((item) => item.id)).toEqual(['u2']);
    expect(store.tool('t1')).toBeUndefined();
  });

  it('does not wipe another topic when replacing a snapshot', () => {
    const store = createEntityStore();
    const other = conversationTopic('c2');
    store.applySnapshot(snapshot([
      ref('conversation', CID, conv(CID, ['a']), TOPIC),
      ref('item', 'a', user('a', 'one'), TOPIC),
      ref('conversation', 'c2', conv('c2', ['b']), other),
      ref('item', 'b', user('b', 'two'), other),
    ], { topics: [TOPIC, other] }));

    store.applySnapshot(snapshot([
      ref('conversation', CID, conv(CID, ['c'])),
      ref('item', 'c', user('c', 'three')),
    ], { topics: [TOPIC] }));

    expect(store.items(CID).map((item) => item.id)).toEqual(['c']);
    expect(store.items('c2').map((item) => item.id)).toEqual(['b']);
  });

  it('upserts and removes entities', () => {
    const store = createEntityStore();
    store.applySnapshot(snapshot([
      ref('conversation', CID, conv(CID, ['u1'])),
      ref('item', 'u1', user('u1', 'hi')),
    ]));
    store.applyUpsert({
      topic: TOPIC,
      entity: 'item',
      id: 'a1',
      value: assistant('a1', 'ok') as EntityRef['value'],
    });
    store.applyUpsert({
      topic: TOPIC,
      entity: 'conversation',
      id: CID,
      value: conv(CID, ['u1', 'a1']) as EntityRef['value'],
    });
    expect(store.items(CID).map((item) => item.id)).toEqual(['u1', 'a1']);

    store.applyRemove({ topic: TOPIC, entity: 'item', id: 'u1' });
    store.applyUpsert({
      topic: TOPIC,
      entity: 'conversation',
      id: CID,
      value: conv(CID, ['a1']) as EntityRef['value'],
    });
    expect(store.items(CID).map((item) => item.id)).toEqual(['a1']);
  });

  it('appends text.delta when offset matches current length', () => {
    const store = createEntityStore();
    store.applyUpsert({
      topic: TOPIC,
      entity: 'item',
      id: 'live:1',
      value: assistant('live:1', '', true) as EntityRef['value'],
    });
    store.applyUpsert({
      topic: TOPIC,
      entity: 'conversation',
      id: CID,
      value: conv(CID, ['live:1']) as EntityRef['value'],
    });
    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 0, append: 'Hel' });
    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 3, append: 'lo' });
    const item = store.items(CID)[0];
    expect(item).toMatchObject({ id: 'live:1', text: 'Hello', streaming: true });
    expect(store.needsFullValue('live:1')).toBe(false);
  });

  it('marks an item as needing a full value when offset is discontinuous', () => {
    const store = createEntityStore();
    store.applyUpsert({
      topic: TOPIC,
      entity: 'item',
      id: 'live:1',
      value: assistant('live:1', 'Hel', true) as EntityRef['value'],
    });
    store.applyUpsert({
      topic: TOPIC,
      entity: 'conversation',
      id: CID,
      value: conv(CID, ['live:1']) as EntityRef['value'],
    });
    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 1, append: 'lo' });
    expect(store.needsFullValue('live:1')).toBe(true);
    expect((store.items(CID)[0] as { text: string }).text).toBe('Hel');

    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 3, append: 'lo' });
    expect((store.items(CID)[0] as { text: string }).text).toBe('Hel');
    expect(store.needsFullValue('live:1')).toBe(true);

    store.applyUpsert({
      topic: TOPIC,
      entity: 'item',
      id: 'live:1',
      value: assistant('live:1', 'Hello world', true) as EntityRef['value'],
    });
    expect(store.needsFullValue('live:1')).toBe(false);
    expect((store.items(CID)[0] as { text: string }).text).toBe('Hello world');
    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 11, append: '!' });
    expect((store.items(CID)[0] as { text: string }).text).toBe('Hello world!');
  });

  it('ignores a text.delta that is already present in the current text', () => {
    const store = createEntityStore();
    store.applyUpsert({
      topic: TOPIC,
      entity: 'item',
      id: 'live:1',
      value: assistant('live:1', 'Hello', true) as EntityRef['value'],
    });
    store.applyUpsert({
      topic: TOPIC,
      entity: 'conversation',
      id: CID,
      value: conv(CID, ['live:1']) as EntityRef['value'],
    });
    const version = store.getVersion();
    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 0, append: 'Hel' });
    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 3, append: 'lo' });
    expect((store.items(CID)[0] as { text: string }).text).toBe('Hello');
    expect(store.needsFullValue('live:1')).toBe(false);
    expect(store.getVersion()).toBe(version);

    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 5, append: '!' });
    expect((store.items(CID)[0] as { text: string }).text).toBe('Hello!');
    expect(store.needsFullValue('live:1')).toBe(false);
  });

  it('replays deltas after a snapshot that already contains a prefix of the stream', () => {
    const store = createEntityStore();
    store.applySnapshot(snapshot([
      ref('conversation', CID, conv(CID, ['live:1'])),
      ref('item', 'live:1', assistant('live:1', 'Hel', true)),
    ]));
    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 0, append: 'Hel' });
    expect((store.items(CID)[0] as { text: string }).text).toBe('Hel');
    expect(store.needsFullValue('live:1')).toBe(false);
    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 3, append: 'lo' });
    expect((store.items(CID)[0] as { text: string }).text).toBe('Hello');
    expect(store.needsFullValue('live:1')).toBe(false);
  });

  it('marks stale when a replayed delta overlaps but does not match', () => {
    const store = createEntityStore();
    store.applyUpsert({
      topic: TOPIC,
      entity: 'item',
      id: 'live:1',
      value: assistant('live:1', 'Hello', true) as EntityRef['value'],
    });
    store.applyUpsert({
      topic: TOPIC,
      entity: 'conversation',
      id: CID,
      value: conv(CID, ['live:1']) as EntityRef['value'],
    });
    store.applyTextDelta({ topic: TOPIC, itemId: 'live:1', offset: 0, append: 'XYZ' });
    expect(store.needsFullValue('live:1')).toBe(true);
    expect((store.items(CID)[0] as { text: string }).text).toBe('Hello');
  });

  it('replaces a live streaming item with the official message', () => {
    const store = createEntityStore();
    const liveId = 'live:m1';
    store.applySnapshot(snapshot([
      ref('conversation', CID, conv(CID, ['u1', liveId])),
      ref('item', 'u1', user('u1', 'hi')),
      ref('item', liveId, assistant(liveId, '', true)),
    ]));
    store.applyTextDelta({ topic: TOPIC, itemId: liveId, offset: 0, append: 'streamed' });
    expect(store.items(CID).map((item) => item.id)).toEqual(['u1', liveId]);

    store.applyRemove({ topic: TOPIC, entity: 'item', id: liveId });
    store.applyUpsert({
      topic: TOPIC,
      entity: 'item',
      id: 'm1',
      value: assistant('m1', 'streamed') as EntityRef['value'],
    });
    store.applyUpsert({
      topic: TOPIC,
      entity: 'conversation',
      id: CID,
      value: conv(CID, ['u1', 'm1']) as EntityRef['value'],
    });

    expect(store.items(CID).map((item) => ({ id: item.id, kind: item.kind, text: 'text' in item ? item.text : '' }))).toEqual([
      { id: 'u1', kind: 'user', text: 'hi' },
      { id: 'm1', kind: 'assistant', text: 'streamed' },
    ]);
  });

  it('orders items by conversation.itemIds', () => {
    const store = createEntityStore();
    store.applyUpsert({
      topic: TOPIC,
      entity: 'item',
      id: 'b',
      value: user('b', 'second') as EntityRef['value'],
    });
    store.applyUpsert({
      topic: TOPIC,
      entity: 'item',
      id: 'a',
      value: user('a', 'first') as EntityRef['value'],
    });
    store.applyUpsert({
      topic: TOPIC,
      entity: 'conversation',
      id: CID,
      value: conv(CID, ['a', 'b']) as EntityRef['value'],
    });
    expect(store.items(CID).map((item) => item.id)).toEqual(['a', 'b']);
    store.applyUpsert({
      topic: TOPIC,
      entity: 'conversation',
      id: CID,
      value: conv(CID, ['b', 'a']) as EntityRef['value'],
    });
    expect(store.items(CID).map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('records missing topics from a snapshot', () => {
    const store = createEntityStore();
    const gone = conversationTopic('gone');
    store.applySnapshot(snapshot([], { topics: [gone], missing: [gone] }));
    expect(store.isMissing(gone)).toBe(true);
    expect(store.conversation('gone')).toBeUndefined();
    expect(store.items('gone')).toEqual([]);

    store.applySnapshot(snapshot([
      ref('conversation', 'gone', conv('gone', []), gone),
    ], { topics: [gone] }));
    expect(store.isMissing(gone)).toBe(false);
    expect(store.conversation('gone')?.id).toBe('gone');
  });
});

function workspace(id: string, extra?: Partial<Workspace>): Workspace {
  return {
    id,
    name: `ws-${id}`,
    path: `/tmp/${id}`,
    source: 'local',
    gitUrl: null,
    branch: null,
    git: null,
    conversationCount: 0,
    runningCount: 0,
    ...extra,
  };
}

function summary(id: string, workspaceId: string, extra?: Partial<ConversationSummary>): ConversationSummary {
  return {
    id,
    workspaceId,
    title: `title-${id}`,
    updatedAt: 1,
    status: 'idle',
    runningAgents: 0,
    subagents: null,
    archived: false,
    ...extra,
  };
}

function wsRef(id: string, extra?: Partial<Workspace>): EntityRef {
  return { topic: WORKSPACES_TOPIC, entity: 'workspace', id, value: workspace(id, extra) as EntityRef['value'] };
}

function sumRef(id: string, workspaceId: string, extra?: Partial<ConversationSummary>): EntityRef {
  return {
    topic: WORKSPACES_TOPIC,
    entity: 'conversation_summary',
    id,
    value: summary(id, workspaceId, extra) as EntityRef['value'],
  };
}

describe('workspace selectors', () => {
  it('builds session topics with workspaces first', () => {
    expect(sessionTopics(null)).toEqual([WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC]);
    expect(sessionTopics('c1')).toEqual([
      WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC, conversationTopic('c1'),
    ]);
  });

  it('adds extra conversation topics when expanding another chat and drops them when collapsing', () => {
    expect(sessionTopics({ conversationId: 'a' })).toEqual([
      WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC, conversationTopic('a'),
    ]);
    expect(sessionTopics({
      conversationId: 'a',
      extraConversationIds: ['b'],
    })).toEqual([
      WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC, conversationTopic('a'), conversationTopic('b'),
    ]);
    expect(sessionTopics({
      conversationId: 'a',
      extraConversationIds: ['b', 'a', 'c'],
    })).toEqual([
      WORKSPACES_TOPIC,
      PROVIDERS_TOPIC,
      EXTENSIONS_TOPIC,
      conversationTopic('a'),
      conversationTopic('b'),
      conversationTopic('c'),
    ]);
    expect(sessionTopics({
      conversationId: 'a',
      extraConversationIds: [],
    })).toEqual([WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC, conversationTopic('a')]);
    expect(sessionTopics({
      conversationId: 'a',
      extraConversationIds: ['b'],
      subagent: { conversationId: 'a', agentId: 'a:sub:1' },
    })).toEqual([
      WORKSPACES_TOPIC,
      PROVIDERS_TOPIC,
      EXTENSIONS_TOPIC,
      conversationTopic('a'),
      conversationTopic('b'),
      subagentTopic('a', 'a:sub:1'),
    ]);
  });

  it('puts extra topics after providers and before conversation topics', () => {
    expect(sessionTopics({ extraTopics: [EXTENSIONS_TOPIC] })).toEqual([
      WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC,
    ]);
    expect(sessionTopics({ extraTopics: ['other'] })).toEqual([
      WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC, 'other',
    ]);
    expect(sessionTopics({
      conversationId: 'a',
      extraTopics: [EXTENSIONS_TOPIC, WORKSPACES_TOPIC],
      extraConversationIds: ['b'],
    })).toEqual([
      WORKSPACES_TOPIC, PROVIDERS_TOPIC, EXTENSIONS_TOPIC, conversationTopic('a'), conversationTopic('b'),
    ]);
  });

  it('lists subagents on a conversation topic and drops unsubscribed topics', () => {
    const store = createEntityStore();
    const other = conversationTopic('c2');
    const agent: Subagent = {
      id: 'c1:sub:t',
      parentConversationId: 'c1',
      title: 'tester',
      name: '测试',
      mode: 'foreground',
      status: 'running',
      startedAt: 1,
      lastActivityAt: 1,
      endedAt: null,
      currentAction: 'reading',
      progress: { step: 1, total: 2 },
    };
    store.applySnapshot(snapshot([
      ref('conversation', CID, conv(CID, ['u1'])),
      ref('item', 'u1', user('u1', 'hi')),
      ref('subagent', agent.id, agent),
      ref('conversation', 'c2', conv('c2', ['u2']), other),
      ref('item', 'u2', user('u2', 'other'), other),
      ref('item', 'a2', assistant('a2', 'child out'), other),
    ], { topics: [TOPIC, other] }));
    expect(store.subagents(CID).map((item) => item.id)).toEqual([agent.id]);
    expect(store.subagent(CID, agent.id)?.title).toBe('tester');
    expect(store.lastAssistantText(other)).toBe('child out');

    store.retainTopics([TOPIC]);
    expect(store.hasTopic(other)).toBe(false);
    expect(store.items('c2')).toEqual([]);
    expect(store.subagents(CID)).toHaveLength(1);
  });

  it('keeps workspace order from the snapshot and on in-place upsert', () => {
    const store = createEntityStore();
    store.applySnapshot(snapshot([
      wsRef('w1'),
      wsRef('w2'),
      sumRef('c-old', 'w1', { updatedAt: 10, title: 'old' }),
      sumRef('c-new', 'w1', { updatedAt: 20, title: 'new' }),
      sumRef('c-b', 'w2', { updatedAt: 15, title: 'b' }),
    ], { topics: [WORKSPACES_TOPIC] }));

    expect(store.hasTopic(WORKSPACES_TOPIC)).toBe(true);
    expect(store.workspaces().map((item) => item.id)).toEqual(['w1', 'w2']);
    expect(store.conversationsFor('w1').map((item) => item.id)).toEqual(['c-new', 'c-old']);
    expect(store.conversationsFor('w2').map((item) => item.id)).toEqual(['c-b']);

    store.applyUpsert({
      topic: WORKSPACES_TOPIC,
      entity: 'workspace',
      id: 'w1',
      value: workspace('w1', { name: 'renamed' }) as EntityRef['value'],
    });
    expect(store.workspaces().map((item) => item.id)).toEqual(['w1', 'w2']);
    expect(store.workspaces()[0].name).toBe('renamed');
  });

  it('appends a new workspace at the end and removes entities', () => {
    const store = createEntityStore();
    store.applySnapshot(snapshot([wsRef('w1')], { topics: [WORKSPACES_TOPIC] }));
    store.applyUpsert({
      topic: WORKSPACES_TOPIC,
      entity: 'workspace',
      id: 'w2',
      value: workspace('w2') as EntityRef['value'],
    });
    store.applyUpsert({
      topic: WORKSPACES_TOPIC,
      entity: 'conversation_summary',
      id: 'c1',
      value: summary('c1', 'w2', { updatedAt: 5 }) as EntityRef['value'],
    });
    expect(store.workspaces().map((item) => item.id)).toEqual(['w1', 'w2']);
    expect(store.conversationsFor('w2').map((item) => item.id)).toEqual(['c1']);

    store.applyRemove({ topic: WORKSPACES_TOPIC, entity: 'conversation_summary', id: 'c1' });
    store.applyRemove({ topic: WORKSPACES_TOPIC, entity: 'workspace', id: 'w1' });
    expect(store.workspaces().map((item) => item.id)).toEqual(['w2']);
    expect(store.conversationsFor('w2')).toEqual([]);
    expect(store.conversationSummaries()).toEqual([]);
  });

  it('lists change entities for a conversation sorted by path', () => {
    const store = createEntityStore();
    store.applySnapshot(snapshot([
      ref('conversation', CID, conv(CID, [])),
      ref('change', 'z.md', { path: 'z.md', added: 1, removed: 0, error: null }),
      ref('change', 'a.md', { path: 'a.md', added: 2, removed: 1, error: null }),
    ]));
    expect(store.changes(CID).map((item) => item.path)).toEqual(['a.md', 'z.md']);
    store.applyRemove({ topic: TOPIC, entity: 'change', id: 'a.md' });
    expect(store.changes(CID).map((item) => item.path)).toEqual(['z.md']);
  });

  it('reads providers and default model from the providers topic', () => {
    const store = createEntityStore();
    store.applySnapshot({
      protocolVersion: '2.0.0',
      topics: [PROVIDERS_TOPIC],
      entities: [
        {
          topic: PROVIDERS_TOPIC,
          entity: 'provider',
          id: 'p1',
          value: {
            id: 'p1',
            vendor: 'DeepSeek',
            name: 'Work',
            access: 'api_key',
            runtime: 'model',
            baseUrl: 'https://api.deepseek.com/v1',
            keyMasked: '••••3f9c',
            hasKey: true,
            status: 'ok',
            statusText: '',
            lastTestedAt: 1,
            models: [{
              id: 'deepseek-chat',
              displayName: 'DeepSeek Chat',
              brand: 'DeepSeek',
              contextWindow: 128000,
              contextWindowCustom: false,
              images: false,
            }],
            isDefault: true,
          } as EntityRef['value'],
        },
        {
          topic: PROVIDERS_TOPIC,
          entity: 'defaults',
          id: 'self',
          value: { model: { providerId: 'p1', modelId: 'deepseek-chat' } } as EntityRef['value'],
        },
      ],
    });
    expect(store.hasTopic(PROVIDERS_TOPIC)).toBe(true);
    expect(store.providers().map((item) => item.id)).toEqual(['p1']);
    expect(store.provider('p1')?.name).toBe('Work');
    expect(store.defaultModel()).toEqual({ providerId: 'p1', modelId: 'deepseek-chat' });
    store.applyRemove({ topic: PROVIDERS_TOPIC, entity: 'provider', id: 'p1' });
    expect(store.providers()).toEqual([]);
  });

  it('reads plugins, skills, and git connections from the extensions topic', () => {
    const store = createEntityStore();
    store.applySnapshot({
      protocolVersion: '2.0.0',
      topics: [EXTENSIONS_TOPIC],
      entities: [
        {
          topic: EXTENSIONS_TOPIC,
          entity: 'plugin',
          id: 'echo',
          value: {
            id: 'echo', name: 'Echo', description: 'd', version: '0.1.0', source: 'bundled',
            enabled: true, loaded: true, error: null, errorCode: null, tools: [],
          } as EntityRef['value'],
        },
        {
          topic: EXTENSIONS_TOPIC,
          entity: 'skill',
          id: 's1',
          value: {
            id: 's1', name: '口令', description: 'd', version: '1.0.0', source: 'local',
            enabled: true, deletable: true,
          } as EntityRef['value'],
        },
        {
          topic: EXTENSIONS_TOPIC,
          entity: 'git_connection',
          id: 'g1',
          value: {
            id: 'g1', name: 'Corp', kind: 'gitlab-self', baseUrl: 'https://gitlab.example',
            token: '••••9k3q', hasToken: true, allowHttp: true, caFile: '', lastTest: null,
          } as EntityRef['value'],
        },
      ],
    });
    expect(store.hasTopic(EXTENSIONS_TOPIC)).toBe(true);
    expect(store.plugins().map((item) => item.id)).toEqual(['echo']);
    expect(store.skills().map((item) => item.name)).toEqual(['口令']);
    expect(store.gitConnections().map((item) => item.id)).toEqual(['g1']);
    store.applyRemove({ topic: EXTENSIONS_TOPIC, entity: 'git_connection', id: 'g1' });
    expect(store.gitConnections()).toEqual([]);
  });
});
