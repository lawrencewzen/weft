import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Schedule } from '../../data/api';
import type { Lang } from '../../data/lang';
import { conversationPath, navigate } from '../../data/nav';
import { t } from '../../i18n';
import type { CtxMenuItem } from '../CtxMenu';
import { MORE_ICON } from '../SidebarIcons';
import { formatRule, formatTarget } from './formatRule';
import { ScheduleRunsList } from './ScheduleRunsList';

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

function formatNextRunTime(timestamp: number | null, enabled: boolean, lang: Lang): string {
  if (!enabled) return t(lang, 'schedules_status_paused');
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = d.getMonth() + 1;
  const date = d.getDate();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  if (lang === 'en') {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${monthNames[d.getMonth()]} ${date}, ${hours}:${minutes}`;
  }
  return `${month}月${date}日 ${hours}:${minutes}`;
}

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
  const [expanded, setExpanded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted) {
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [highlighted]);

  function handleRowClick(ev: MouseEvent) {
    const target = ev.target as HTMLElement;
    if (target.closest?.('button, a, input, select, textarea, .ns-switch')) return;
    setExpanded((prev) => !prev);
  }

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

  const lastRun = schedule.lastRun;
  let lastRunNode: React.ReactNode = null;
  if (!lastRun) {
    lastRunNode = <span className="schedule-status-badge is-never">{t(lang, 'schedules_status_never')}</span>;
  } else if (lastRun.status === 'ok' || lastRun.status === 'missed_caught_up') {
    const label = lastRun.status === 'ok'
      ? t(lang, 'schedules_status_ok')
      : t(lang, 'schedules_status_missed');
    lastRunNode = lastRun.conversationId ? (
      <button
        type="button"
        className={`schedule-status-link is-${lastRun.status}`}
        title={t(lang, 'schedules_run_col_conv')}
        onClick={(e) => {
          e.stopPropagation();
          if (lastRun.conversationId) navigate(conversationPath(lastRun.conversationId));
        }}
      >
        {label}
      </button>
    ) : (
      <span className={`schedule-status-badge is-${lastRun.status}`}>{label}</span>
    );
  } else {
    lastRunNode = (
      <span
        className="schedule-status-badge is-failed"
        title={lastRun.error || t(lang, 'schedules_status_failed')}
      >
        {t(lang, 'schedules_status_failed')}
      </span>
    );
  }

  return (
    <div
      ref={rowRef}
      className={`schedule-card${expanded ? ' is-expanded' : ''}${highlighted ? ' is-highlighted' : ''}`}
      data-testid="next-schedule-row"
      data-id={schedule.id}
      data-highlighted={highlighted ? 'true' : undefined}
      onClick={handleRowClick}
    >
      <div className="schedule-card-summary">
        {/* Toggle Switch */}
        <button
          type="button"
          className={`ns-switch schedule-toggle${schedule.enabled ? ' is-on' : ''}`}
          data-testid="next-schedule-toggle"
          aria-pressed={schedule.enabled}
          title={schedule.enabled ? t(lang, 'schedules_status_ok') : t(lang, 'schedules_status_paused')}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(schedule);
          }}
        />

        {/* Content Info */}
        <div className="schedule-card-info">
          <div className="schedule-card-title-row">
            <span className="schedule-card-name" data-testid="next-schedule-name">
              {schedule.name}
            </span>
            {schedule.createdBy === 'agent' ? (
              <span className="schedule-agent-badge" data-testid="next-schedule-agent-badge">
                {t(lang, 'schedules_created_by_agent')}
              </span>
            ) : null}
          </div>

          <div className="schedule-card-meta-row">
            <span className="schedule-meta-item schedule-meta-rule">
              {formatRule(schedule.rule, lang)}
            </span>
            <span className="schedule-meta-dot" aria-hidden="true">·</span>
            <span className="schedule-meta-item schedule-meta-target">
              {formatTarget(schedule.target, lang)}
            </span>
            <span className="schedule-meta-dot" aria-hidden="true">·</span>
            <span className="schedule-meta-item schedule-meta-next">
              {t(lang, 'schedule_next_run_label')}：{formatNextRunTime(schedule.nextRunAt, schedule.enabled, lang)}
            </span>
            <span className="schedule-meta-dot" aria-hidden="true">·</span>
            <span className="schedule-meta-item schedule-meta-last">
              {t(lang, 'schedule_last_run_label')}：{lastRunNode}
            </span>
          </div>
        </div>

        {/* Actions Button */}
        <div className="schedule-card-actions">
          <button
            type="button"
            className="btn-icon-xs schedule-more-btn"
            data-testid="next-schedule-more"
            title={t(lang, 'more_actions')}
            aria-label={t(lang, 'more_actions')}
            onClick={handleMoreClick}
          >
            {MORE_ICON}
          </button>
        </div>
      </div>

      {/* Expanded runs drawer */}
      {expanded ? (
        <div className="schedule-runs-drawer" data-testid="next-schedule-runs">
          <div className="schedule-runs-header">{t(lang, 'schedules_runs_title')}</div>
          <ScheduleRunsList scheduleId={schedule.id} lang={lang} />
        </div>
      ) : null}
    </div>
  );
}
