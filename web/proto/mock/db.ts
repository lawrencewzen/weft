import type { EntityValue, MockConv, MockDb, MockItem, MockTool } from './types';
import { createSeed } from './seed';
import type { MockHub } from './hub';
import {
  conversationEntities,
  conversationValue,
  extensionsEntities,
  itemValue,
  providersEntities,
  summaryOf,
  toolValue,
  workspacesEntities,
} from './views';
import type { Change } from './types';

export function createDb(): MockDb {
  return createSeed(Date.now());
}

export function conversationTopic(cid: string): string {
  return `conversation:${cid}`;
}

export function getConv(db: MockDb, cid: string): MockConv | undefined {
  return db.conversations.get(cid);
}

export function touch(conv: MockConv): void {
  conv.view.updatedAt = Date.now();
}

export function refreshCounts(db: MockDb): void {
  for (const ws of db.workspaces) {
    const rows = [...db.conversations.values()].filter((conv) => conv.view.workspaceId === ws.id);
    ws.conversationCount = rows.length;
    ws.runningCount = rows.filter((conv) => conv.view.status === 'running').length;
  }
}

export function selectedModel(db: MockDb, conv: MockConv): { window: number } {
  const provider = db.providers.find((row) => row.id === conv.view.model?.sourceId);
  const model = provider?.models.find((row) => row.id === conv.view.model?.modelId);
  return { window: model?.contextWindow || conv.view.context.window || 200_000 };
}

export function recomputeContext(db: MockDb, conv: MockConv, used = conv.view.context.used): void {
  const { window } = selectedModel(db, conv);
  const percent = Math.min(100, Math.round((used / window) * 100));
  const level = percent >= 95 ? 'full' : percent >= 80 ? 'warn' : 'ok';
  conv.view.context = { used, window, percent, level };
}

export function publishConversation(db: MockDb, hub: MockHub, cid: string): void {
  const conv = getConv(db, cid);
  if (!conv) return;
  const topic = conversationTopic(cid);
  for (const entity of conversationEntities(conv)) {
    hub.publish(topic, { event: 'upsert', entity: entity.entity, id: entity.id, value: entity.value });
  }
}

export function publishConversationView(conv: MockConv, hub: MockHub): void {
  hub.publish(conversationTopic(conv.view.id), {
    event: 'upsert',
    entity: 'conversation',
    id: conv.view.id,
    value: conversationValue(conv),
  });
}

export function publishItem(conv: MockConv, hub: MockHub, item: MockItem): void {
  hub.publish(conversationTopic(conv.view.id), {
    event: 'upsert',
    entity: 'item',
    id: item.id,
    value: itemValue(item),
  });
}

export function publishTool(conv: MockConv, hub: MockHub, tool: MockTool, groupId: string): void {
  hub.publish(conversationTopic(conv.view.id), {
    event: 'upsert',
    entity: 'tool',
    id: tool.id,
    value: toolValue(tool, groupId),
  });
}

export function publishRemove(conv: MockConv, hub: MockHub, entity: string, id: string): void {
  hub.publish(conversationTopic(conv.view.id), { event: 'remove', entity, id });
}

export function publishTextDelta(conv: MockConv, hub: MockHub, itemId: string, offset: number, append: string): void {
  hub.publish(conversationTopic(conv.view.id), { event: 'text.delta', itemId, offset, append });
}

export function publishWorkspaces(db: MockDb, hub: MockHub): void {
  refreshCounts(db);
  for (const entity of workspacesEntities(db)) {
    hub.publish('workspaces', { event: 'upsert', entity: entity.entity, id: entity.id, value: entity.value });
  }
}

export function publishProviders(db: MockDb, hub: MockHub): void {
  for (const entity of providersEntities(db)) {
    hub.publish('providers', { event: 'upsert', entity: entity.entity, id: entity.id, value: entity.value });
  }
}

export function publishExtensions(db: MockDb, hub: MockHub): void {
  for (const entity of extensionsEntities(db)) {
    hub.publish('extensions', { event: 'upsert', entity: entity.entity, id: entity.id, value: entity.value });
  }
}

export function publishChange(conv: MockConv, hub: MockHub, change: Change): void {
  hub.publish(conversationTopic(conv.view.id), {
    event: 'upsert',
    entity: 'change',
    id: change.path,
    value: change as unknown as object,
  });
}

export function publishSummary(db: MockDb, hub: MockHub, cid: string): void {
  const conv = getConv(db, cid);
  if (!conv) return;
  const summary: EntityValue = summaryOf(conv) as unknown as object;
  hub.publish('workspaces', {
    event: 'upsert',
    entity: 'conversation_summary',
    id: conv.view.id,
    value: summary,
  });
  const ws = db.workspaces.find((row) => row.id === conv.view.workspaceId);
  if (ws) {
    hub.publish('workspaces', {
      event: 'upsert',
      entity: 'workspace',
      id: ws.id,
      value: {
        ...ws,
        conversationCount: [...db.conversations.values()]
          .filter((row) => row.view.workspaceId === ws.id).length,
        runningCount: [...db.conversations.values()]
          .filter((row) => row.view.workspaceId === ws.id && row.view.status === 'running').length,
      },
    });
  }
}

export function nextId(db: MockDb, prefix: string): string {
  db.seq += 1;
  return `${prefix}-${db.seq}`;
}
