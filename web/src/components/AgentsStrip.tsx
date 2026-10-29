import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { stopSubagent } from '../data/api';
import { FOCUS_SUBAGENT_EVENT, type FocusSubagentDetail } from '../data/focusSubagent';
import type { Lang } from '../data/lang';
import { useSession } from '../data/session';
import { conversationTopic, subagentTopic, type Subagent } from '../data/store';
import { useStoreTopics } from '../data/useStoreTopic';
import { t } from '../i18n';
import {
  countByIconStatus,
  extractSubagentSteps,
  formatAgentDoing,
  formatAgentElapsed,
  formatAgentsHeadline,
  hasUnendedAgents,
  isAllEndedAgents,
  isSubagentEnded,
} from './agentsStripUtils';
import { StatusIcon, statusIconFor } from './StatusIcon';

export interface AgentsStripProps {
  cid?: string | null;
  lang: Lang;
}

export function AgentsStrip({ cid, lang }: AgentsStripProps) {
  const { store, retainTopic, releaseTopic } = useSession();
  const stripRef = useRef<HTMLDivElement | null>(null);

  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const [open, setOpen] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hadLiveRef = useRef(false);

  const clearFadeTimers = useCallback(() => {
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    if (fadeEndTimerRef.current) {
      clearTimeout(fadeEndTimerRef.current);
      fadeEndTimerRef.current = null;
    }
  }, []);

  // Subscribe to store updates for conversation and subagent topics
  const topicsToWatch = useMemo(() => {
    if (!cid) return [];
    return [
      conversationTopic(cid),
      `${conversationTopic(cid)}#subagent`,
    ];
  }, [cid]);

  const storeVersion = useStoreTopics(store, topicsToWatch);

  const agents: Subagent[] = useMemo(() => {
    return cid ? store.subagents(cid) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- storeVersion tracks store updates
  }, [cid, store, storeVersion]);

  const agentsKey = agents.map((a) => `${a.id}:${a.status}`).join(';');

  // Retain topics for subagents
  useEffect(() => {
    if (!cid || !agents.length) return;
    const topics = agents.map((a) => subagentTopic(cid, a.id));
    for (const top of topics) retainTopic(top);
    return () => {
      for (const top of topics) releaseTopic(top);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- agentsKey captures changes
  }, [cid, agentsKey, retainTopic, releaseTopic]);

  // Timer for elapsed time
  useEffect(() => {
    if (!visible) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [visible]);

  // Conversation switch reset
  useEffect(() => {
    clearFadeTimers();
    setOpen(false);
    setOpenRow(null);
    setFading(false);
    if (!cid) {
      setVisible(false);
      hadLiveRef.current = false;
      return;
    }
    const currentAgents = store.subagents(cid);
    const live = hasUnendedAgents(currentAgents);
    hadLiveRef.current = live;
    setVisible(live);
  }, [cid, store, clearFadeTimers]);

  // Transition to all-ended fadeout
  useEffect(() => {
    if (!cid) return;
    const live = hasUnendedAgents(agents);
    const allEnded = isAllEndedAgents(agents);

    if (live) {
      hadLiveRef.current = true;
      clearFadeTimers();
      setFading(false);
      setVisible(true);
    } else if (allEnded && (hadLiveRef.current || visible)) {
      hadLiveRef.current = false;
      clearFadeTimers();
      if (!open) {
        fadeTimerRef.current = setTimeout(() => {
          setFading(true);
          fadeEndTimerRef.current = setTimeout(() => {
            setVisible(false);
            setFading(false);
          }, 450);
        }, 6000);
      }
    }
  }, [agentsKey, cid, visible, open, clearFadeTimers, agents]);

  // Listen to focus subagent event
  useEffect(() => {
    const onFocus = (ev: Event) => {
      const custom = ev as CustomEvent<FocusSubagentDetail>;
      const agentId = custom.detail?.agentId;
      if (!agentId) return;
      clearFadeTimers();
      setFading(false);
      setVisible(true);
      setOpen(true);
      setOpenRow(agentId);
      requestAnimationFrame(() => {
        const el = stripRef.current?.querySelector(`[data-agent-id="${CSS.escape(agentId)}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    };
    window.addEventListener(FOCUS_SUBAGENT_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_SUBAGENT_EVENT, onFocus);
  }, [clearFadeTimers]);

  const onToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (!next) {
        setOpenRow(null);
      } else {
        clearFadeTimers();
        setFading(false);
      }
      return next;
    });
  }, [clearFadeTimers]);

  const onStopAgent = useCallback(
    async (agentId: string) => {
      if (!cid) return;
      try {
        await stopSubagent(cid, agentId);
      } catch (err) {
        console.error('Failed to stop subagent:', err);
      }
    },
    [cid],
  );

  if (!visible || !cid || agents.length === 0) {
    return null;
  }

  const summaryCounts = countByIconStatus(agents);
  const headline = formatAgentsHeadline(agents, lang);
  const parentItems = store.topicItems(conversationTopic(cid));

  return (
    <div
      ref={stripRef}
      className={`agents-strip strip${open ? ' open is-open' : ''}${fading ? ' fade is-fade' : ''}`}
      data-testid="next-agents-strip"
    >
      <div
        className="agents-strip-header sh"
        data-testid="next-agents-strip-toggle"
        data-toggle
        onClick={onToggle}
      >
        <span className="agents-strip-counts">
          {summaryCounts.map(({ status, count }) => (
            <span key={status} className="agents-strip-count cnt" data-testid="next-agents-strip-count">
              <StatusIcon status={status} size={14} aria-hidden="true" />
              <span>{count}</span>
            </span>
          ))}
        </span>
        <span className="agents-strip-headline t" data-testid="next-agents-strip-headline">
          {headline}
        </span>
        <span className="agents-strip-toggle r" data-testid="next-agents-strip-expand">
          {open ? t(lang, 'agents_strip_collapse') : t(lang, 'agents_strip_expand')}
          <svg
            className="agents-strip-chevron chev"
            viewBox="0 0 16 16"
            width={13}
            height={13}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          >
            <path d="M4 10l4-4 4 4" />
          </svg>
        </span>
      </div>

      {open ? (
        <div className="agents-strip-list list" data-testid="next-agents-strip-list">
          {agents.map((agent) => {
            const isRowOpen = openRow === agent.id;
            const iconStatus = statusIconFor(agent.status, 'subagent') ?? 'running';
            const name = agent.name || agent.title || '';
            const isEnded = isSubagentEnded(agent.status);

            // Find parent report if any
            const report = parentItems.find(
              (it) => it.kind === 'subagent_report' && (it.subagentId === agent.id || it.name === agent.name),
            );
            const topic = subagentTopic(cid, agent.id);
            const subItems = store.topicItems(topic);
            const subTools = store.toolsByTopic(topic);
            const lastText = store.lastAssistantText(topic);

            let resText = '';
            let failReason = '';
            if (report && report.kind === 'subagent_report') {
              if (report.reportKind === 'answered') resText = report.body;
              if (report.reportKind === 'failed') failReason = report.body;
            }
            if (!resText && agent.status === 'done') {
              resText = lastText || t(lang, 'agents_strip_done_summary');
            }
            if (!failReason && agent.status === 'failed') {
              failReason = lastText || agent.currentAction || t(lang, 'status_failed');
            }

            const doing = formatAgentDoing(agent, { lang, resText });
            const elapsed = formatAgentElapsed(agent, now);
            const steps = extractSubagentSteps(subItems, subTools, lang);

            return (
              <div
                key={agent.id}
                className={`agents-strip-item ag${isRowOpen ? ' open is-open' : ''}`}
                data-agent-id={agent.id}
              >
                <div
                  className="agents-strip-row ar"
                  data-testid="next-agents-strip-row"
                  data-row={agent.id}
                  data-agent-id={agent.id}
                  data-status={agent.status}
                  onClick={() => setOpenRow(isRowOpen ? null : agent.id)}
                >
                  <StatusIcon status={iconStatus} size={14} aria-hidden="true" />
                  <span className="agents-strip-name nm" data-testid="next-agents-strip-name">
                    {name}
                  </span>
                  <span className="agents-strip-doing doing" data-testid="next-agents-strip-doing">
                    {doing}
                  </span>
                  <span className="agents-strip-elapsed el" data-testid="next-agents-strip-time">
                    {elapsed}
                  </span>
                  {!isEnded ? (
                    <button
                      type="button"
                      className="agents-strip-stop stop"
                      data-testid="next-agents-strip-stop"
                      data-stop={agent.id}
                      title={t(lang, 'agents_strip_stop')}
                      aria-label={t(lang, 'agents_strip_stop')}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void onStopAgent(agent.id);
                      }}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14">
                        <rect x="4.5" y="4.5" width="7" height="7" rx="1.4" fill="currentColor" />
                      </svg>
                    </button>
                  ) : null}
                </div>

                {isRowOpen ? (
                  <div className="agents-strip-detail det" data-testid="next-agents-strip-detail">
                    {agent.status === 'done' ? (
                      <div className="agents-strip-res res" data-testid="next-agents-strip-detail-text">
                        {resText || t(lang, 'agents_strip_done_summary')}
                      </div>
                    ) : agent.status === 'waiting' || (agent.status as string) === 'queued' ? (
                      <div className="agents-strip-res res" data-testid="next-agents-strip-detail-text">
                        {t(lang, 'agents_strip_queued_desc')}
                      </div>
                    ) : agent.status === 'failed' ? (
                      <div className="agents-strip-res res" data-testid="next-agents-strip-detail-text">
                        {t(lang, 'agents_strip_failed_desc', { reason: failReason })}
                      </div>
                    ) : steps.length > 0 ? (
                      steps.map((st, idx) => (
                        <div key={idx} className="agents-strip-step step" data-testid="next-agents-strip-step">
                          <span className="agents-strip-step-verb k">{st.verb}</span>
                          <span className="agents-strip-step-desc v">{st.desc}</span>
                        </div>
                      ))
                    ) : (
                      <div className="agents-strip-res res" data-testid="next-agents-strip-detail-text">
                        {agent.currentAction || t(lang, 'status_running')}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
