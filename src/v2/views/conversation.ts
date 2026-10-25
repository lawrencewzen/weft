/** Assemble a conversation snapshot. HTTP layer only loads data and calls this. */

import type { Lang } from '../phrases/index.ts';
import type { components } from '../contract.gen.ts';
import { contextUsageView } from './context.ts';
import { conversationStatus, runStateView } from './run.ts';
import { buildThread, type BuildThreadOptions, type ThreadMessage, type ThreadSubagent } from './thread.ts';

export type ConversationView = components['schemas']['ConversationView'];
export type ConversationSnapshot = components['schemas']['ConversationSnapshot'];
export type ConversationModel = components['schemas']['ConversationModel'];

export type PresentedConversation = {
  id?: unknown;
  workspaceId?: unknown;
  workspacePath?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  status?: unknown;
  usage?: unknown;
  llmError?: { code?: unknown; message?: unknown } | null;
  messages?: ThreadMessage[] | null;
  modelSourceId?: unknown;
  modelId?: unknown;
};

/** Result of resolveConversationTarget in src/core/model-sources.mjs. */
export type ConversationModelTarget = {
  source?: { id?: unknown };
  model?: unknown;
} | null;

export type ConversationSnapshotInput = {
  presented: PresentedConversation;
  subagents?: ThreadSubagent[] | null;
  modelTarget?: ConversationModelTarget;
  window?: unknown;
  lang?: Lang;
  exists?: BuildThreadOptions['exists'];
};

export function conversationModelView(target: ConversationModelTarget): ConversationModel | null {
  const sourceId = typeof target?.source?.id === 'string' ? target.source.id : '';
  const modelId = typeof target?.model === 'string' ? target.model : '';
  if (!sourceId || !modelId) return null;
  return { sourceId, modelId, label: modelId };
}

function asUpdatedAt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Full snapshot for GET /api/v2/conversations/{id}.
 * Uses present() fields and listSubagents(); does not re-read the transcript.
 */
export async function conversationSnapshot({
  presented,
  subagents = [],
  modelTarget = null,
  window,
  lang = 'zh',
  exists,
}: ConversationSnapshotInput): Promise<ConversationSnapshot> {
  const messages = Array.isArray(presented?.messages) ? presented.messages : [];
  const agents = Array.isArray(subagents) ? subagents : [];
  const run = runStateView({
    status: presented?.status,
    llmError: presented?.llmError,
    messages,
    subagents: agents,
    lang,
    hasWorkspace: Boolean(presented?.workspaceId),
  });
  const thread = await buildThread(messages, {
    lang,
    workspacePath: presented?.workspacePath == null ? '' : String(presented.workspacePath),
    subagents: agents,
    running: run.status === 'running',
    exists,
  });
  const conversation: ConversationView = {
    id: String(presented?.id ?? ''),
    workspaceId: presented?.workspaceId == null ? '' : String(presented.workspaceId),
    title: presented?.title == null ? '' : String(presented.title),
    updatedAt: asUpdatedAt(presented?.updatedAt),
    status: conversationStatus(run.status),
    model: conversationModelView(modelTarget),
    run,
    context: contextUsageView({ usage: presented?.usage, window }),
    itemIds: thread.items.map((item) => item.id),
  };
  return { conversation, items: thread.items, tools: thread.tools };
}
