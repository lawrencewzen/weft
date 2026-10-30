import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { modelAttribution, type ConversationModel } from '../data/composerModel';
import { matchDispatchSubagents } from '../data/dispatchCard';
import type { Lang } from '../data/lang';
import { useSession } from '../data/session';
import type { ConversationActions } from '../data/useConversation';
import { useProviders } from '../data/useProviders';
import { subagentTopic, type Change, type ThreadItem, type ToolCall } from '../data/store';
import { useStoreTopics } from '../data/useStoreTopic';
import { t } from '../i18n';
import { AssistantMessage } from './AssistantMessage';
import { ChangeSummary } from './ChangeSummary';
import { DispatchCard } from './DispatchCard';
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
  onPickWorkspace?: (workspaceId: string | null) => void;
  onNewWorkspace?: () => void;
  className?: string;
  testId?: string;
  onToolGroupRender?: () => void;
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
  onPickWorkspace?: (workspaceId: string | null) => void;
  onNewWorkspace?: () => void;
}) {
  const hasProject = Boolean(workspaceName);
  return (
    <div className="draft-hero" data-testid="next-draft-hint">
      <div className="draft-hero-title">
        {hasProject ? (
          <>
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
          </>
        ) : (
          <>
            <span>{t(lang, 'draft_hero_chat')}</span>
            <WorkspaceChip
              lang={lang}
              variant="hero"
              selectedId={workspaceId}
              canSwitch
              onPick={(id) => onPickWorkspace?.(id)}
              onNew={() => onNewWorkspace?.()}
            />
          </>
        )}
      </div>
      <p className="draft-hero-hint">
        {hasProject
          ? t(lang, 'draft_hint', { name: workspaceName || '' })
          : t(lang, 'draft_hint_chat')}
      </p>
    </div>
  );
}

type ToolGroupItemProps = {
  item: Extract<ThreadItem, { kind: 'tool_group' }>;
  toolsById: Record<string, ToolCall>;
  lang: Lang;
  conversationId?: string | null;
  onLoadOutput: (toolId: string) => Promise<{ text: string }>;
  onRender?: () => void;
};

export const ToolGroupItem = memo(
  function ToolGroupItem({
    item,
    toolsById,
    lang,
    conversationId,
    onLoadOutput,
    onRender,
  }: ToolGroupItemProps) {
    if (onRender) onRender();
    const { store } = useSession();
    const subagents = conversationId
      ? store.subagents(conversationId).map((agent) => store.subagent(conversationId, agent.id) || agent)
      : [];
    const match = matchDispatchSubagents(item, subagents);
    const matchedTopics = useMemo(() => {
      if (!conversationId || !match?.subagents.length) return [];
      return match.subagents.map((agent) => subagentTopic(conversationId, agent.id));
    }, [conversationId, match?.subagents]);

    useStoreTopics(store, matchedTopics);

    if (!match) {
      return (
        <ToolGroup
          item={item}
          toolsById={toolsById}
          lang={lang}
          onLoadOutput={onLoadOutput}
        />
      );
    }

    if (match.allDispatch) {
      return (
        <DispatchCard
          cid={conversationId || ''}
          agents={match.subagents}
          lang={lang}
        />
      );
    }

    return (
      <div className="tool-dispatch-pair">
        <ToolGroup
          item={item}
          toolsById={toolsById}
          lang={lang}
          onLoadOutput={onLoadOutput}
        />
        <DispatchCard
          cid={conversationId || ''}
          agents={match.subagents}
          lang={lang}
        />
      </div>
    );
  },
  (prev, next) => (
    prev.item === next.item
    && prev.toolsById === next.toolsById
    && prev.lang === next.lang
    && prev.conversationId === next.conversationId
    && prev.onLoadOutput === next.onLoadOutput
    && prev.onRender === next.onRender
  ),
);

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
  className,
  testId = 'next-thread',
  onToolGroupRender,
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
    <div
      className={['center-thread', className].filter(Boolean).join(' ')}
      data-testid={testId}
      ref={scroller}
      onScroll={onScroll}
    >
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
            if (item.kind === 'user') return <UserMessage key={item.id} item={item} lang={lang} conversationId={conversationId} />;
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
                <ToolGroupItem
                  key={item.id}
                  item={item}
                  toolsById={toolsById}
                  lang={lang}
                  conversationId={conversationId}
                  onLoadOutput={actions.loadToolOutput}
                  onRender={onToolGroupRender}
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
