import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { refreshWorkspaceGit } from '../data/api';
import type { ResolvedModel } from '../data/composerModel';
import type { Lang } from '../data/lang';
import { useConversation, useDraftSend } from '../data/useConversation';
import { usePendingSend, waitingForAgent } from '../data/usePendingSend';
import { t } from '../i18n';
import type { components } from '../../../src/v2/contract.gen';
import { Composer } from './Composer';
import { LeftOpenButton, RightToggle } from './RightToggle';
import { StatusBar } from './StatusBar';
import { SubagentPane } from './SubagentPane';
import { Thread } from './Thread';

type ConversationView = components['schemas']['ConversationView'];
type Workspace = components['schemas']['Workspace'];

type Props = {
  cid?: string | null;
  agentId?: string | null;
  workspaceId?: string | null;
  workspace?: Workspace | null;
  lang: Lang;
  demo?: boolean;
  onOpenLeft?: () => void;
  onNewWorkspace?: () => void;
};

const DRAFT_RUN: ConversationView['run'] = {
  status: 'idle',
  startedAt: null,
  pendingText: null,
  canSend: true,
  canStop: false,
  lockedReason: null,
  error: null,
};

function draftView(workspaceId: string, lang: Lang): ConversationView {
  return {
    id: '',
    workspaceId,
    title: t(lang, 'new_conversation'),
    updatedAt: 0,
    status: 'idle',
    model: null,
    run: DRAFT_RUN,
    context: { used: 0, window: 128000, percent: 0, level: 'ok' },
    itemIds: [],
  };
}

export function CenterPane({
  cid,
  agentId,
  workspaceId,
  workspace = null,
  lang,
  demo = false,
  onOpenLeft,
  onNewWorkspace,
}: Props) {
  const isDraft = !cid && Boolean(workspaceId);
  const { conversation, items, toolsById, missing, actions } = useConversation(cid);
  // 乐观发送：回车即上屏，服务端确认后收敛（草稿页直接跳转，暂不接）
  const optimistic = usePendingSend(items, actions.send);
  const shownItems = useMemo(
    () => (optimistic.pending.length ? [...items, ...optimistic.pending] : items),
    [items, optimistic.pending],
  );
  const [draftModel, setDraftModel] = useState<ResolvedModel | null>(null);
  const draftModelRef = useRef<ResolvedModel | null>(null);
  draftModelRef.current = draftModel;
  const modelForCreate = useCallback(() => draftModelRef.current, []);
  const draftActions = useDraftSend(workspaceId, modelForCreate);
  const [stickNonce, setStickNonce] = useState(0);
  const bumpStick = useCallback(() => setStickNonce((n) => n + 1), []);
  const refreshId = workspace?.id || workspaceId || conversation?.workspaceId || null;

  useEffect(() => {
    if (!refreshId) return;
    void refreshWorkspaceGit(refreshId).catch(() => {});
  }, [refreshId, cid]);

  if (cid && agentId) {
    return (
      <SubagentPane
        cid={cid}
        agentId={agentId}
        lang={lang}
        demo={demo}
        onOpenLeft={onOpenLeft}
      />
    );
  }

  if (isDraft && workspaceId) {
    const draft = draftView(workspaceId, lang);
    return (
      <main className="col-center" data-testid="next-center">
        <StatusBar
          conversation={draft}
          lang={lang}
          demo={demo}
          onOpenLeft={onOpenLeft}
          workspace={workspace}
        />
        <Thread
          items={[]}
          toolsById={{}}
          lang={lang}
          running={false}
          actions={draftActions}
          stickNonce={stickNonce}
          isDraft
          draftWorkspaceName={workspace?.name || null}
        />
        <Composer
          lang={lang}
          run={DRAFT_RUN}
          demo={demo}
          workspaceId={workspaceId}
          model={null}
          context={draft.context}
          isDraft
          draftModel={draftModel}
          onDraftModel={setDraftModel}
          onNewWorkspace={onNewWorkspace}
          onSend={draftActions.send}
          onStop={draftActions.stop}
          onSent={bumpStick}
        />
      </main>
    );
  }

  if (missing) {
    return (
      <main className="col-center" data-testid="next-center">
        <header className="next-status">
          <div className="next-status-inner">
            <LeftOpenButton lang={lang} onOpen={onOpenLeft} />
            <h1 className="top-title">{t(lang, 'home_title')}</h1>
            <div className="top-right"><RightToggle lang={lang} /></div>
          </div>
        </header>
        <div className="thread-empty">
          <p className="next-error" data-testid="next-error">{t(lang, 'missing_conversation')}</p>
        </div>
      </main>
    );
  }

  if (!conversation) {
    return (
      <main className="col-center" data-testid="next-center">
        <header className="next-status">
          <div className="next-status-inner">
            <LeftOpenButton lang={lang} onOpen={onOpenLeft} />
            <p>{t(lang, 'loading')}</p>
            <div className="top-right"><RightToggle lang={lang} /></div>
          </div>
        </header>
      </main>
    );
  }

  const liveTools = items.some((item) => (
    item.kind === 'tool_group' && (item.live || item.summary.running)
  ));

  return (
    <main className="col-center" data-testid="next-center">
      <StatusBar
        conversation={conversation}
        lang={lang}
        demo={demo}
        hidePending={liveTools}
        onOpenLeft={onOpenLeft}
        workspace={workspace}
      />
        <Thread
          items={shownItems}
          toolsById={toolsById}
          lang={lang}
          running={conversation.run.status === 'running'}
          pending={waitingForAgent(shownItems, {
            running: conversation.run.status === 'running',
            pending: optimistic.sending,
          })}
          actions={actions}
          stickNonce={stickNonce}
          conversationId={cid}
          conversationModel={conversation.model}
        />
        <Composer
          lang={lang}
          run={conversation.run}
          demo={demo}
          conversationId={cid}
          workspaceId={conversation.workspaceId || workspaceId}
          model={conversation.model}
          context={conversation.context}
          onNewWorkspace={onNewWorkspace}
          onSend={optimistic.send}
          onStop={actions.stop}
          onSent={bumpStick}
        />
    </main>
  );
}
