import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import {
  isEndedSubagentStatus,
  isLiveSubagentStatus,
  subagentTreeVisual,
} from '../data/subagentTime';
import type { Subagent } from '../data/store';
import { t } from '../i18n';

const STATUS_ICON = (
  <svg
    className="subagent-status-icon"
    viewBox="0 0 12 12"
    aria-hidden="true"
    data-testid="next-subagent-status-icon"
  >
    <circle className="sa-ring" cx="6" cy="6" r="5" fill="none" />
    <circle className="sa-arc" cx="6" cy="6" r="5" fill="none" />
    <path className="sa-check" d="M3.2 6.2l2 2 3.6-4" fill="none" />
    <rect className="sa-stop" x="4.35" y="4.35" width="3.3" height="3.3" rx="0.45" />
    <path className="sa-fail" d="M4 4l4 4M8 4l-4 4" fill="none" />
  </svg>
);

export function SubagentChip({
  convId,
  live,
  total,
  collapsed,
  agents = [],
  lang,
  onToggle,
}: {
  convId: string;
  live: number;
  total: number;
  collapsed: boolean;
  agents?: Subagent[];
  lang: Lang;
  onToggle: (convId: string) => void;
}) {
  if (total <= 0) return null;
  const label = live > 0 ? `${live}/${total}` : String(total);
  const open = !collapsed;
  const loaderTitle = live > 0
    ? t(lang, 'subagent_live_title', { live, total })
    : t(lang, 'subagent_ended_title', { total });
  const toggleTitle = open
    ? t(lang, 'subagent_collapse')
    : t(lang, 'subagent_expand_n', { count: total });

  const count = agents.length > 0 ? agents.length : total;
  const orbitDots = Array.from({ length: count }, (_, k) => {
    const a = agents[k];
    const visual = a ? subagentTreeVisual(a.status) : (k < live ? 'running' : 'done');
    const on = visual === 'running' || visual === 'stuck';
    const color = visual === 'running' ? 'var(--sa-run)' : visual === 'stuck' ? 'var(--sa-stuck)' : 'var(--sa-check)';
    const op = on ? 1 : 0.55;
    const play = on ? 'running' : 'paused';
    const dur = `${1.6 + k * 0.45}s`;
    const delay = `${-k * 0.37}s`;
    const top = k % 2 ? '1px' : '0px';
    return { color, op, play, dur, delay, top };
  });

  return (
    <span
      className={`subagent-chip-cluster${live > 0 ? ' is-live' : ''}`}
      data-testid="next-subagent-chip"
      data-conv-id={convId}
      aria-expanded={open ? 'true' : 'false'}
      onClick={(ev) => ev.stopPropagation()}
    >
      <span
        className="subagent-orbit-wrap"
        data-testid="next-subagent-orbit"
        title={loaderTitle}
      >
        <span className="subagent-orbit-stage" aria-hidden="true">
          <span
            className="subagent-orbit-core"
            style={{ background: live > 0 ? 'var(--sa-run)' : 'var(--sa-check)' }}
          />
          {orbitDots.map((d, k) => (
            <span
              key={k}
              className="subagent-orbit-ring"
              style={{
                animationDuration: d.dur,
                animationDelay: d.delay,
                animationPlayState: d.play as 'running' | 'paused',
              }}
            >
              <span
                className="subagent-orbit-dot"
                style={{
                  top: d.top,
                  background: d.color,
                  opacity: d.op,
                }}
              />
            </span>
          ))}
        </span>
        <span
          className="subagent-chip-count"
          style={{ color: live > 0 ? 'var(--run-ink)' : 'var(--faint)' }}
        >
          {label}
        </span>
      </span>
      <button
        type="button"
        className="subagent-toggle-btn"
        data-testid="next-subagent-toggle"
        data-conv-id={convId}
        title={toggleTitle}
        aria-label={toggleTitle}
        aria-expanded={open ? 'true' : 'false'}
        onClick={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          onToggle(convId);
        }}
      >
        <svg
          className="subagent-toggle-icon"
          viewBox="0 0 12 12"
          aria-hidden="true"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        >
          <path
            d="M4.5 3l3 3-3 3"
            fill="none"
            stroke="var(--mute)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </span>
  );
}

