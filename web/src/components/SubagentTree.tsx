import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import {
  isEndedSubagentStatus,
  isLiveSubagentStatus,
  subagentActionText,
  subagentTreeTimeText,
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

const CHIP_ICON = (
  <svg
    className="subagent-chip-icon"
    viewBox="0 0 16 16"
    width="11"
    height="11"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <circle cx="4" cy="3.5" r="1.6" />
    <circle cx="4" cy="12.5" r="1.6" />
    <circle cx="12" cy="7" r="1.6" />
    <path d="M4 5v6M4 8.5c0-1.5 2-1.5 6.4-1.5" />
  </svg>
);

export function SubagentChip({
  convId,
  live,
  total,
  collapsed,
  lang,
  onToggle,
}: {
  convId: string;
  live: number;
  total: number;
  collapsed: boolean;
  lang: Lang;
  onToggle: (convId: string) => void;
}) {
  if (total <= 0) return null;
  const label = live > 0 ? `${live}/${total}` : String(total);
  return (
    <button
      type="button"
      className={`subagent-chip${live ? ' is-live' : ''}`}
      data-testid="next-subagent-chip"
      data-conv-id={convId}
      aria-expanded={collapsed ? 'false' : 'true'}
      aria-label={t(lang, collapsed ? 'subagent_tree_expand' : 'subagent_tree_collapse')}
      onClick={(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onToggle(convId);
      }}
    >
      {CHIP_ICON}
      <span className="subagent-chip-count">{label}</span>
    </button>
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
  now,
  onOpen,
  onMenu,
}: {
  convId: string;
  agents: Subagent[];
  collapsed: boolean;
  loading?: boolean;
  activeAgentId: string | null;
  lang: Lang;
  now: number;
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
        <div className="subagent-tree">
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
            const time = subagentTreeTimeText(agent, lang, now);
            const action = subagentActionText(agent);
            const entering = !entered.has(agent.id);
            const ended = justEnded.has(agent.id);
            const active = activeAgentId === agent.id;
            const fx = [
              entering ? 'is-entering' : '',
              ended ? 'is-just-ended' : '',
            ].filter(Boolean).join(' ');
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
                        active ? 'is-active' : '',
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
                      <div className="subagent-tree-line">
                        {STATUS_ICON}
                        <span className="subagent-tree-summary" data-testid="next-subagent-summary">
                          {agent.title || agent.name}
                        </span>
                        <span
                          className={`subagent-tree-time${agent.status === 'stuck' ? ' is-idle' : ''}`}
                          data-testid="next-subagent-time"
                        >
                          {time}
                        </span>
                      </div>
                      <div className={`subagent-tree-action-slot${action ? ' is-open' : ''}`}>
                        <div className="subagent-tree-action-clip">
                          {action ? (
                            <div className="subagent-tree-action" data-testid="next-subagent-action">
                              {action}
                            </div>
                          ) : null}
                        </div>
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
