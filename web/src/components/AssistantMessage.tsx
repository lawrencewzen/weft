import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { BrandIcon } from './BrandIcon';
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

const FORK_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
    <path d="M12 12v3" />
  </svg>
);

type Props = {
  item: Item;
  lang: Lang;
  running?: boolean;
  attribution?: { brand: string | null; displayName: string } | null;
  onFork?: (entryId: string) => void;
};

export function AssistantMessage({ item, lang, running = false, attribution = null, onFork }: Props) {
  const markdownText = useStreamingThrottle(item.text, Boolean(item.streaming), 100);
  const canFork = Boolean(item.entryId) && !item.streaming;

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
      {item.truncated && !running ? (
        <div className="msg-truncated" data-testid="next-truncated">
          <span>{t(lang, 'output_truncated')}</span>
        </div>
      ) : null}
      {canFork ? (
        <div className="msg-fork-wrap msg-fork-agent">
          <button
            type="button"
            className="msg-fork-btn"
            data-testid="next-msg-fork"
            title={t(lang, 'fork_from_here')}
            aria-label={t(lang, 'fork_from_here')}
            onClick={() => onFork?.(item.entryId!)}
          >
            {FORK_ICON}
          </button>
        </div>
      ) : null}
    </div>
  );
}
