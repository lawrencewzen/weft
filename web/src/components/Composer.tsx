import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AgentsStrip } from './AgentsStrip';
import { StallStrip } from './StallStrip';
import { patchConversation, putModelContextWindow, type SendMessageFile, type ThinkingLevel } from '../data/api';
import {
  IMAGE_MAX_COUNT,
  type ComposerHint,
  type MessageImage,
} from '../data/attachments';
import { AtMentionMenu } from './composer/AtMentionMenu';
import { ComposerTags } from './composer/ComposerTags';
import { GitChip } from './composer/GitChip';
import { PlusMenu } from './composer/PlusMenu';
import { useAtMention } from './composer/useAtMention';
import { useComposerAttachments } from './composer/useComposerAttachments';
import {
  clampThinkingLevel,
  contextIsWarn,
  groupComposerModels,
  hasAvailableModels,
  resolveComposerSelection,
  type ComposerModelOption,
  type ConversationModel,
  type ContextUsage,
  type ResolvedModel,
} from '../data/composerModel';
import type { Lang } from '../data/lang';
import { draftPath, navigate, newChatPath, openSettings } from '../data/nav';
import { NO_PROJECT_ID } from '../data/sidebarModel';
import type { QueueChip, SendMode } from '../data/pendingSend';
import { useProviders } from '../data/useProviders';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { writeActiveWorkspace } from '../data/layout';
import { useRightActions } from '../data/rightPaneContext';
import { ContextBanner, ContextChip } from './ContextChip';
import { DemoModelBadge } from './DemoModelBadge';
import { ModelChip } from './ModelChip';
import { WorkspaceChip } from './WorkspaceChip';
import { createSendRequest, errorMessage } from './sendRequest';

type RunState = components['schemas']['RunState'];

type Props = {
  lang: Lang;
  run: RunState;
  demo?: boolean;
  conversationId?: string | null;
  workspaceId?: string | null;
  workspacePath?: string | null;
  model?: ConversationModel | null;
  thinkingLevel?: ThinkingLevel | null;
  context?: ContextUsage;
  isDraft?: boolean;
  draftModel?: ResolvedModel | null;
  onDraftModel?: (model: ResolvedModel) => void;
  draftThinkingLevel?: ThinkingLevel | null;
  onDraftThinkingLevel?: (level: ThinkingLevel | null) => void;
  showModelControls?: boolean;
  onNewWorkspace?: () => void;
  onSend: (
    text: string,
    requestId: string,
    images?: MessageImage[],
    mode?: SendMode,
    files?: SendMessageFile[],
    pastes?: string[],
  ) => Promise<unknown>;
  onStop: () => Promise<unknown>;
  onSent?: () => void;
  queue?: QueueChip[];
  onWithdrawQueue?: (requestId: string) => Promise<unknown>;
};

const FALLBACK_CONTEXT: ContextUsage = { used: 0, window: 128000, percent: 0, level: 'ok' };

const TEXTAREA_MIN = 44;
const TEXTAREA_MAX = 200;

const SEND_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);
const STOP_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="3" />
  </svg>
);
const DROP_ICON = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </svg>
);

function hintText(lang: Lang, hint: ComposerHint): string {
  if (hint.kind === 'too_large') return t(lang, 'attach_too_large', { name: hint.name || '' });
  if (hint.kind === 'too_many') return t(lang, 'attach_too_many', { n: IMAGE_MAX_COUNT });
  if (hint.kind === 'bad_type') return t(lang, 'attach_bad_type', { name: hint.name || '' });
  if (hint.kind === 'no_vision') return t(lang, 'attach_no_vision');
  return t(lang, 'attach_outside', { name: hint.name || '' });
}

