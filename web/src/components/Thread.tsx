import { useLayoutEffect, useRef } from 'react';
import { modelAttribution, type ConversationModel } from '../data/composerModel';
import type { Lang } from '../data/lang';
import type { ConversationActions } from '../data/useConversation';
import { useProviders } from '../data/useProviders';
import type { ThreadItem, ToolCall } from '../data/store';
import { t } from '../i18n';
import { AssistantMessage } from './AssistantMessage';
import { SubagentReport } from './SubagentReport';
import { SystemNote } from './SystemNote';
import { ToolGroup } from './ToolGroup';
import { UserMessage } from './UserMessage';

const STICK_PX = 80;

type Props = {
  items: ThreadItem[];
  toolsById: Record<string, ToolCall>;
  lang: Lang;
  running: boolean;
  /** Sent but not yet answered: show the plain 「思考中」row under the last user message. */
  pending?: boolean;
  actions: ConversationActions;
  stickNonce: number;
  conversationId?: string | null;
  conversationModel?: ConversationModel | null;
  isDraft?: boolean;
  draftWorkspaceName?: string | null;
};

export function Thread({
  items,
  toolsById,
  lang,
  running,
  pending = false,
  actions,
  stickNonce,
  conversationId,
  conversationModel = null,
  isDraft = false,
  draftWorkspaceName = null,
}: Props) {
  const { providers } = useProviders();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!stick.current) return;
    const inner = el.querySelector('.thread-inner');
    const padBottom = inner ? parseFloat(getComputedStyle(inner).paddingBottom) || 0 : 0;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = maxScroll <= padBottom + 1 ? 0 : maxScroll;
  }, [items, pending, stickNonce]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  }

  return (
    <div className="center-thread" data-testid="next-thread" ref={scroller} onScroll={onScroll}>
      <div className="thread-inner">
        {items.length === 0 ? (
          <div className="thread-empty" data-testid={isDraft ? 'next-draft-hint' : undefined}>
            {isDraft
              ? (draftWorkspaceName
                ? t(lang, 'draft_hint', { name: draftWorkspaceName })
                : t(lang, 'draft_hint_no_project'))
              : t(lang, 'empty_chat_hint')}
          </div>
        ) : items.map((item) => {
            if (item.kind === 'user') return <UserMessage key={item.id} item={item} lang={lang} />;
            if (item.kind === 'assistant') {
              return (
                <AssistantMessage
                  key={item.id}
                  item={item}
                  lang={lang}
                  canContinue={item.truncated && !running}
                  onContinue={(requestId) => actions.continueRun(requestId)}
                  attribution={modelAttribution(item.model, providers, conversationModel)}
                />
              );
            }
            if (item.kind === 'tool_group') {
              return (
                <ToolGroup
                  key={item.id}
                  item={item}
                  toolsById={toolsById}
                  lang={lang}
                  onLoadOutput={actions.loadToolOutput}
                />
              );
            }
            if (item.kind === 'subagent_report') {
              return (
                <SubagentReport
                  key={item.id}
                  item={item}
                  lang={lang}
                  conversationId={conversationId}
                />
              );
            }
            if (item.kind === 'system_note') {
              return <SystemNote key={item.id} item={item} />;
            }
            return null;
          })}
        {pending ? (
          <div className="thread-pending" data-testid="next-thread-pending">
            <span className="run-spin" aria-hidden="true"><span /></span>
            <span className="thread-pending-text">{t(lang, 'pending_thinking')}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
