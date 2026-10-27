import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { patchConversationModel, putModelContextWindow } from '../data/api';
import {
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
import { draftPath, navigate, openSettings } from '../data/nav';
import { useProviders } from '../data/useProviders';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { writeActiveWorkspace } from '../data/layout';
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
  model?: ConversationModel | null;
  context?: ContextUsage;
  isDraft?: boolean;
  draftModel?: ResolvedModel | null;
  onDraftModel?: (model: ResolvedModel) => void;
  showModelControls?: boolean;
  onNewWorkspace?: () => void;
  onSend: (text: string, requestId: string) => Promise<unknown>;
  onStop: () => Promise<unknown>;
  onSent?: () => void;
};

const FALLBACK_CONTEXT: ContextUsage = { used: 0, window: 128000, percent: 0, level: 'ok' };

/** T51-6 接图片附件。这一单先把按钮和布局放上，选文件暂不处理。 */
export const COMPOSER_SHOW_ATTACH = true;

const TEXTAREA_MIN = 44;
const TEXTAREA_MAX = 200;

const PLUS_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
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

export function Composer({
  lang,
  run,
  demo = false,
  conversationId = null,
  workspaceId = null,
  model = null,
  context = FALLBACK_CONTEXT,
  isDraft = false,
  draftModel = null,
  onDraftModel,
  showModelControls = true,
  onNewWorkspace,
  onSend,
  onStop,
  onSent,
}: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const req = useRef(createSendRequest());
  const area = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { providers, defaultModel, ready: providersReady } = useProviders();
  const groups = useMemo(() => groupComposerModels(providers, defaultModel), [providers, defaultModel]);
  const available = hasAvailableModels(providers);
  const selected = useMemo(() => resolveComposerSelection({
    providers,
    conversationModel: model,
    defaultModel,
    draft: draftModel,
    isDraft,
  }), [providers, model, defaultModel, draftModel, isDraft]);
  const noModel = showModelControls && !demo && providersReady && !available;
  const noWorkspace = isDraft && !workspaceId;
  const locked = !run.canSend || noModel || noWorkspace;
  const hasText = Boolean(draft.trim()) && !locked;
  const stopMode = run.canStop && !draft.trim();
  const showBanner = showModelControls && contextIsWarn(context.level);
  const showAttach = COMPOSER_SHOW_ATTACH && !noModel;
  const showNewline = Boolean(draft) && !stopMode;
  const placeholder = noModel
    ? t(lang, 'composer_placeholder_no_model')
    : run.status === 'running'
      ? t(lang, 'composer_placeholder_running')
      : t(lang, 'composer_placeholder');

  function resize() {
    const el = area.current;
    if (!el) return;
    el.style.height = `${TEXTAREA_MIN}px`;
    el.style.height = `${Math.min(TEXTAREA_MAX, Math.max(TEXTAREA_MIN, el.scrollHeight))}px`;
  }

  useEffect(() => {
    resize();
  }, [draft]);

  async function submit(text = draft.trim()) {
    if (!text || locked || busy) return;
    const requestId = req.current.begin(text);
    setBusy(true);
    setError(null);
    // 先把消息和输入框清掉：气泡已经上屏，不等服务端
    setDraft('');
    requestAnimationFrame(resize);
    try {
      await onSend(text, requestId);
      req.current.succeed();
      onSent?.();
    } catch (err) {
      // 发失败才把文字塞回去，requestId 不重置，重试仍幂等
      setDraft((current) => (current ? current : text));
      setError(errorMessage(err, t(lang, 'send_failed')));
      requestAnimationFrame(resize);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    const text = draft.trim();
    if (!text) return;
    await submit(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter') return;
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void submit();
  }

  const pickModel = useCallback(async (option: ComposerModelOption) => {
    const next: ResolvedModel = { providerId: option.providerId, modelId: option.modelId };
    if (isDraft || !conversationId) {
      onDraftModel?.(next);
      return;
    }
    try {
      await patchConversationModel(conversationId, next);
    } catch (err) {
      setError(errorMessage(err, t(lang, 'send_failed')));
    }
  }, [conversationId, isDraft, lang, onDraftModel]);

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

  function openAttach() {
    fileRef.current?.click();
  }

  const boxClass = [
    'composer-box',
    focused ? 'is-focused' : '',
    noModel ? 'is-no-model' : '',
    showBanner ? 'is-ctx-warn' : '',
  ].filter(Boolean).join(' ');

  return (
    <footer className="center-composer">
      <div className="composer-stack">
        <div className={boxClass} data-testid="next-composer">
          {showModelControls ? <ContextBanner lang={lang} context={context} onNewChat={openNewChat} /> : null}
          <div className="composer-body">
            <textarea
              ref={area}
              className="composer-textarea"
              data-testid="next-composer-input"
              rows={2}
              disabled={locked}
              placeholder={placeholder}
              value={draft}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(event) => {
                setDraft(event.target.value);
                resize();
              }}
              onKeyDown={onKeyDown}
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
                  {showAttach ? (
                    <>
                      <button
                        type="button"
                        className="composer-attach"
                        data-testid="next-composer-attach"
                        aria-label={t(lang, 'composer_attach')}
                        title={t(lang, 'composer_attach')}
                        onClick={openAttach}
                      >
                        {PLUS_ICON}
                      </button>
                      <span className="composer-divider" aria-hidden="true" />
                    </>
                  ) : null}
                  {showModelControls && available ? (
                    <ModelChip
                      lang={lang}
                      selected={selected}
                      groups={groups}
                      onPick={(option) => { void pickModel(option); }}
                      onManage={openManage}
                    />
                  ) : null}
                  <WorkspaceChip
                    lang={lang}
                    selectedId={workspaceId}
                    canSwitch={isDraft}
                    onPick={(id) => {
                      writeActiveWorkspace(id);
                      navigate(draftPath(id), { replace: true });
                    }}
                    onNew={() => onNewWorkspace?.()}
                  />
                  {demo ? <DemoModelBadge lang={lang} testId="next-demo-model-chip" /> : null}
                </div>
              )}
              {noWorkspace ? (
                <span className="composer-lock" data-testid="next-composer-need-ws">{t(lang, 'composer_need_workspace')}</span>
              ) : locked && !noModel && run.lockedReason === 'no_workspace' ? (
                <span className="composer-lock">{t(lang, 'locked_no_workspace')}</span>
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
                    onSetWindow={setWindow}
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
                    className={`btn-send${hasText ? ' is-ready' : ''}`}
                    data-testid="next-send"
                    title={noWorkspace ? t(lang, 'composer_need_workspace') : t(lang, 'send_title')}
                    aria-label={t(lang, 'btn_send')}
                    disabled={locked || busy || !hasText}
                    onClick={() => { void submit(); }}
                  >
                    {SEND_ICON}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {showAttach ? (
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          tabIndex={-1}
          data-testid="next-composer-attach-input"
          onChange={(event) => {
            event.target.value = '';
          }}
        />
      ) : null}
    </footer>
  );
}
