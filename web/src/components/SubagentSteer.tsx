import { useState, type KeyboardEvent } from 'react';
import type { Lang } from '../data/lang';
import { t } from '../i18n';

type Props = {
  lang: Lang;
  name: string;
  live: boolean;
  onSend: (text: string) => Promise<unknown>;
  onStop: () => Promise<unknown>;
  onSent?: () => void;
};

const SEND_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

export function SubagentSteer({
  lang,
  name,
  live,
  onSend,
  onStop,
  onSent,
}: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasText = Boolean(draft.trim()) && live && !busy;

  async function submit() {
    const text = draft.trim();
    if (!text || !live || busy) return;
    setBusy(true);
    setError(null);
    setDraft('');
    try {
      await onSend(text);
      onSent?.();
    } catch (err) {
      setDraft((current) => (current ? current : text));
      setError(err instanceof Error ? err.message : t(lang, 'send_failed'));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter') return;
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void submit();
  }

  if (!live) return null;

  return (
    <div className="sa-steer">
      <div className="sa-steer-box">
        <label className="sa-steer-field">
          <span className="sr-only">{t(lang, 'subagent_steer_label')}</span>
          <textarea
            className="sa-steer-input"
            data-testid="next-subagent-input"
            rows={1}
            placeholder={t(lang, 'subagent_steer_placeholder', { name })}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
        <div className="sa-steer-bar">
          <span className="sa-steer-hint">{t(lang, 'subagent_steer_hint')}</span>
          <button
            type="button"
            className="sa-steer-stop"
            data-testid="next-subagent-stop"
            title={t(lang, 'subagent_stop_title')}
            disabled={busy}
            onClick={() => { void onStop(); }}
          >
            {t(lang, 'subagent_steer_stop')}
          </button>
          <button
            type="button"
            className={`sa-steer-send${hasText ? ' is-ready' : ''}`}
            data-testid="next-subagent-send"
            title={t(lang, 'subagent_steer_send_title')}
            aria-label={t(lang, 'btn_send')}
            disabled={!hasText}
            onClick={() => { void submit(); }}
          >
            {SEND_ICON}
          </button>
        </div>
        {error ? (
          <span className="sa-steer-error" data-testid="next-composer-error">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
