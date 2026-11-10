import { deleteSchedule } from '../data/api';
import type { Lang } from '../data/lang';
import { navigate, schedulesPath } from '../data/nav';
import { useSchedules } from '../data/useSchedules';
import { t } from '../i18n';
import type { ConfirmOpts } from './ConfirmDialog';
import { CLOCK_ICON } from './SidebarIcons';
import { formatConversationScheduleStripText } from './schedules/formatRule';

type Props = {
  conversationId: string;
  lang: Lang;
  onConfirm?: (opts: ConfirmOpts) => Promise<boolean>;
  onToast?: (msg: string) => void;
};

export function ConversationScheduleStrip({
  conversationId,
  lang,
  onConfirm,
  onToast,
}: Props) {
  const { schedules } = useSchedules();

  const matching = schedules.filter(
    (s) => s.enabled && s.target.kind === 'conversation' && s.target.conversationId === conversationId,
  );

  if (matching.length === 0) return null;

  const first = matching[0];
  const text = formatConversationScheduleStripText(matching, lang);

  async function handleCancel() {
    if (!onConfirm) return;
    const ok = await onConfirm({
      title: t(lang, 'schedules_cancel_title'),
      message: t(lang, 'schedules_cancel_msg', { name: first.name }),
      danger: true,
    });
    if (!ok) return;

    try {
      await deleteSchedule(first.id, undefined, lang);
      onToast?.(t(lang, 'schedules_deleted', { name: first.name }));
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : String(err));
    }
  }

  function handleManage() {
    navigate(schedulesPath(first.id));
  }

  return (
    <div
      className="conversation-schedule-strip"
      data-testid="next-conversation-schedule-strip"
      role="status"
    >
      <span className="schedule-strip-icon" aria-hidden="true">
        {CLOCK_ICON}
      </span>
      <span className="schedule-strip-text" data-testid="next-schedule-strip-text">
        {text}
      </span>
      <div className="schedule-strip-actions">
        {first.rule.kind === 'once' ? (
          <button
            type="button"
            className="schedule-strip-cancel"
            data-testid="next-schedule-strip-cancel"
            onClick={() => { void handleCancel(); }}
          >
            {t(lang, 'schedules_cancel')}
          </button>
        ) : null}
        <button
          type="button"
          className="schedule-strip-manage"
          data-testid="next-schedule-strip-manage"
          onClick={handleManage}
        >
          {t(lang, 'schedules_manage')}
        </button>
      </div>
    </div>
  );
}
