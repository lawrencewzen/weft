import { describe, expect, it } from 'vitest';
import {
  conversationTopic,
  createEntityStore,
  type ConversationView,
  type EntityRef,
  type SnapshotEvent,
  type ThreadItem,
  type ToolCall,
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
