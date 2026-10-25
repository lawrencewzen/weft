import { useCallback, useState } from 'react';
import type { Lang } from '../data/lang';
import { useConversation, useDraftSend } from '../data/useConversation';
import { t } from '../i18n';
import type { components } from '../../../src/v2/contract.gen';
import { Composer } from './Composer';
import { StatusBar } from './StatusBar';
import { Thread } from './Thread';

type ConversationView = components['schemas']['ConversationView'];

type Props = {
  cid?: string | null;
  workspaceId?: string | null;
  lang: Lang;
  showOpenLeft?: boolean;
  onOpenLeft?: () => void;
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
  workspaceId,
  lang,
  showOpenLeft = false,
  onOpenLeft,
}: Props) {
  const isDraft = !cid && Boolean(workspaceId);
  const { conversation, items, toolsById, missing, actions } = useConversation(cid);
  const draftActions = useDraftSend(workspaceId);
  const [stickNonce, setStickNonce] = useState(0);
  const bumpStick = useCallback(() => setStickNonce((n) => n + 1), []);

  if (isDraft && workspaceId) {
    const draft = draftView(workspaceId, lang);
    return (
      <main className="col-center" data-testid="next-center">
        <StatusBar
          conversation={draft}
          lang={lang}
          showOpenLeft={showOpenLeft}
          onOpenLeft={onOpenLeft}
        />
        <Thread
          items={[]}
          toolsById={{}}
          lang={lang}
          running={false}
          actions={draftActions}
          stickNonce={stickNonce}
        />
        <Composer
          lang={lang}
          run={DRAFT_RUN}
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
            {showOpenLeft ? (
              <button
                type="button"
                className="icon-btn top-left-open"
                data-testid="next-left-open"
                title={t(lang, 'expand_sidebar')}
                onClick={onOpenLeft}
              >
                <span className="ico-panel ico-panel-left" aria-hidden="true" />
              </button>
            ) : null}
            <h1 className="top-title">{t(lang, 'home_title')}</h1>
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
            {showOpenLeft ? (
              <button
                type="button"
                className="icon-btn top-left-open"
                data-testid="next-left-open"
                title={t(lang, 'expand_sidebar')}
                onClick={onOpenLeft}
              >
                <span className="ico-panel ico-panel-left" aria-hidden="true" />
              </button>
            ) : null}
            <p>{t(lang, 'loading')}</p>
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
        hidePending={liveTools}
        showOpenLeft={showOpenLeft}
        onOpenLeft={onOpenLeft}
      />
      <Thread
        items={items}
        toolsById={toolsById}
        lang={lang}
        running={conversation.run.status === 'running'}
        actions={actions}
        stickNonce={stickNonce}
      />
      <Composer
        lang={lang}
        run={conversation.run}
        onSend={actions.send}
        onStop={actions.stop}
        onSent={bumpStick}
      />
    </main>
  );
}
