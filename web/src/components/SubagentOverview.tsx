import { useEffect, useState } from 'react';
import type { Lang } from '../data/lang';
import { navigate, subagentPath } from '../data/nav';
import {
  subagentOverviewNow,
  subagentTimeText,
} from '../data/subagentTime';
import type { Subagent } from '../data/store';
import { t } from '../i18n';
import { StatusIcon, statusIconFor } from './StatusIcon';

export function SubagentDot({ status }: { status: Subagent['status'] | string }) {
  const iconStatus = statusIconFor(status, 'subagent') ?? 'running';
  return (
    <StatusIcon
      status={iconStatus}
      size={14}
      className="sa-status-icon"
      aria-hidden="true"
    />
  );
}

export function SubagentOverview({
  cid,
  agents,
  lang,
}: {
  cid: string;
  agents: Subagent[];
  lang: Lang;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="sa-overview" data-testid="next-subagent-overview">
      <nav className="sa-overview-nav" aria-label={t(lang, 'tab_subagents')}>
        <span>{t(lang, 'tab_subagents')}</span>
        <span className="sa-overview-count">{agents.length}</span>
      </nav>
      <div className="sa-overview-list">
        {agents.map((agent) => {
          const title = agent.title || agent.name;
          const nowText = subagentOverviewNow(agent);
          const meta = subagentTimeText(agent, lang, now);
          return (
            <button
              key={agent.id}
              type="button"
              className="sa-card"
              data-testid="next-subagent-card"
              data-agent-id={agent.id}
              data-status={agent.status}
              onClick={() => navigate(subagentPath(cid, agent.id))}
            >
              <SubagentDot status={agent.status} />
              <span className="sa-card-text">
                <span className="sa-card-sum">{title}</span>
                {nowText ? <span className="sa-card-now">{nowText}</span> : null}
              </span>
              {meta ? <span className="sa-card-meta">{meta}</span> : null}
              <span className="sa-card-chev" aria-hidden="true">›</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
