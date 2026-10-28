/** Assemble a conversation snapshot. HTTP layer only loads data and calls this. */

import type { Lang } from '../phrases/index.ts';
import type { components } from '../contract.gen.ts';
import { contextWindowFromEnv } from '../../core/usage.mjs';
import { contextUsageView } from './context.ts';
import { conversationStatus, runStateView } from './run.ts';
import { buildThread, type BuildThreadOptions, type ThreadMessage, type ThreadSubagent } from './thread.ts';
import { outputLineCount, toolOutputText, type ToolLike } from './tools.ts';

export type ConversationView = components['schemas']['ConversationView'];
export type ConversationSnapshot = components['schemas']['ConversationSnapshot'];
export type ConversationModel = components['schemas']['ConversationModel'];
export type ConversationSend = components['schemas']['ConversationSend'];
export type ToolOutput = components['schemas']['ToolOutput'];

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
  /** Where the conversation's recent sends landed; see `sendsView`. */
  sends?: unknown;
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

export type LoadConversation = (id: string) => Promise<Omit<ConversationSnapshotInput, 'lang' | 'exists'> | null>;

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

/** Present() sends → contract. Rows without a requestId are dropped. */
export function sendsView(value: unknown): ConversationSend[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationSend[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const requestId = typeof row.requestId === 'string' ? row.requestId : '';
    if (!requestId) continue;
    const entryId = row.entryId == null ? '' : String(row.entryId);
    const send: ConversationSend = {
      requestId,
      entryId: entryId || null,
      dropped: row.dropped === true,
    };
    if (row.mode === 'queue' || row.mode === 'steer') send.mode = row.mode;
    if (typeof row.text === 'string') send.text = row.text;
    out.push(send);
  }
  return out;
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
    conversationId: presented?.id == null ? '' : String(presented.id),
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
    context: contextUsageView({
      usage: presented?.usage,
      window: window ?? contextWindowFromEnv(),
    }),
    itemIds: thread.items.map((item) => item.id),
    sends: sendsView(presented?.sends),
  };
  return { conversation, items: thread.items, tools: thread.tools };
}

/** Raw tool payload from present() messages, or null when the id is missing. */
export function findPresentedTool(
  presented: PresentedConversation | null | undefined,
  toolId: string,
): ToolLike | null {
  if (!toolId) return null;
  for (const message of presented?.messages || []) {
    const tool = message?.tool;
    if (message?.role === 'tool' && tool && String(tool.id) === toolId) return tool;
  }
  return null;
}

/** Full tool output for GET .../tools/{toolId}/output. Paths are workspace-relative. */
export function toolOutputView(
  tool: ToolLike,
  workspacePath: unknown,
): ToolOutput {
  const text = toolOutputText(tool, workspacePath == null ? '' : String(workspacePath));
  return {
    id: String(tool?.id ?? ''),
    text,
    totalLines: outputLineCount(text),
  };
}
