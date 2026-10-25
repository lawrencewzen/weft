import { useRef, useState, type KeyboardEvent } from 'react';
import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { createSendRequest, errorMessage } from './sendRequest';

type RunState = components['schemas']['RunState'];

type Props = {
  lang: Lang;
  run: RunState;
  onSend: (text: string, requestId: string) => Promise<unknown>;
  onStop: () => Promise<unknown>;
  onSent?: () => void;
};

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

export function Composer({ lang, run, onSend, onStop, onSent }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(createSendRequest());
  const area = useRef<HTMLTextAreaElement>(null);
  const locked = !run.canSend;
  const hasText = Boolean(draft.trim()) && !locked;
  const stopMode = run.canStop && !draft.trim();
  const placeholder = run.status === 'running'
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

  return (
    <footer className="center-composer">
      <div className="composer-stack">
        <div className="composer-box">
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
            {locked && run.lockedReason === 'no_workspace' ? (
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
