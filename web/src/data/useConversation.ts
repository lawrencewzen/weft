import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type { components } from '../../../src/v2/contract.gen';
import {
  continueRun as continueRunApi,
  createConversation,
  patchConversationModel,
  sendMessage,
  stop as stopApi,
  toolOutput,
  type ResolvedModel,
} from './api';

type MessageImage = components['schemas']['MessageImage'];
import { navigate, conversationPath } from './nav';
import { useSession } from './session';
import {
  conversationTopic,
  type Change,
  type ConversationView,
  type ThreadItem,
  type ToolCall,
} from './store';

export type ConversationActions = {
  send: (text: string, requestId?: string, images?: MessageImage[]) => Promise<unknown>;
  stop: () => ReturnType<typeof stopApi>;
  continueRun: (requestId?: string) => ReturnType<typeof continueRunApi>;
  loadToolOutput: (toolId: string) => ReturnType<typeof toolOutput>;
};

export type ConversationState = {
  conversation: ConversationView | undefined;
  items: ThreadItem[];
  toolsById: Record<string, ToolCall>;
  changes: Change[];
  status: ReturnType<typeof useSession>['status'];
  missing: boolean;
  actions: ConversationActions;
};

const noopStop = () => Promise.resolve({ stopping: true as const });
const noopContinue = () => Promise.resolve({ runId: '' });
const noopTool = () => Promise.resolve({
  id: '',
  text: '',
  totalLines: 0,
});

export function useConversation(cid: string | null | undefined): ConversationState {
  const { store, status } = useSession();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const id = cid || '';

  const conversation = id ? store.conversation(id) : undefined;
  const items = id ? store.items(id) : [];
  const toolsById = id ? store.toolsById(id) : {};
  const changes = id ? store.changes(id) : [];
  const missing = Boolean(id) && store.isMissing(conversationTopic(id));

  const send = useCallback((text: string, requestId?: string, images?: MessageImage[]) => (
    sendMessage(id, text, requestId, images)
  ), [id]);
  const stop = useCallback(() => stopApi(id), [id]);
  const continueRun = useCallback((requestId?: string) => continueRunApi(id, requestId), [id]);
  const loadToolOutput = useCallback((toolId: string) => toolOutput(id, toolId), [id]);

  const actions = useMemo(
    () => ({ send, stop, continueRun, loadToolOutput }),
    [send, stop, continueRun, loadToolOutput],
  );

  return { conversation, items, toolsById, changes, status, missing, actions };
}

/**
 * 草稿页发第一条消息时才建对话。已建好的对话只在**这一个草稿**里复用（sendMessage
 * 失败后 Composer 用同一个 requestId 重试，不能重复建对话）：
 * - 每次进入草稿页都是新的 CenterPane 实例（AppShell 里按草稿/对话给了不同的 key），
 *   ref 跟着重新初始化为空，所以第二次新对话不会发进上一个草稿建的对话；
 * - 草稿页里换工作区（Composer 的工作区切换）时，上一个工作区建的对话不再复用。
 */
export function useDraftSend(
  workspaceId: string | null | undefined,
  modelForCreate?: () => ResolvedModel | null,
): ConversationActions {
  const created = useRef<{ workspaceId: string; conversationId: string } | null>(null);
  const wsId = workspaceId || '';

  const send = useCallback(async (text: string, requestId?: string, images?: MessageImage[]) => {
    if (!wsId) throw new Error('no workspace');
    if (!created.current || created.current.workspaceId !== wsId) {
      const conversation = await createConversation(wsId);
      created.current = { workspaceId: wsId, conversationId: conversation.id };
      const model = modelForCreate?.() || null;
      if (model) await patchConversationModel(conversation.id, model);
    }
    const cid = created.current.conversationId;
    await sendMessage(cid, text, requestId, images);
    navigate(conversationPath(cid));
  }, [wsId, modelForCreate]);

  return useMemo(() => ({
    send,
    stop: noopStop,
    continueRun: noopContinue,
    loadToolOutput: noopTool,
  }), [send]);
}
