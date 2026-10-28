import { useLayoutEffect, useRef } from 'react';
import { modelAttribution, type ConversationModel } from '../data/composerModel';
import type { Lang } from '../data/lang';
import type { ConversationActions } from '../data/useConversation';
import { useProviders } from '../data/useProviders';
import type { Change, ThreadItem, ToolCall } from '../data/store';
import { t } from '../i18n';
import { AssistantMessage } from './AssistantMessage';
import { ChangeSummary } from './ChangeSummary';
import { SubagentReport } from './SubagentReport';
import { SystemNote } from './SystemNote';
import { ToolGroup } from './ToolGroup';
import { UserMessage } from './UserMessage';
import { WorkspaceChip } from './WorkspaceChip';

const STICK_PX = 80;

type Props = {
  items: ThreadItem[];
  toolsById: Record<string, ToolCall>;
  lang: Lang;
  running: boolean;
  /** Sent but not yet answered: show the plain 「思考中」row under the last user message. */
  pending?: boolean;
  pendingText?: string | null;
  actions: ConversationActions;
  stickNonce: number;
  conversationId?: string | null;
  conversationModel?: ConversationModel | null;
  changes?: Change[];
  isDraft?: boolean;
  draftWorkspaceId?: string | null;
  draftWorkspaceName?: string | null;
  onPickWorkspace?: (workspaceId: string) => void;
  onNewWorkspace?: () => void;
};

function DraftHero({
  lang,
  workspaceId,
  workspaceName,
  onPickWorkspace,
  onNewWorkspace,
}: {
  lang: Lang;
  workspaceId?: string | null;
  workspaceName?: string | null;
  onPickWorkspace?: (workspaceId: string) => void;
  onNewWorkspace?: () => void;
}) {
  return (
    <div className="draft-hero" data-testid="next-draft-hint">
      <div className="draft-hero-title">
        <span>{t(lang, 'draft_hero_before')}</span>
        <WorkspaceChip
          lang={lang}
          variant="hero"
          selectedId={workspaceId}
          canSwitch
          onPick={(id) => onPickWorkspace?.(id)}
          onNew={() => onNewWorkspace?.()}
        />
        <span>{t(lang, 'draft_hero_after')}</span>
      </div>
      <p className="draft-hero-hint">
        {workspaceName
          ? t(lang, 'draft_hint', { name: workspaceName })
          : t(lang, 'draft_hint_no_project')}
      </p>
    </div>
  );
}

export function Thread({
  items,
  toolsById,
  lang,
  running,
  pending = false,
  pendingText = null,
  actions,
  stickNonce,
  conversationId,
  conversationModel = null,
  changes = [],
  isDraft = false,
  draftWorkspaceId = null,
  draftWorkspaceName = null,
  onPickWorkspace,
  onNewWorkspace,
}: Props) {
  const { providers } = useProviders();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const empty = items.length === 0;

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

  const innerClass = [
    'thread-inner',
    empty ? 'is-empty' : '',
    empty && isDraft ? 'is-draft' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="center-thread" data-testid="next-thread" ref={scroller} onScroll={onScroll}>
      <div className={innerClass}>
        {empty ? (
          isDraft ? (
            <DraftHero
              lang={lang}
              workspaceId={draftWorkspaceId}
              workspaceName={draftWorkspaceName}
              onPickWorkspace={onPickWorkspace}
              onNewWorkspace={onNewWorkspace}
            />
          ) : (
            <div className="thread-empty">{t(lang, 'empty_chat_hint')}</div>
          )
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
        {!empty && changes.length ? (
          <ChangeSummary changes={changes} lang={lang} />
        ) : null}
        {pending ? (
          <div className="thread-pending" data-testid="next-thread-pending">
            <span className="run-spin" aria-hidden="true"><span /></span>
            <span className="thread-pending-text">{pendingText || t(lang, 'pending_thinking')}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
