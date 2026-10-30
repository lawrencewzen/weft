import { useCallback, useMemo, useRef } from 'react';
import type { components } from '../../../src/v2/contract.gen';
import {
  continueRun as continueRunApi,
  createConversation,
  patchConversation,
  sendMessage,
  stop as stopApi,
  toolOutput,
  withdrawMessage as withdrawMessageApi,
  type ResolvedModel,
  type SendMode,
  type ThinkingLevel,
} from './api';

type MessageImage = components['schemas']['MessageImage'];
type SendMessageFile = components['schemas']['SendMessageFile'];
import { getPreferredLang } from './lang';
import { navigate, conversationPath } from './nav';
import { useSession } from './session';
import {
  conversationTopic,
  type Change,
  type ConversationView,
  type ThreadItem,
  type ToolCall,
} from './store';
import { useStoreTopic } from './useStoreTopic';

export type ConversationActions = {
  send: (
    text: string,
    requestId?: string,
    images?: MessageImage[],
    mode?: SendMode,
    files?: SendMessageFile[],
    pastes?: string[],
  ) => Promise<unknown>;
  stop: () => ReturnType<typeof stopApi>;
  continueRun: (requestId?: string) => ReturnType<typeof continueRunApi>;
  loadToolOutput: (toolId: string) => ReturnType<typeof toolOutput>;
  withdraw: (requestId: string) => Promise<{ ok: true }>;
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
  const id = cid || '';
  useStoreTopic(store, id ? conversationTopic(id) : null);

  const conversation = id ? store.conversation(id) : undefined;
  const items = id ? store.items(id) : [];
  const toolsById = id ? store.toolsById(id) : {};
  const changes = id ? store.changes(id) : [];
  const missing = Boolean(id) && store.isMissing(conversationTopic(id));

  const send = useCallback((
    text: string,
    requestId?: string,
    images?: MessageImage[],
    mode?: SendMode,
    files?: SendMessageFile[],
    pastes?: string[],
  ) => (
    sendMessage(id, text, requestId, images, mode, files, pastes)
  ), [id]);
  const stop = useCallback(() => stopApi(id), [id]);
  const continueRun = useCallback((requestId?: string) => continueRunApi(id, requestId), [id]);
  const loadToolOutput = useCallback((toolId: string) => toolOutput(id, toolId), [id]);
  const withdraw = useCallback((requestId: string) => withdrawMessageApi(id, requestId), [id]);

  const actions = useMemo(
    () => ({ send, stop, continueRun, loadToolOutput, withdraw }),
    [send, stop, continueRun, loadToolOutput, withdraw],
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
  thinkingLevelForCreate?: () => ThinkingLevel | null,
): ConversationActions {
  const created = useRef<{ workspaceId: string; conversationId: string } | null>(null);
  const wsId = workspaceId || '';

  const send = useCallback(async (
    text: string,
    requestId?: string,
    images?: MessageImage[],
    mode?: SendMode,
    files?: SendMessageFile[],
    pastes?: string[],
  ) => {
    if (!created.current || created.current.workspaceId !== wsId) {
      const conversation = await createConversation(wsId || null, undefined, getPreferredLang());
      created.current = { workspaceId: wsId, conversationId: conversation.id };
      const model = modelForCreate?.() || null;
      const thinkingLevel = thinkingLevelForCreate?.() ?? null;
      if (model || thinkingLevel) {
        await patchConversation(conversation.id, {
          ...(model ? { model } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        });
      }
    }
    const cid = created.current.conversationId;
    await sendMessage(cid, text, requestId, images, mode, files, pastes);
    navigate(conversationPath(cid));
  }, [wsId, modelForCreate, thinkingLevelForCreate]);

  return useMemo(() => ({
    send,
    stop: noopStop,
    continueRun: noopContinue,
    loadToolOutput: noopTool,
    withdraw: () => Promise.resolve({ ok: true as const }),
  }), [send]);
}
