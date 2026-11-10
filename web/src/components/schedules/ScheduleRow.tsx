import { useEffect, useRef, type MouseEvent } from 'react';
import type { Schedule } from '../../data/api';
import type { Lang } from '../../data/lang';
import { conversationPath, navigate } from '../../data/nav';
import { t } from '../../i18n';
import type { CtxMenuItem } from '../CtxMenu';
import { MORE_ICON } from '../SidebarIcons';
import { formatNextRunSummary, formatRule } from './formatRule';

type Props = {
  schedule: Schedule;
  lang: Lang;
  highlighted?: boolean;
  onToggle: (schedule: Schedule) => void;
  onEdit: (schedule: Schedule) => void;
  onRun: (schedule: Schedule) => void;
  onDelete: (schedule: Schedule) => void;
  onOpenMenu: (ev: MouseEvent, items: CtxMenuItem[], title: string) => void;
};

export function ScheduleRow({
  schedule,
  lang,
  highlighted,
  onToggle,
  onEdit,
  onRun,
  onDelete,
  onOpenMenu,
}: Props) {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted) {
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [highlighted]);

  function handleMoreClick(ev: MouseEvent) {
    ev.stopPropagation();
    const items: CtxMenuItem[] = [
      {
        label: t(lang, 'schedules_menu_edit'),
        action: 'edit',
        run: () => onEdit(schedule),
      },
      {
        label: t(lang, 'schedules_menu_run'),
        action: 'run',
        run: () => onRun(schedule),
      },
      { sep: true },
      {
        label: t(lang, 'schedules_menu_delete'),
        action: 'delete',
        danger: true,
        run: () => onDelete(schedule),
      },
    ];
    onOpenMenu(ev, items, schedule.name);
  }

  // Determine last run status & hover title
  let lastRunStatus = 'never';
  let lastRunTitle = lang === 'en' ? 'Never run' : '从未运行';
  if (schedule.lastRun) {
    lastRunStatus = schedule.lastRun.status;
    if (schedule.lastRun.status === 'ok') {
      lastRunTitle = lang === 'en' ? 'Last run: Success' : '上次运行：成功';
    } else if (schedule.lastRun.status === 'missed_caught_up') {
      lastRunTitle = lang === 'en' ? 'Last run: Caught up' : '上次运行：补跑完成';
    } else if (schedule.lastRun.status === 'failed') {
      const err = schedule.lastRun.error ? ` (${schedule.lastRun.error})` : '';
      lastRunTitle = (lang === 'en' ? 'Last run: Failed' : '上次运行：失败') + err;
    }
  }

  // Target label & icon
  const targetLabel = schedule.target.kind === 'conversation'
    ? schedule.target.title || schedule.target.conversationId
    : `${schedule.target.workspaceName} · ${lang === 'en' ? 'New chat each time' : '每次新开对话'}`;

  return (
    <div
      ref={rowRef}
      className={`schedule-card${schedule.enabled ? ' is-enabled' : ' is-paused'}${highlighted ? ' is-highlighted' : ''}`}
      data-testid="next-schedule-row"
      data-id={schedule.id}
      data-highlighted={highlighted ? 'true' : undefined}
      onClick={() => onEdit(schedule)}
    >
      {/* 1. Header Row: Name + Badge + Switch */}
      <div className="schedule-card-top">
        <div className="schedule-card-name-wrap">
          <span className="schedule-card-name" data-testid="next-schedule-name" title={schedule.name}>
            {schedule.name}
          </span>
          {schedule.createdBy === 'agent' ? (
            <span className="schedule-agent-badge" data-testid="next-schedule-agent-badge">
              {t(lang, 'schedules_created_by_agent')}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className={`schedule-toggle ns-switch${schedule.enabled ? ' is-on' : ''}`}
          data-testid="next-schedule-toggle"
          aria-pressed={schedule.enabled}
          title={schedule.enabled ? t(lang, 'schedules_status_ok') : t(lang, 'schedules_status_paused')}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(schedule);
          }}
        />
      </div>

      {/* 2. Main Rule Summary (Large font) */}
      <div className="schedule-card-rule" data-testid="next-schedule-rule">
        {formatRule(schedule.rule, lang)}
      </div>

      {/* 3. Message Preview (Faint color, max 2 lines) */}
      <div className="schedule-card-message" data-testid="next-schedule-message" title={schedule.message}>
        {schedule.message}
      </div>

      {/* 4. Footer Row: Divider + Target + Status/NextRun + LastRun Dot + More */}
      <div className="schedule-card-footer">
        <div className="schedule-card-target" title={targetLabel}>
          {schedule.target.kind === 'conversation' ? (
            <svg className="icon schedule-target-icon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
              <path d="M2 3a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5.414L2.707 14.707A1 1 0 0 1 1 14V3a2 2 0 0 1 1-1z" />
            </svg>
          ) : (
            <svg className="icon schedule-target-icon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
              <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A.5.5 0 0 0 8.914 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" />
            </svg>
          )}
          <span className="schedule-card-target-text">{targetLabel}</span>
        </div>

        <div className="schedule-card-footer-right">
          <span className="schedule-card-status" data-testid="next-schedule-status-text">
            {!schedule.enabled
              ? t(lang, 'schedules_status_paused')
              : formatNextRunSummary(schedule.nextRunAt, lang)}
          </span>

          <span
            className={`schedule-last-run-dot is-${lastRunStatus}`}
            data-testid="next-schedule-last-run-dot"
            data-status={lastRunStatus}
            title={lastRunTitle}
            onClick={(e) => {
              if (schedule.lastRun?.conversationId) {
                e.stopPropagation();
                navigate(conversationPath(schedule.lastRun.conversationId));
              }
            }}
          />

          <button
            type="button"
            className="schedule-more-btn"
            data-testid="next-schedule-more"
            aria-label={t(lang, 'schedules_more_actions')}
            onClick={handleMoreClick}
          >
            {MORE_ICON}
          </button>
        </div>
      </div>
    </div>
  );
}
