import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { patchConversationModel, putModelContextWindow } from '../data/api';
import {
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
import { ContextBanner, ContextChip } from './ContextChip';
import { DemoModelBadge } from './DemoModelBadge';
import { ModelChip } from './ModelChip';
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
  onSend: (text: string, requestId: string) => Promise<unknown>;
  onStop: () => Promise<unknown>;
  onSent?: () => void;
};

const FALLBACK_CONTEXT: ContextUsage = { used: 0, window: 128000, percent: 0, level: 'ok' };

const SEND_ICON = (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <path d="M7 11.5V2.5M3 6.5l4-4 4 4" />
  </svg>
);
const STOP_ICON = (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <rect x="4" y="4" width="6" height="6" rx="1" />
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
  onSend,
  onStop,
  onSent,
}: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(createSendRequest());
  const area = useRef<HTMLTextAreaElement>(null);
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
  const locked = !run.canSend || noModel;
  const hasText = Boolean(draft.trim()) && !locked;
  const stopMode = run.canStop && !draft.trim();
  const placeholder = noModel
    ? t(lang, 'composer_placeholder_no_model')
    : run.status === 'running'
      ? t(lang, 'composer_placeholder_running')
      : t(lang, 'composer_placeholder');

  function resize() {
    const el = area.current;
    if (!el) return;
    el.style.height = '44px';
    el.style.height = `${Math.min(200, Math.max(44, el.scrollHeight))}px`;
  }

  async function submit(text = draft.trim()) {
    if (!text || locked || busy) return;
    const requestId = req.current.begin(text);
    setBusy(true);
    setError(null);
    try {
      await onSend(text, requestId);
      req.current.succeed();
      setDraft('');
      onSent?.();
      requestAnimationFrame(resize);
    } catch (err) {
      setError(errorMessage(err, t(lang, 'send_failed')));
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

  return (
    <footer className="center-composer">
      <div className="composer-stack">
        <div className={`composer-box${noModel ? ' is-no-model' : ''}`}>
          {showModelControls ? <ContextBanner lang={lang} context={context} onNewChat={openNewChat} /> : null}
          <textarea
            ref={area}
            className="composer-textarea"
            data-testid="next-composer-input"
            rows={2}
            disabled={locked}
            placeholder={placeholder}
            value={draft}
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
                {showModelControls && available ? (
                  <ModelChip
                    lang={lang}
                    selected={selected}
                    groups={groups}
                    onPick={(option) => { void pickModel(option); }}
                    onManage={openManage}
                  />
                ) : null}
                {demo ? <DemoModelBadge lang={lang} testId="next-demo-model-chip" /> : null}
              </div>
            )}
            {locked && !noModel && run.lockedReason === 'no_workspace' ? (
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
                  title={t(lang, 'send_title')}
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
    </footer>
  );
}