export function Composer({
  lang,
  run,
  demo = false,
  conversationId = null,
  workspaceId = null,
  workspacePath = null,
  model = null,
  thinkingLevel = null,
  context = FALLBACK_CONTEXT,
  isDraft = false,
  draftModel = null,
  onDraftModel,
  draftThinkingLevel = null,
  onDraftThinkingLevel,
  showModelControls = true,
  onNewWorkspace,
  onSend,
  onStop,
  onSent,
  queue = [],
  onWithdrawQueue,
}: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<ComposerHint | null>(null);
  const [focused, setFocused] = useState(false);
  const req = useRef(createSendRequest());
  const area = useRef<HTMLTextAreaElement>(null);
  const { providers, defaultModel, ready: providersReady } = useProviders();
  const { openInTerminal, copyPath } = useRightActions();
  const groups = useMemo(() => groupComposerModels(providers, defaultModel), [providers, defaultModel]);
  const available = hasAvailableModels(providers);
  const selected = useMemo(() => resolveComposerSelection({
    providers,
    conversationModel: model,
    defaultModel,
    draft: draftModel,
    isDraft,
  }), [providers, model, defaultModel, draftModel, isDraft]);
  const effectiveThinkingLevel = useMemo(() => {
    if (isDraft) {
      if (draftThinkingLevel !== undefined && draftThinkingLevel !== null) {
        return clampThinkingLevel(selected?.thinkingLevels, draftThinkingLevel);
      }
      return selected?.defaultThinkingLevel ?? null;
    }
    if (thinkingLevel !== undefined && thinkingLevel !== null) {
      return clampThinkingLevel(selected?.thinkingLevels, thinkingLevel);
    }
    return selected?.defaultThinkingLevel ?? null;
  }, [isDraft, draftThinkingLevel, thinkingLevel, selected]);
  const noModel = showModelControls && !demo && providersReady && !available;
  const locked = !run.canSend || noModel;
  const allowAttach = showModelControls && !noModel;
  const supportsImages = demo || selected?.images === true;

  function resize() {
    const el = area.current;
    if (!el) return;
    el.style.height = `${TEXTAREA_MIN}px`;
    el.style.height = `${Math.min(TEXTAREA_MAX, Math.max(TEXTAREA_MIN, el.scrollHeight))}px`;
  }

  const att = useComposerAttachments({
    lang,
    workspaceId,
    workspacePath,
    supportsImages,
    allowAttach,
    locked,
    draft,
    setDraft,
    setError,
    setHint,
    textareaRef: area,
    onResize: resize,
  });

  const at = useAtMention({
    workspaceId,
    draft,
    setDraft,
    locked,
    focused,
    setFocused,
    textareaRef: area,
    onResize: resize,
    addFileRef: att.addFileRef,
    addProjectFile: att.addProjectFile,
  });

  const hasPayload =
    Boolean(draft.trim()) ||
    att.images.length > 0 ||
    att.visibleFileRefs.length > 0 ||
    att.uploads.some((u) => u.status === 'done') ||
    att.pastes.length > 0;
  const canSend = hasPayload && !locked && !att.hasUploading && !att.hasUploadError;
  const stopMode = run.canStop && !hasPayload;
  const showBanner = showModelControls && !noModel && contextIsWarn(context.level);
  const running = run.status === 'running';
  const showNewline = !running && Boolean(draft.trim());
  const placeholder = noModel
    ? t(lang, 'composer_placeholder_no_model')
    : run.status === 'running'
      ? t(lang, 'composer_placeholder_running')
      : t(lang, 'composer_placeholder');

  useEffect(() => {
    resize();
  }, [draft]);

  async function submit(text = draft.trim(), mode?: SendMode) {
    const payload = text.trim();
    const { imagePayload, sentFiles, sentPastes, extraKey } = att.buildSendPayload();

    if (
      (!payload && !imagePayload.length && !sentFiles.length && !sentPastes.length) ||
      locked ||
      busy ||
      att.hasUploading ||
      att.hasUploadError
    ) {
      return;
    }

    const requestId = req.current.begin(payload, extraKey);
    setBusy(true);
    setError(null);
    setHint(null);
    const sentText = payload;
    const snapshot = att.takeAndClear();

    setDraft('');
    at.setCursorPos(null);
    at.setAtDismissed(false);
    requestAnimationFrame(resize);
    try {
      await onSend(
        sentText,
        requestId,
        imagePayload.length ? imagePayload : undefined,
        mode,
        sentFiles.length ? sentFiles : undefined,
        sentPastes.length ? sentPastes : undefined,
      );
      req.current.succeed();
      att.revokeSnapshot(snapshot);
      onSent?.();
    } catch (err) {
      setDraft((current) => (current ? current : sentText));
      att.restore(snapshot);
      setError(errorMessage(err, t(lang, 'send_failed')));
      requestAnimationFrame(resize);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    await submit(draft.trim());
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (at.handleKeyDown(event)) return;
    if (event.key === 'Escape') {
      if (att.pastePeekId) {
        event.preventDefault();
        att.setPastePeekId(null);
        return;
      }
    }
    if (event.key !== 'Enter') return;
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.shiftKey) return;
    if (event.altKey) {
      event.preventDefault();
      if (running) void submit(draft.trim(), 'queue');
      return;
    }
    event.preventDefault();
    void submit(draft.trim(), running ? 'steer' : undefined);
  }

  const pickModel = useCallback(async (option: ComposerModelOption) => {
    const next: ResolvedModel = { providerId: option.providerId, modelId: option.modelId };
    if (isDraft || !conversationId) {
      onDraftModel?.(next);
      if (draftThinkingLevel !== undefined && draftThinkingLevel !== null) {
        const clamped = clampThinkingLevel(option.thinkingLevels, draftThinkingLevel);
        onDraftThinkingLevel?.(clamped);
      }
      return;
    }
    try {
      await patchConversation(conversationId, { model: next });
    } catch (err) {
      setError(errorMessage(err, t(lang, 'send_failed')));
    }
  }, [conversationId, isDraft, lang, onDraftModel, draftThinkingLevel, onDraftThinkingLevel]);

  const pickThinkingLevel = useCallback(async (level: ThinkingLevel) => {
    if (isDraft || !conversationId) {
      onDraftThinkingLevel?.(level);
      return;
    }
    try {
      await patchConversation(conversationId, { thinkingLevel: level });
    } catch (err) {
      setError(errorMessage(err, t(lang, 'send_failed')));
    }
  }, [conversationId, isDraft, lang, onDraftThinkingLevel]);

  const pickRecent = useCallback(async (option: ComposerModelOption, level: ThinkingLevel | null) => {
    const next: ResolvedModel = { providerId: option.providerId, modelId: option.modelId };
    if (isDraft || !conversationId) {
      onDraftModel?.(next);
      onDraftThinkingLevel?.(level);
      return;
    }
    try {
      await patchConversation(conversationId, { model: next, thinkingLevel: level });
    } catch (err) {
      setError(errorMessage(err, t(lang, 'send_failed')));
    }
  }, [conversationId, isDraft, lang, onDraftModel, onDraftThinkingLevel]);

  const setWindow = useCallback(async (window: number | null) => {
    if (!selected?.providerId || !selected.modelId) return;
    try {
      await putModelContextWindow(selected.providerId, selected.modelId, window);
    } catch (err) {
      setError(errorMessage(err, t(lang, 'send_failed')));
    }
  }, [lang, selected]);

  function openManage() {
    openSettings('providers');
  }

  function openNewChat() {
    if (!workspaceId) return;
    navigate(draftPath(workspaceId));
  }

  const boxClass = [
    'composer-box',
    focused ? 'is-focused' : '',
    noModel ? 'is-no-model' : '',
    showBanner ? 'is-ctx-warn' : '',
    att.dragging ? 'is-drop' : '',
    att.hasTagItems || queue.length ? 'is-tagged' : '',
  ].filter(Boolean).join(' ');

  return (
    <footer className="center-composer">
      <div className="composer-stack">
        {conversationId ? (
          <StallStrip run={run} lang={lang} onStop={onStop} />
        ) : null}
        {conversationId ? (
          <AgentsStrip cid={conversationId} lang={lang} />
        ) : null}
        <div
          className={boxClass}
          data-testid="next-composer"
          onDragEnter={att.onDragEnter}
          onDragOver={att.onDragOver}
          onDragLeave={att.onDragLeave}
          onDrop={att.onDrop}
        >
          {showBanner ? <ContextBanner lang={lang} context={context} onNewChat={openNewChat} /> : null}
          <div className="composer-body">
            {queue.length || att.hasTagItems ? (
              <div className="composer-tags" data-testid="next-composer-tags">
                {queue.map((item) => (
                  <span key={item.requestId} className="composer-queue" data-testid="next-queue-chip">
                    <span className="composer-queue-label">{t(lang, 'composer_queue_label')}</span>
                    <span className="composer-queue-text">{item.text}</span>
                    <button
                      type="button"
                      className="composer-queue-edit"
                      data-testid="next-queue-edit"
                      onClick={() => {
                        void (async () => {
                          await onWithdrawQueue?.(item.requestId);
                          setDraft(item.text);
                          requestAnimationFrame(resize);
                          area.current?.focus();
                        })();
                      }}
                    >
                      {t(lang, 'composer_queue_edit')}
                    </button>
                    <button
                      type="button"
                      className="composer-queue-x"
                      data-testid="next-queue-dismiss"
                      aria-label={t(lang, 'composer_queue_remove')}
                      onClick={() => { void onWithdrawQueue?.(item.requestId); }}
                    >
                      &times;
                    </button>
                  </span>
                ))}
                <ComposerTags lang={lang} {...att} />
              </div>
            ) : null}
            {at.atOpen ? (
              <AtMentionMenu
                lang={lang}
                treeError={at.treeError}
                treeLoading={at.treeLoading}
                matchedFiles={at.matchedFiles}
                atActiveIndex={at.atActiveIndex}
                onPick={at.pickAtFile}
              />
            ) : null}
            <textarea
              ref={area}
              className="composer-textarea"
              data-testid="next-composer-input"
              rows={2}
              disabled={locked}
              placeholder={placeholder}
              value={draft}
              onFocus={() => {
                setFocused(true);
                at.setAtDismissed(false);
                if (area.current) {
                  at.setCursorPos(area.current.selectionStart ?? draft.length);
                }
              }}
              onBlur={() => {
                setFocused(false);
              }}
              onSelect={(event) => {
                const target = event.target as HTMLTextAreaElement;
                at.setCursorPos(target.selectionStart ?? target.value.length);
              }}
              onClick={(event) => {
                const target = event.target as HTMLTextAreaElement;
                at.setCursorPos(target.selectionStart ?? target.value.length);
              }}
              onKeyUp={(event) => {
                const target = event.target as HTMLTextAreaElement;
                at.setCursorPos(target.selectionStart ?? target.value.length);
              }}
              onChange={(event) => {
                const target = event.target;
                const nextCursor = target.selectionStart ?? target.value.length;
                setDraft(target.value);
                at.setCursorPos(nextCursor);
                at.setAtDismissed(false);
                resize();
              }}
              onKeyDown={onKeyDown}
              onPaste={att.onPaste}
            />
            <div className="composer-bar">
              {noModel ? (
                <div className="composer-no-model" data-testid="next-no-model">
                  <button
                    type="button"
                    className="btn-connect-model"
                    data-testid="next-no-model-connect"
                    onClick={openManage}
                  >
                    {t(lang, 'no_model_connect')}
                  </button>
                  <span className="composer-no-model-hint">{t(lang, 'no_model_hint')}</span>
                </div>
              ) : (
                <div className="composer-chips">
                  {allowAttach ? (
                    <PlusMenu
                      lang={lang}
                      locked={locked}
                      supportsImages={supportsImages}
                      setHint={setHint}
                      addImageFiles={att.addImageFiles}
                      uploadFiles={att.uploadFiles}
                      insertFileAt={at.insertFileAt}
                    />
                  ) : null}
                  {showModelControls && available ? (
                    <ModelChip
                      lang={lang}
                      selected={selected}
                      groups={groups}
                      thinkingLevel={effectiveThinkingLevel}
                      onPick={(option) => { void pickModel(option); }}
                      onPickThinkingLevel={(lvl) => { void pickThinkingLevel(lvl); }}
                      onPickRecent={(option, lvl) => { void pickRecent(option, lvl); }}
                      onManage={openManage}
                      contextWindow={selected?.contextWindow || context.window}
                      onSetContextWindow={(w) => { void setWindow(w); }}
                    />
                  ) : null}
                  <WorkspaceChip
                    lang={lang}
                    selectedId={workspaceId}
                    canSwitch={isDraft}
                    onPick={(id) => {
                      if (id) {
                        writeActiveWorkspace(id);
                        navigate(draftPath(id), { replace: true });
                      } else {
                        writeActiveWorkspace(NO_PROJECT_ID);
                        navigate(newChatPath(), { replace: true });
                      }
                    }}
                    onNew={() => onNewWorkspace?.()}
                    onOpenTerminal={workspaceId
                      ? () => { void openInTerminal(undefined, workspaceId); }
                      : undefined}
                    onCopyPath={copyPath}
                  />
                  <GitChip lang={lang} workspaceId={workspaceId} />
                  {demo ? <DemoModelBadge lang={lang} testId="next-demo-model-chip" /> : null}
                </div>
              )}
              {locked && !noModel && run.lockedReason === 'no_workspace' ? (
                <span className="composer-lock">{t(lang, 'locked_no_workspace')}</span>
              ) : null}
              {hint ? (
                <span className="composer-hint" data-testid="next-composer-hint">{hintText(lang, hint)}</span>
              ) : null}
              {error ? (
                <span className="composer-error" data-testid="next-composer-error">
                  {error}
                  <button type="button" className="composer-retry" data-testid="next-composer-retry" onClick={() => { void retry(); }}>
                    {t(lang, 'btn_retry')}
                  </button>
                </span>
              ) : null}
              <div className="composer-actions">
                {showNewline ? (
                  <span className="composer-newline" data-testid="next-composer-newline">
                    {t(lang, 'composer_newline_hint')}
                  </span>
                ) : null}
                {showModelControls && !noModel ? (
                  <ContextChip
                    lang={lang}
                    context={context}
                    selected={selected}
                  />
                ) : null}
                {stopMode ? (
                  <button
                    type="button"
                    className="btn-send is-ready"
                    data-testid="next-stop"
                    data-state="stop"
                    title={t(lang, 'btn_stop_title')}
                    aria-label={t(lang, 'btn_stop')}
                    disabled={busy}
                    onClick={() => { void onStop(); }}
                  >
                    {STOP_ICON}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`btn-send${canSend ? ' is-ready' : ''}`}
                    data-testid="next-send"
                    title={t(lang, 'send_title')}
                    aria-label={t(lang, 'btn_send')}
                    disabled={locked || busy || !canSend}
                    onClick={() => { void submit(draft.trim(), running ? 'steer' : undefined); }}
                  >
                    {SEND_ICON}
                  </button>
                )}
              </div>
            </div>
          </div>
          {att.dragging ? (
            <div className="composer-drop" data-testid="next-composer-drop">
              {DROP_ICON}
              <span className="composer-drop-title">{t(lang, 'attach_drop')}</span>
              <span className="composer-drop-hint">{t(lang, 'attach_drop_hint')}</span>
            </div>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
