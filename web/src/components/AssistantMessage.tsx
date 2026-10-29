import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { BrandIcon } from './BrandIcon';
import { createSendRequest, errorMessage } from './sendRequest';
import { Markdown } from './Markdown';

type Item = components['schemas']['ThreadItemAssistant'];

export function useStreamingThrottle(text: string, streaming: boolean, intervalMs = 100): string {
  const [throttledText, setThrottledText] = useState(text);
  const lastUpdateRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestTextRef = useRef(text);
  latestTextRef.current = text;

  useEffect(() => {
    if (!streaming) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setThrottledText(text);
      return;
    }

    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;

    if (elapsed >= intervalMs) {
      lastUpdateRef.current = now;
      setThrottledText(text);
      return;
    }

    if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastUpdateRef.current = Date.now();
        setThrottledText(latestTextRef.current);
      }, intervalMs - elapsed);
    }
  }, [text, streaming, intervalMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return streaming ? throttledText : text;
}

type Props = {
  item: Item;
  lang: Lang;
  canContinue: boolean;
  onContinue: (requestId: string) => Promise<unknown>;
  attribution?: { brand: string | null; displayName: string } | null;
};

export function AssistantMessage({ item, lang, canContinue, onContinue, attribution = null }: Props) {
  const req = useRef(createSendRequest());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markdownText = useStreamingThrottle(item.text, Boolean(item.streaming), 100);

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
          <span className="msg-chip" data-testid="next-message-chip">
            <BrandIcon brand={attribution?.brand} size={14} />
            <span>{attribution?.displayName || item.model}</span>
          </span>
        </div>
      ) : null}
      <div>
        <Markdown
          text={markdownText}
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
