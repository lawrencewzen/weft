import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lang } from '../data/lang';
import { conversationPath, navigate, subagentPath } from '../data/nav';
import {
  subagentDotLive,
  subagentTimeText,
} from '../data/subagentTime';
import { useSubagent } from '../data/useSubagent';
import type { Subagent } from '../data/store';
import { t } from '../i18n';
import { SubagentDot } from './SubagentOverview';
import { SubagentSteer } from './SubagentSteer';
import { Thread } from './Thread';

type Props = {
  cid: string;
  agentId: string;
  agents: Subagent[];
  lang: Lang;
};

function statusKey(status: Subagent['status']): 'status_running' | 'status_waiting' | 'status_failed' | 'status_stopped' | 'status_done' | 'status_idle' {
  if (status === 'running') return 'status_running';
  if (status === 'stuck' || status === 'waiting') return 'status_waiting';
  if (status === 'failed') return 'status_failed';
  if (status === 'stopped') return 'status_stopped';
  if (status === 'done') return 'status_done';
  return 'status_idle';
}

export function SubagentPane({
  cid,
  agentId,
  agents,
  lang,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const { subagent, items, toolsById, missing, actions } = useSubagent(cid, agentId);
  const [stickNonce, setStickNonce] = useState(0);
  const bumpStick = useCallback(() => setStickNonce((n) => n + 1), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMenuOpen(false);
  }, [agentId]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      const node = menuRef.current;
      if (node && event.target instanceof Node && node.contains(event.target)) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const back = useCallback(() => {
    navigate(conversationPath(cid));
  }, [cid]);

  const pick = useCallback((id: string) => {
    setMenuOpen(false);
    if (id === agentId) return;
    navigate(subagentPath(cid, id));
  }, [agentId, cid]);

  if (missing) {
    return (
      <div className="sa-detail" data-testid="next-subagent-view">
        <nav className="sa-crumb" aria-label={t(lang, 'tab_subagents')}>
          <button
            type="button"
            className="sa-crumb-back"
            data-testid="next-subagent-back"
            onClick={back}
          >
            {t(lang, 'tab_subagents')}
          </button>
        </nav>
        <div className="sa-detail-empty">
          <p className="next-error" data-testid="next-error">{t(lang, 'missing_subagent')}</p>
        </div>
      </div>
    );
  }

  if (!subagent) {
    return (
      <div className="sa-detail" data-testid="next-subagent-view">
        <p className="sa-detail-empty">{t(lang, 'loading')}</p>
      </div>
    );
  }

  const live = subagent.status === 'running' || subagent.status === 'stuck';
  const title = subagent.title || subagent.name;
  const time = subagentTimeText(subagent, lang, now);
  const list = agents.length ? agents : [subagent];

  return (
    <div className="sa-detail" data-testid="next-subagent-view">
      <div className="sa-detail-head">
        <nav
          className="sa-crumb"
          aria-label={t(lang, 'tab_subagents')}
          ref={menuRef}
        >
          <button
            type="button"
            className="sa-crumb-back"
            data-testid="next-subagent-back"
            onClick={back}
          >
            {t(lang, 'tab_subagents')}
          </button>
          <span className="sa-crumb-sep" aria-hidden="true">›</span>
          <button
            type="button"
            className="sa-crumb-current"
            data-testid="next-subagent-switch"
            aria-label={t(lang, 'subagent_switch')}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="sa-crumb-sum">{title}</span>
            <span className="sa-crumb-caret" aria-hidden="true">▾</span>
          </button>
          {menuOpen ? (
            <div className="sa-switch-menu" data-testid="next-subagent-menu" role="listbox">
              {list.map((agent) => {
                const selected = agent.id === agentId;
                const sum = agent.title || agent.name;
                const meta = subagentTimeText(agent, lang, now);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`sa-switch-item${selected ? ' is-selected' : ''}`}
                    data-testid="next-subagent-menu-item"
                    data-agent-id={agent.id}
                    role="option"
                    aria-selected={selected}
                    onClick={() => pick(agent.id)}
                  >
                    <SubagentDot status={agent.status} />
                    <span className="sa-switch-sum">{sum}</span>
                    {meta ? <span className="sa-switch-meta">{meta}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </nav>
        <div className="sa-detail-title">
          <span className="sa-badge">{t(lang, 'subagent_badge')}</span>
          <span className="sa-detail-name">{subagent.name || title}</span>
          <span
            className={`sa-detail-status${subagentDotLive(subagent.status) ? ' is-live' : ''}`}
            data-testid="next-subagent-status"
            data-status={subagent.status}
          >
            {t(lang, statusKey(subagent.status))}
          </span>
          {time ? (
            <span className="sa-detail-time" data-testid="next-subagent-time">{time}</span>
          ) : null}
        </div>
      </div>
      <Thread
        className="sa-detail-thread"
        testId="next-subagent-thread"
        items={items}
        toolsById={toolsById}
        lang={lang}
        running={live}
        actions={actions}
        stickNonce={stickNonce}
        conversationId={cid}
      />
      <SubagentSteer
        lang={lang}
        name={subagent.name || title}
        live={live}
        onSend={actions.send}
        onStop={actions.stop}
        onSent={bumpStick}
      />
    </div>
  );
}
