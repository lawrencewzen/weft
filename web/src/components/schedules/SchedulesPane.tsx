import { useState, type MouseEvent } from 'react';
import { deleteSchedule, patchSchedule, runSchedule, type Schedule } from '../../data/api';
import type { Lang } from '../../data/lang';
import { useSchedules } from '../../data/useSchedules';
import { t } from '../../i18n';
import type { ConfirmOpts } from '../ConfirmDialog';
import { CtxMenu, type CtxMenuItem } from '../CtxMenu';
import { ScheduleDialog } from './ScheduleDialog';
import { ScheduleRow } from './ScheduleRow';

type Props = {
  lang: Lang;
  highlightId?: string;
  onToast: (msg: string) => void;
  onConfirm: (opts: ConfirmOpts) => Promise<boolean>;
};

type MenuState = {
  x: number;
  y: number;
  title: string;
  items: CtxMenuItem[];
};

export function SchedulesPane({ lang, highlightId, onToast, onConfirm }: Props) {
  const { schedules, ready } = useSchedules();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  async function handleToggle(schedule: Schedule) {
    try {
      await patchSchedule(schedule.id, { enabled: !schedule.enabled }, lang);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  }

  function handleEdit(schedule: Schedule) {
    setEditingSchedule(schedule);
    setDialogOpen(true);
  }

  async function handleRun(schedule: Schedule) {
    try {
      await runSchedule(schedule.id, undefined, lang);
      onToast(t(lang, 'schedules_run_triggered'));
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(schedule: Schedule) {
    const ok = await onConfirm({
      title: t(lang, 'schedules_delete_title'),
      message: t(lang, 'schedules_delete_msg', { name: schedule.name }),
      danger: true,
    });
    if (!ok) return;

    try {
      await deleteSchedule(schedule.id, undefined, lang);
      onToast(t(lang, 'schedules_deleted', { name: schedule.name }));
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  }

  function handleOpenMenu(ev: MouseEvent, items: CtxMenuItem[], title: string) {
    setMenu({
      x: ev.clientX,
      y: ev.clientY,
      title,
      items,
    });
  }

  return (
    <main
      className="col-center schedules-pane"
      data-testid="next-schedules-pane"
    >
      <header className="schedules-header" data-testid="next-schedules-header">
        <h2 className="schedules-title" data-testid="next-schedules-title">
          {t(lang, 'schedules_title')}
        </h2>
        <button
          type="button"
          className="btn p btn-sm schedules-new-btn"
          data-testid="next-schedules-new"
          onClick={() => {
            setEditingSchedule(null);
            setDialogOpen(true);
          }}
        >
          <svg className="icon schedules-new-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
          <span>{t(lang, 'schedules_new_btn')}</span>
        </button>
      </header>

      <div className="schedules-body">
        <div className="schedules-content">
          {!ready ? (
            <div className="schedules-loading">{t(lang, 'loading')}</div>
          ) : schedules.length === 0 ? (
            <div className="schedules-empty" data-testid="next-schedules-empty">
              <p className="schedules-empty-text">{t(lang, 'schedules_empty')}</p>
              <button
                type="button"
                className="btn p schedules-new-btn"
                data-testid="next-schedules-empty-new"
                onClick={() => {
                  setEditingSchedule(null);
                  setDialogOpen(true);
                }}
              >
                <svg className="icon schedules-new-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="8" y1="3" x2="8" y2="13" />
                  <line x1="3" y1="8" x2="13" y2="8" />
                </svg>
                <span>{t(lang, 'schedules_empty_btn')}</span>
              </button>
            </div>
          ) : (
            <div className="schedules-list" data-testid="next-schedules-list">
              {schedules.map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  lang={lang}
                  highlighted={schedule.id === highlightId}
                  onToggle={handleToggle}
                  onEdit={handleEdit}
                  onRun={handleRun}
                  onDelete={handleDelete}
                  onOpenMenu={handleOpenMenu}
                />
              ))}
            </div>
          )}

          <div className="schedules-footer-note" data-testid="next-schedules-footer-note">
            {t(lang, 'schedules_footer_note')}
          </div>
        </div>
      </div>

      {dialogOpen ? (
        <ScheduleDialog
          lang={lang}
          schedule={editingSchedule}
          onClose={() => {
            setDialogOpen(false);
            setEditingSchedule(null);
          }}
          onToast={onToast}
        />
      ) : null}

      {menu ? (
        <CtxMenu
          x={menu.x}
          y={menu.y}
          title={menu.title}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </main>
  );
}
