import { useEffect, useState } from 'react';
import { listScheduleRuns, type ScheduleRun } from '../../data/api';
import type { Lang } from '../../data/lang';
import { conversationPath, navigate } from '../../data/nav';
import { t } from '../../i18n';

type Props = {
  scheduleId: string;
  lang: Lang;
};

function formatRunTime(timestamp: number, lang: Lang): string {
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

export function ScheduleRunsList({ scheduleId, lang }: Props) {
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    listScheduleRuns(scheduleId, lang)
      .then((res) => {
        if (active) {
          setRuns(res.runs);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [scheduleId, lang]);

  if (loading) {
    return <div className="schedule-runs-loading">{t(lang, 'loading')}</div>;
  }

  if (error) {
    return <div className="schedule-runs-error">{error}</div>;
  }

  if (runs.length === 0) {
    return (
      <div className="schedule-runs-empty" data-testid="next-schedule-runs-empty">
        {t(lang, 'schedules_runs_empty')}
      </div>
    );
  }

  return (
    <div className="schedule-runs-table-wrap">
      <table className="schedule-runs-table" data-testid="next-schedule-runs-table">
        <thead>
          <tr>
            <th>{t(lang, 'schedules_run_col_time')}</th>
            <th>{t(lang, 'schedules_run_col_status')}</th>
            <th>{t(lang, 'schedules_run_col_conv')}</th>
            <th>{t(lang, 'schedules_run_col_error')}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            let statusText = t(lang, 'schedules_status_ok');
            if (run.status === 'failed') statusText = t(lang, 'schedules_status_failed');
            else if (run.status === 'missed_caught_up') statusText = t(lang, 'schedules_status_missed');

            return (
              <tr key={run.id} data-testid="next-schedule-run-item">
                <td className="schedule-run-time">{formatRunTime(run.at, lang)}</td>
                <td>
                  <span className={`schedule-status-badge is-${run.status}`}>
                    {statusText}
                  </span>
                </td>
                <td>
                  {run.conversationId ? (
                    <button
                      type="button"
                      className="schedule-conv-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (run.conversationId) navigate(conversationPath(run.conversationId));
                      }}
                    >
                      {t(lang, 'schedules_run_col_conv')}
                    </button>
                  ) : (
                    <span className="schedule-empty-dash">-</span>
                  )}
                </td>
                <td className="schedule-run-err-col">
                  {run.error ? (
                    <span className="schedule-run-err-text">{run.error}</span>
                  ) : (
                    <span className="schedule-empty-dash">-</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
