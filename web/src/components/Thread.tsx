import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { components } from '../../../src/v2/contract.gen';
import { modelAttribution, type ConversationModel } from '../data/composerModel';
import { matchDispatchSubagents } from '../data/dispatchCard';
import type { Lang } from '../data/lang';
import { useSession } from '../data/session';
import type { ConversationActions } from '../data/useConversation';
import { useProviders } from '../data/useProviders';
import { subagentTopic, type ThreadItem, type ToolCall } from '../data/store';
import { useStoreTopics } from '../data/useStoreTopic';
import { conversationPath, navigate } from '../data/nav';
import { t } from '../i18n';
import { AssistantMessage } from './AssistantMessage';
import { ChangeSummary } from './ChangeSummary';
import { DispatchCard } from './DispatchCard';
import { SubagentReport } from './SubagentReport';
import { openReportDialog } from '../data/reportDialog';
import { SystemNote } from './SystemNote';
import { ToolGroup } from './ToolGroup';
import { UserCommandBubble } from './UserCommandBubble';
import { UserMessage } from './UserMessage';
import { WorkspaceChip } from './WorkspaceChip';
import { createSendRequest, errorMessage } from './sendRequest';
import { computeScrollTarget, isNearBottom, STICK_PX } from './threadScroll';

export { STICK_PX, computeScrollTarget, isNearBottom } from './threadScroll';

/** Right-edge classic scrollbar strip, in CSS px. Overlay scrollbars are 0.
 *  `scrollbar-gutter: stable both-edges` makes offsetWidth-clientWidth the
 *  sum of both gutters; the scrollbar itself occupies only the right one. */
function rightScrollbarStripPx(el: HTMLElement): number {
  const total = Math.max(0, el.offsetWidth - el.clientWidth);
  if (total === 0) return 0;
  const gutter = getComputedStyle(el).scrollbarGutter || '';
  return /\bboth-edges\b/.test(gutter) ? total / 2 : total;
}

function syncThreadScrollbarGutter(el: HTMLElement) {
  el.style.setProperty('--thread-sb', `${rightScrollbarStripPx(el)}px`);
}