function useEntered(ids: string[]): Set<string> {
  const seen = useRef(new Set<string>());
  const [entered, setEntered] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const newcomers = ids.filter((id) => !seen.current.has(id));
    for (const id of ids) seen.current.add(id);
    if (!newcomers.length) return;
    const timer = window.setTimeout(() => {
      setEntered((prev) => {
        const next = new Set(prev);
        for (const id of newcomers) next.add(id);
        return next;
      });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [ids.join('\0')]);
  return entered;
}

function useJustEnded(agents: Subagent[]): Set<string> {
  const prev = useRef(new Map<string, string>());
  const [ended, setEnded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const nextEnded = new Set<string>();
    for (const agent of agents) {
      const last = prev.current.get(agent.id);
      if (last && isLiveSubagentStatus(last) && isEndedSubagentStatus(agent.status)) {
        nextEnded.add(agent.id);
      }
      prev.current.set(agent.id, agent.status);
    }
    if (!nextEnded.size) return;
    setEnded((prevSet) => {
      const merged = new Set(prevSet);
      for (const id of nextEnded) merged.add(id);
      return merged;
    });
    const timer = window.setTimeout(() => {
      setEnded((prevSet) => {
        const next = new Set(prevSet);
        for (const id of nextEnded) next.delete(id);
        return next;
      });
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [agents.map((agent) => `${agent.id}:${agent.status}`).join('|')]);
  return ended;
}

export function SubagentTree({
  convId,
  agents,
  collapsed,
  loading,
  activeAgentId,
  lang,
  onOpen,
  onMenu,
}: {
  convId: string;
  agents: Subagent[];
  collapsed: boolean;
  loading?: boolean;
  activeAgentId: string | null;
  lang: Lang;
  onOpen: (cid: string, agentId: string) => void;
  onMenu: (ev: MouseEvent, agent: Subagent) => void;
}) {
  const ids = agents.map((agent) => agent.id);
  const entered = useEntered(ids);
  const justEnded = useJustEnded(agents);
  if (collapsed && !loading && !agents.length) return null;
  return (
    <div
      className={`subagent-tree-wrap${collapsed ? '' : ' is-open'}`}
      data-testid="next-subagent-tree"
      data-conv-id={convId}
    >
      <div className="subagent-tree-clip">
        <div className="subagent-tree tkids">
          {loading && !agents.length ? (
            <div className="subagent-tree-loading">{t(lang, 'loading')}</div>
          ) : (
            <>
              {agents.length ? (
                <span className="subagent-tree-stem" data-testid="next-subagent-tree-stem" aria-hidden="true" />
              ) : null}
              {agents.map((agent, index) => {
            const last = index === agents.length - 1;
            const visual = subagentTreeVisual(agent.status);
            const entering = !entered.has(agent.id);
            const ended = justEnded.has(agent.id);
            const active = activeAgentId === agent.id;
            const fx = [
              entering ? 'is-entering' : '',
              ended ? 'is-just-ended' : '',
            ].filter(Boolean).join(' ');
            const isDone = visual === 'done';
            return (
              <div
                key={agent.id}
                className={[
                  'subagent-tree-row-shell',
                  last ? 'is-last' : '',
                  fx,
                ].filter(Boolean).join(' ')}
                data-testid="next-subagent-tree-shell"
              >
                <div className="subagent-tree-row-grow">
                  <div className="subagent-tree-row-shell-inner">
                    <div
                      className={[
                        'subagent-tree-row',
                        'tkid',
                        active ? 'is-active on' : '',
                        isDone ? 'done' : '',
                        visual === 'stuck' ? 'is-stuck' : '',
                        ended ? 'is-just-ended' : '',
                      ].filter(Boolean).join(' ')}
                      data-testid="next-subagent-row"
                      data-agent-id={agent.id}
                      data-conv-id={convId}
                      data-status={agent.status}
                      data-visual={visual}
                      title={agent.title || agent.name}
                      onClick={() => onOpen(convId, agent.id)}
                      onContextMenu={(ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        onMenu(ev, agent);
                      }}
                    >
                      <div className="subagent-tree-line trow">
                        {STATUS_ICON}
                        <span className="subagent-tree-summary tt" data-testid="next-subagent-summary">
                          {agent.title || agent.name}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
                <span className="subagent-tree-v" data-testid="next-subagent-tree-v" aria-hidden="true" />
                <span className="subagent-tree-h" data-testid="next-subagent-tree-h" aria-hidden="true" />
              </div>
            );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
