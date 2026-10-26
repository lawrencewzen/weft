import { useCallback, useEffect, useState } from 'react';
import type { Lang } from '../data/lang';
import { conversationPath, navigate } from '../data/nav';
import { subagentTimeText } from '../data/subagentTime';
import { useSubagent } from '../data/useSubagent';
import { t } from '../i18n';
import { Composer } from './Composer';
import { DemoModelBadge } from './DemoModelBadge';
import { RightToggle } from './RightToggle';
import { Thread } from './Thread';

type Props = {
  cid: string;
  agentId: string;
  lang: Lang;
  demo?: boolean;
  showOpenLeft?: boolean;
  onOpenLeft?: () => void;
};

export function SubagentPane({
  cid,
  agentId,
  lang,
  demo = false,
  showOpenLeft = false,
  onOpenLeft,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const { subagent, items, toolsById, missing, actions } = useSubagent(cid, agentId);
  const [stickNonce, setStickNonce] = useState(0);
  const bumpStick = useCallback(() => setStickNonce((n) => n + 1), []);

  const back = useCallback(() => {
    navigate(conversationPath(cid));
  }, [cid]);

  if (missing) {
    return (
      <main className="col-center" data-testid="next-subagent-view">
        <header className="next-status">
          <div className="next-status-inner">
            {showOpenLeft ? (
              <button
                type="button"
                className="icon-btn top-left-open"
                data-testid="next-left-open"
                title={t(lang, 'expand_sidebar')}
                onClick={onOpenLeft}
              >
                <span className="ico-panel ico-panel-left" aria-hidden="true" />
              </button>
            ) : null}
            <h1 className="top-title">{t(lang, 'home_title')}</h1>
            <div className="top-right"><RightToggle lang={lang} /></div>
          </div>
        </header>
        <div className="thread-empty">
          <p className="next-error" data-testid="next-error">{t(lang, 'missing_subagent')}</p>
        </div>
      </main>
    );
  }

  if (!subagent) {
    return (
      <main className="col-center" data-testid="next-subagent-view">
        <header className="next-status">
          <div className="next-status-inner">
            {showOpenLeft ? (
              <button
                type="button"
                className="icon-btn top-left-open"
                data-testid="next-left-open"
                title={t(lang, 'expand_sidebar')}
                onClick={onOpenLeft}
              >
                <span className="ico-panel ico-panel-left" aria-hidden="true" />
              </button>
            ) : null}
            <p>{t(lang, 'loading')}</p>
            <div className="top-right"><RightToggle lang={lang} /></div>
          </div>
        </header>
      </main>
    );
  }

  const live = subagent.status === 'running' || subagent.status === 'stuck';
  const statusKey = subagent.status === 'running' ? 'status_running'
    : subagent.status === 'stuck' ? 'status_waiting'
      : subagent.status === 'waiting' ? 'status_waiting'
        : subagent.status === 'failed' ? 'status_failed'
          : subagent.status === 'stopped' ? 'status_stopped'
            : subagent.status === 'done' ? 'status_done'
              : 'status_idle';
  const time = subagentTimeText(subagent, lang, now);
  const run = {
    status: live ? 'running' as const : subagent.status === 'failed' ? 'failed' as const : 'idle' as const,
    startedAt: subagent.startedAt,
    pendingText: subagent.currentAction,
    canSend: live,
    canStop: live,
    lockedReason: null,
    error: null,
  };

  return (
    <main className="col-center" data-testid="next-subagent-view">
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
            <button
              type="button"
              className="subagent-back"
              data-testid="next-subagent-back"
              onClick={back}
            >
              {t(lang, 'subagent_back')}
            </button>
            {live ? <span className="run-spin" aria-hidden="true"><span /></span> : null}
            <span className="top-title">{subagent.title || subagent.name}</span>
            {demo ? <DemoModelBadge lang={lang} testId="next-demo-model-badge" /> : null}
            <span className="status-pill" data-testid="next-run-status" data-status={subagent.status}>
              {t(lang, statusKey)}
            </span>
            {time ? (
              <span className="pending-elapsed" data-testid="next-subagent-time">{time}</span>
            ) : null}
          </div>
          <div className="top-right">
            <RightToggle lang={lang} />
          </div>
        </div>
      </header>
      <Thread
        items={items}
        toolsById={toolsById}
        lang={lang}
        running={live}
        actions={actions}
        stickNonce={stickNonce}
        conversationId={cid}
      />
      <Composer
        lang={lang}
        run={run}
        demo={demo}
        conversationId={cid}
        showModelControls={false}
        onSend={actions.send}
        onStop={actions.stop}
        onSent={bumpStick}
      />
    </main>
  );
}