type Props = {
  items: ThreadItem[];
  toolsById: Record<string, ToolCall>;
  lang: Lang;
  running: boolean;
  /** Sent but not yet answered: show the plain 「思考中」row under the last user message. */
  pending?: boolean;
  pendingText?: string | null;
  /** The model request failed and the kernel is waiting to retry. pendingText then holds the sentence. */
  retrying?: boolean;
  actions: ConversationActions;
  stickNonce: number;
  conversationId?: string | null;
  conversationModel?: ConversationModel | null;
  isDraft?: boolean;
  draftWorkspaceId?: string | null;
  draftWorkspaceName?: string | null;
  onPickWorkspace?: (workspaceId: string | null) => void;
  onNewWorkspace?: () => void;
  className?: string;
  testId?: string;
  onToolGroupRender?: () => void;
  failed?: boolean;
  error?: components['schemas']['RunState']['error'];
  onContinue?: (requestId?: string) => Promise<unknown>;
  compaction?: (components['schemas']['RunState']['compaction'] & { instructions?: string }) | null;
  handoff?: { state: 'running' | 'failed'; instructions?: string; error?: string } | null;
  forkedFrom?: components['schemas']['ForkedFrom'] | null;
  onFork?: (entryId: string) => void;
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
          <span>{t(lang, 'draft_hero_chat')}</span>
        )}
      </div>
      {hasProject ? (
        <p className="draft-hero-hint">
          {t(lang, 'draft_hint', { name: workspaceName || '' })}
        </p>
      ) : null}
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
  retrying = false,
  actions,
  stickNonce,
  conversationId,
  conversationModel = null,
  isDraft = false,
  draftWorkspaceId = null,
  draftWorkspaceName = null,
  onPickWorkspace,
  onNewWorkspace,
  className,
  testId = 'next-thread',
  onToolGroupRender,
  failed = false,
  error = null,
  onContinue,
  compaction,
  handoff = null,
  forkedFrom = null,
  onFork,
}: Props) {
  const { providers } = useProviders();
  const scroller = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const programmaticScrollRef = useRef(false);
  const programmaticRafRef = useRef<number | null>(null);
  const lastProgrammaticTargetRef = useRef<number | null>(null);
  const lastHeightRef = useRef(0);
  const prevStickNonce = useRef(stickNonce);
  const prevConversationId = useRef(conversationId);
  const empty = items.length === 0;
  const compacting = compaction?.state === 'running';
  const manualCompacting = compacting && compaction?.trigger === 'manual';
  const handoffRunning = handoff?.state === 'running';
  const handoffFailed = handoff?.state === 'failed';
  // A blocking compaction failure also lands as the run error with the same sentence: show it once.
  const compactionError = !compacting && compaction?.state === 'failed' && compaction.error
    && !(failed && error?.message === compaction.error)
    ? compaction.error
    : null;

  const continueReq = useRef(createSendRequest());
  const [continueBusy, setContinueBusy] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  useEffect(() => {
    setContinueError(null);
  }, [conversationId, failed]);

  useEffect(() => {
    return () => {
      if (programmaticRafRef.current !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(programmaticRafRef.current);
      }
    };
  }, []);

  async function handleContinue() {
    if (continueBusy) return;
    const continueFn = onContinue || actions?.continueRun;
    if (!continueFn) return;
    const requestId = continueReq.current.begin('continue');
    setContinueBusy(true);
    setContinueError(null);
    try {
      await continueFn(requestId);
      continueReq.current.succeed();
    } catch (err) {
      setContinueError(errorMessage(err, t(lang, 'send_failed')));
    } finally {
      setContinueBusy(false);
    }
  }

  const scrollToBottom = useCallback((el: HTMLElement) => {
    const inner = innerRef.current || el.querySelector<HTMLElement>('.thread-inner');
    const padBottom = inner ? parseFloat(getComputedStyle(inner).paddingBottom) || 0 : 0;
    const target = computeScrollTarget(el.scrollHeight, el.clientHeight, padBottom);

    lastProgrammaticTargetRef.current = target;

    if (Math.abs(el.scrollTop - target) > 1) {
      programmaticScrollRef.current = true;
      el.scrollTop = target;

      if (programmaticRafRef.current !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(programmaticRafRef.current);
      }
      if (typeof requestAnimationFrame !== 'undefined') {
        programmaticRafRef.current = requestAnimationFrame(() => {
          programmaticRafRef.current = requestAnimationFrame(() => {
            programmaticScrollRef.current = false;
            programmaticRafRef.current = null;
          });
        });
      } else {
        setTimeout(() => {
          programmaticScrollRef.current = false;
        }, 50);
      }
    }
  }, []);

  useLayoutEffect(() => {
    if (prevStickNonce.current !== stickNonce) {
      prevStickNonce.current = stickNonce;
      stick.current = true;
    }
    if (prevConversationId.current !== conversationId) {
      prevConversationId.current = conversationId;
      stick.current = true;
      lastHeightRef.current = 0;
    }

    const el = scroller.current;
    if (!el) return;
    if (!stick.current) return;
    scrollToBottom(el);
    if (innerRef.current) {
      lastHeightRef.current = Math.max(innerRef.current.offsetHeight, innerRef.current.scrollHeight);
    }
  }, [
    conversationId,
    items,
    pending,
    stickNonce,
    failed,
    error?.message,
    compacting,
    compactionError,
    handoffRunning,
    scrollToBottom,
  ]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const sync = () => {
      syncThreadScrollbarGutter(el);
      if (stick.current) {
        scrollToBottom(el);
      }
    };
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = innerRef.current;
    if (!el || !inner) return;

    lastHeightRef.current = Math.max(inner.offsetHeight, inner.scrollHeight);

    function checkAndFollow() {
      if (!stick.current) return;
      const targetEl = scroller.current;
      const targetInner = innerRef.current;
      if (!targetEl || !targetInner) return;
      const currentHeight = Math.max(targetInner.offsetHeight, targetInner.scrollHeight);
      if (currentHeight > lastHeightRef.current) {
        lastHeightRef.current = currentHeight;
        scrollToBottom(targetEl);
      } else {
        lastHeightRef.current = currentHeight;
      }
    }

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        checkAndFollow();
      });
      ro.observe(inner);
    }

    let mo: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(() => {
        checkAndFollow();
      });
      mo.observe(inner, { childList: true, subtree: true, characterData: true });
    }

    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [conversationId, scrollToBottom]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    if (isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight, STICK_PX)) {
      stick.current = true;
      return;
    }
    // Distance from bottom is >= STICK_PX:
    // If scrollTop matches our programmatic target (content expanded before/during this scroll event),
    // do NOT treat it as the user scrolling up.
    if (
      programmaticScrollRef.current &&
      lastProgrammaticTargetRef.current !== null &&
      Math.abs(el.scrollTop - lastProgrammaticTargetRef.current) <= 2
    ) {
      return;
    }
    stick.current = false;
  }

  const [expandedEarlier, setExpandedEarlier] = useState(false);
  useEffect(() => {
    setExpandedEarlier(false);
  }, [conversationId]);

  let lastHandoffIndex = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'system_note' && item.noteKind === 'handoff') {
      lastHandoffIndex = i;
      break;
    }
  }

  function renderItem(item: ThreadItem) {
    if (item.kind === 'user') {
      return (
        <UserMessage
          key={item.id}
          item={item}
          lang={lang}
          conversationId={conversationId}
          onFork={onFork}
        />
      );
    }
    if (item.kind === 'assistant') {
      return (
        <AssistantMessage
          key={item.id}
          item={item}
          lang={lang}
          running={running}
          attribution={modelAttribution(item.model, providers, conversationModel)}
          onFork={onFork}
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
      return <SystemNote key={item.id} item={item} lang={lang} />;
    }
    if (item.kind === 'turn_changes') {
      return <ChangeSummary key={item.id} changes={item.changes} lang={lang} />;
    }
    return null;
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
      <div className={innerClass} ref={innerRef}>
        {forkedFrom ? (
          <div className="thread-forked-from" data-testid="next-forked-from">
            <span className="thread-forked-label">{t(lang, 'forked_from')}</span>
            <button
              type="button"
              className="thread-forked-link"
              data-testid="next-forked-link"
              onClick={() => navigate(conversationPath(forkedFrom.conversationId))}
            >
              {forkedFrom.title}
            </button>
            <span className="thread-forked-note">{t(lang, 'forked_shared_workspace')}</span>
          </div>
        ) : null}
        {empty ? (
          <DraftHero
            lang={lang}
            workspaceId={draftWorkspaceId}
            workspaceName={draftWorkspaceName}
            onPickWorkspace={onPickWorkspace}
            onNewWorkspace={onNewWorkspace}
          />
        ) : (
          <>
            {lastHandoffIndex > 0 ? (
              <button
                type="button"
                className={`thread-earlier-toggle${expandedEarlier ? ' is-expanded' : ''}`}
                data-testid="next-thread-earlier-toggle"
                aria-expanded={expandedEarlier}
                onClick={() => setExpandedEarlier((v) => !v)}
              >
                <svg className={`icon earlier-chevron${expandedEarlier ? ' is-open' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                <span>{t(lang, 'earlier_context_count', { n: lastHandoffIndex })}</span>
              </button>
            ) : null}
            {lastHandoffIndex > 0 && expandedEarlier
              ? items.slice(0, lastHandoffIndex).map(renderItem)
              : null}
            {lastHandoffIndex > 0
              ? items.slice(lastHandoffIndex).map(renderItem)
              : items.map(renderItem)}
          </>
        )}
        {handoffRunning ? (
          <>
            <UserCommandBubble
              kind="handoff"
              instructions={handoff?.instructions}
              lang={lang}
            />
            <div
              className="thread-pending"
              data-testid="next-thread-pending"
              data-kind="handoff"
              role="status"
            >
              <span className="run-spin" aria-hidden="true"><span /></span>
              <span className="thread-pending-text">{t(lang, 'pending_handoff_organizing')}</span>
            </div>
          </>
        ) : compacting ? (
          <>
            {manualCompacting ? (
              <UserCommandBubble
                kind="compaction"
                lang={lang}
                instructions={(compaction as { instructions?: string } | null | undefined)?.instructions}
              />
            ) : null}
            <div
              className="thread-pending"
              data-testid="next-thread-compacting"
              data-kind="compaction"
              role="status"
            >
              <span className="run-spin" aria-hidden="true"><span /></span>
              <span className="thread-pending-text">{t(lang, 'pending_compaction_running')}</span>
            </div>
          </>
        ) : pending ? (
          <div
            className={retrying ? 'thread-pending is-retrying' : 'thread-pending'}
            data-testid="next-thread-pending"
            data-retrying={retrying ? 'true' : undefined}
          >
            <span className="run-spin" aria-hidden="true"><span /></span>
            <span className="thread-pending-text">{pendingText || t(lang, 'pending_thinking')}</span>
          </div>
        ) : null}
        {handoffFailed ? (
          <>
            <UserCommandBubble
              kind="handoff"
              instructions={handoff?.instructions}
              lang={lang}
            />
            <div className="llm-error" data-testid="next-handoff-error" role="alert">
              <div className="llm-error-text">
                <span>{handoff?.error || t(lang, 'pending_handoff_failed')}</span>
              </div>
            </div>
          </>
        ) : null}
        {!running && failed && error?.message ? (
          <div
            className="llm-error"
            data-testid="next-run-error"
            role="alert"
            title={error.code || undefined}
          >
            <div className="llm-error-text">
              <span>{error.message}</span>
              {conversationId ? (
                <button
                  type="button"
                  className="llm-error-report"
                  data-testid="next-run-report"
                  onClick={() => openReportDialog({ conversationId })}
                >
                  {t(lang, 'report_link')}
                </button>
              ) : null}
              {continueError ? <span className="llm-error-inline-err">{continueError}</span> : null}
            </div>
            {error.canContinue ? (
              <button
                type="button"
                className="btn llm-error-continue"
                data-testid="next-run-continue"
                disabled={continueBusy}
                onClick={() => { void handleContinue(); }}
              >
                {t(lang, 'btn_continue')}
              </button>
            ) : null}
          </div>
        ) : null}
        {compactionError ? (
          <>
            {compaction?.trigger === 'manual' ? (
              <UserCommandBubble
                kind="compaction"
                lang={lang}
                instructions={(compaction as { instructions?: string } | null | undefined)?.instructions}
              />
            ) : null}
            <div className="llm-error" data-testid="next-compaction-error" role="alert">
              <div className="llm-error-text">
                <span>{compactionError}</span>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
