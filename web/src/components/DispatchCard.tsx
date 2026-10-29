import { useCallback, useState, type MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import { copyText } from '../data/copyText';
import { navigate, subagentPath } from '../data/nav';
import { useRightPane } from '../data/rightPaneContext';
import { useSession } from '../data/session';
import type { Subagent } from '../data/store';
import { createSubagentMenuItems } from '../data/subagentMenu';
import { subagentActionText } from '../data/subagentTime';
import { t } from '../i18n';
import { CtxMenu, type CtxMenuItem } from './CtxMenu';
import { StatusIcon, statusIconFor } from './StatusIcon';

type Props = {
  cid: string;
  agents: Subagent[];
  lang: Lang;
};

function statusLabel(status: Subagent['status'], lang: Lang): string {
  switch (status) {
    case 'running':
      return t(lang, 'status_running');
    case 'stuck':
      return t(lang, 'status_stuck');
    case 'waiting':
      return t(lang, 'status_queued');
    case 'done':
      return t(lang, 'status_done');
    case 'stopped':
      return t(lang, 'status_stopped');
    case 'failed':
      return t(lang, 'status_failed');
    default:
      return t(lang, 'status_running');
  }
}

export function DispatchCard({ cid, agents, lang }: Props) {
  const { store } = useSession();
  const { open, tab, selectedSubagentId, setTab, onToast } = useRightPane();
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: CtxMenuItem[] } | null>(null);

  const openSubagent = useCallback((agentId: string) => {
    setTab('subagents');
    navigate(subagentPath(cid, agentId));
  }, [cid, setTab]);

  const onContextMenu = useCallback((ev: MouseEvent, agent: Subagent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const items = createSubagentMenuItems({
      cid,
      agent,
      lang,
      store,
      onOpen: (_c, aId) => openSubagent(aId),
      onCopy: async (text) => {
        const ok = await copyText(text);
        onToast(t(lang, ok ? 'copied' : 'err_copy'));
      },
    });
    setMenu({
      x: ev.clientX,
      y: ev.clientY,
      title: agent.title || agent.name,
      items,
    });
  }, [cid, lang, onToast, openSubagent, store]);

  return (
    <div className="dispatch-card" data-testid="next-dispatch-card">
      {agents.map((agent) => {
        const isSelected = open && tab === 'subagents' && selectedSubagentId === agent.id;
        const displayName = agent.name || agent.title || '';
        const showTask = Boolean(agent.title && agent.title !== displayName);
        const action = subagentActionText(agent);
        const tooltip = action ? `${displayName}：${action}` : displayName;

        return (
          <div
            key={agent.id}
            className={`dispatch-card-row${isSelected ? ' is-selected' : ''}`}
            data-testid="next-dispatch-row"
            data-agent-id={agent.id}
            data-status={agent.status}
            title={tooltip}
            onClick={(ev) => {
              ev.stopPropagation();
              openSubagent(agent.id);
            }}
            onContextMenu={(ev) => onContextMenu(ev, agent)}
          >
            <StatusIcon
              status={statusIconFor(agent.status, 'subagent') ?? 'running'}
              size={14}
              className="dispatch-card-status-icon"
              lang={lang}
              aria-hidden="true"
            />
            <span className="dispatch-card-name" data-testid="next-dispatch-name">{displayName}</span>
            {showTask ? (
              <span className="dispatch-card-task" data-testid="next-dispatch-task">{agent.title}</span>
            ) : null}
            <span className="dispatch-card-status" data-testid="next-dispatch-status">
              {statusLabel(agent.status, lang)}
            </span>
            <span className="dispatch-card-chev" aria-hidden="true">›</span>
          </div>
        );
      })}
      {menu ? (
        <CtxMenu
          x={menu.x}
          y={menu.y}
          title={menu.title}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
