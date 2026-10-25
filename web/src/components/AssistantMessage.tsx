import { useRef, useState } from 'react';
import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { createSendRequest, errorMessage } from './sendRequest';
import { Markdown } from './Markdown';

type Item = components['schemas']['ThreadItemAssistant'];

type Props = {
  item: Item;
  lang: Lang;
  canContinue: boolean;
  onContinue: (requestId: string) => Promise<unknown>;
};

export function AssistantMessage({ item, lang, canContinue, onContinue }: Props) {
  const req = useRef(createSendRequest());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function continueRun() {
    if (busy) return;
    const requestId = req.current.begin('continue');
    setBusy(true);
    setError(null);
    try {
      await onContinue(requestId);
      req.current.succeed();
    } catch (err) {
      setError(errorMessage(err, t(lang, 'send_failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="msg-group msg-side-agent"
      data-testid="next-item-assistant"
      data-role="assistant"
      data-id={item.id}
      data-streaming={item.streaming ? 'true' : 'false'}
    >
      {item.model ? (
        <div className="msg-header">
          <span className="msg-chip" data-testid="next-message-chip">{item.model}</span>
        </div>
      ) : null}
      <div>
        <Markdown
          text={item.text}
          pathRefs={item.pathRefs}
          copyLabel={t(lang, 'copy_code')}
          copiedLabel={t(lang, 'copied')}
        />
        {item.streaming ? <span className="msg-stream-spin" data-testid="next-stream-spin" aria-hidden="true" /> : null}
      </div>
      {item.truncated && canContinue ? (
        <div className="msg-truncated" data-testid="next-truncated">
          <span>{t(lang, 'output_truncated')}</span>
          <button
            type="button"
            className="btn"
            data-testid="next-continue"
            disabled={busy}
            onClick={() => { void continueRun(); }}
          >
            {t(lang, 'btn_continue')}
          </button>
          {error ? <span className="composer-error">{error}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
