import { useEffect, useState } from 'react';
import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { formatElapsed, t } from '../i18n';
import { DemoModelBadge } from './DemoModelBadge';
import { RightToggle } from './RightToggle';

type ConversationView = components['schemas']['ConversationView'];

type Props = {
  conversation: ConversationView;
  lang: Lang;
  demo?: boolean;
  hidePending?: boolean;
  showOpenLeft?: boolean;
  onOpenLeft?: () => void;
};

export function StatusBar({
  conversation,
  lang,
  demo = false,
  hidePending = false,
  showOpenLeft = false,
  onOpenLeft,
}: Props) {
  const run = conversation.run;
  const running = run.status === 'running';
  const failed = run.status === 'failed';
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (running) setSeenAt((prev) => prev ?? Date.now());
    else setSeenAt(null);
  }, [running, conversation.id]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const origin = run.startedAt ?? seenAt;
  const elapsed = running && origin != null ? formatElapsed(now - origin) : null;
  const itemCount = Array.isArray(conversation.itemIds) ? conversation.itemIds.length : 0;
  const statusKey = run.status === 'running' ? 'status_running'
    : run.status === 'stopped' ? 'status_stopped'
      : run.status === 'failed' ? 'status_failed'
        : run.status === 'waiting' ? 'status_waiting'
          : itemCount > 0 ? 'status_done' : 'status_idle';

  return (
    <header className="next-status" data-testid="next-status">
      <div className="next-status-inner">
        <div className="pending-line">
          {showOpenLeft ? (
            <button
              type="button"
              className="icon-btn top-left-open"
              data-testid="next-left-open"
              title={t(lang, 'expand_sidebar')}
              aria-label={t(lang, 'expand_sidebar')}
              onClick={onOpenLeft}
            >
              <span className="ico-panel ico-panel-left" aria-hidden="true" />
            </button>
          ) : null}
          {running && !hidePending ? <span className="run-spin" aria-hidden="true"><span /></span> : null}
          <span className="top-title">{conversation.title}</span>
          {demo ? <DemoModelBadge lang={lang} testId="next-demo-model-badge" /> : null}
          <span className="status-pill" data-testid="next-run-status" data-status={run.status}>
            {t(lang, statusKey)}
          </span>
          {running && !hidePending && run.pendingText ? (
            <span className="pending-status" data-testid="next-pending">{run.pendingText}</span>
          ) : null}
          {elapsed && !hidePending ? (
            <span className="pending-elapsed" data-testid="next-elapsed">{elapsed}</span>
          ) : null}
        </div>
        <div className="top-right">
          <RightToggle lang={lang} />
        </div>
      </div>
      {failed && run.error?.message ? (
        <div className="next-status-inner">
          <div className="llm-error" data-testid="next-run-error" role="alert">
            {run.error.code ? <div className="llm-error-code">{run.error.code}</div> : null}
            <div>{run.error.message}</div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
