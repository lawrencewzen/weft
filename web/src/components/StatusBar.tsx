import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { createSendRequest, errorMessage } from './sendRequest';

type ConversationView = components['schemas']['ConversationView'];
type Workspace = components['schemas']['Workspace'];

type Props = {
  conversation: ConversationView;
  lang: Lang;
  demo?: boolean;
  hidePending?: boolean;
  workspace?: Workspace | null;
  onContinue?: (requestId?: string) => Promise<unknown>;
};

export function StatusBar({
  conversation,
  lang,
  onContinue,
}: Props) {
  const run = conversation.run;
  const failed = run.status === 'failed';
  const isNew = !conversation.id || conversation.title === t(lang, 'new_conversation');
  const req = useRef(createSendRequest());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setActionError(null);
  }, [conversation.id, run.status]);

  async function handleContinue() {
    if (busy || !onContinue) return;
    const requestId = req.current.begin('continue');
    setBusy(true);
    setActionError(null);
    try {
      await onContinue(requestId);
      req.current.succeed();
    } catch (err) {
      setActionError(errorMessage(err, t(lang, 'send_failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="next-status" data-testid="next-status">
      <div className="next-status-inner">
        <div className="top-heading">
          <span
            className="top-title"
            style={isNew ? { color: 'var(--faint)' } : undefined}
          >
            {isNew ? t(lang, 'new_conversation') : conversation.title}
          </span>
        </div>
        <div className="top-right" aria-hidden="true" />
      </div>
      {failed && run.error?.message ? (
        <div className="next-status-inner">
          <div
            className="llm-error"
            data-testid="next-run-error"
            role="alert"
            title={run.error.code || undefined}
          >
            <div className="llm-error-text">
              <span>{run.error.message}</span>
              {actionError ? <span className="llm-error-inline-err">{actionError}</span> : null}
            </div>
            {run.error.canContinue ? (
              <button
                type="button"
                className="btn llm-error-continue"
                data-testid="next-run-continue"
                disabled={busy}
                onClick={() => { void handleContinue(); }}
              >
                {t(lang, 'btn_continue')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}
