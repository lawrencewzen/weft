import { useState, useId } from 'react';
import { createSchedule, patchSchedule, type Schedule } from '../../data/api';
import type { Lang } from '../../data/lang';
import { useProviders } from '../../data/useProviders';
import { useWorkspaces } from '../../data/useWorkspaces';
import { t } from '../../i18n';
import {
  formDataToPayload,
  validateScheduleForm,
  type ScheduleFormData,
  type ScheduleFormErrors,
} from './scheduleValidation';

type Props = {
  lang: Lang;
  schedule?: Schedule | null;
  onClose: () => void;
  onToast: (msg: string) => void;
};

function formatIsoForDateTimeLocal(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  const YYYY = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const DD = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${YYYY}-${MM}-${DD}T${hh}:${mm}`;
}

export function ScheduleDialog({ lang, schedule, onClose, onToast }: Props) {
  const { workspaces, conversations } = useWorkspaces();
  const { providers } = useProviders();
  const titleId = useId();

  const isEditing = Boolean(schedule);

  // Initialize initial form state
  const [name, setName] = useState(schedule?.name || '');
  const [message, setMessage] = useState(schedule?.message || '');

  const [targetKind, setTargetKind] = useState<'conversation' | 'new'>(
    schedule?.target.kind || 'new',
  );
  const [conversationId, setConversationId] = useState(
    schedule?.target.kind === 'conversation'
      ? schedule.target.conversationId
      : conversations[0]?.id || '',
  );
  const [workspaceId, setWorkspaceId] = useState(
    schedule?.target.kind === 'new'
      ? schedule.target.workspaceId
      : workspaces[0]?.id || '',
  );

  const initialModelStr = schedule?.target.kind === 'new' && schedule.target.model
    ? `${schedule.target.model.providerId}:${schedule.target.model.modelId}`
    : 'default';
  const [modelChoice, setModelChoice] = useState(initialModelStr);

  const [ruleKind, setRuleKind] = useState<'once' | 'daily' | 'weekly' | 'interval'>(
    schedule?.rule.kind || 'weekly',
  );

  const defaultOnceAt = schedule?.rule.kind === 'once'
    ? schedule.rule.at
    : Date.now() + 86400000;
  const [onceIso, setOnceIso] = useState(formatIsoForDateTimeLocal(defaultOnceAt));

  const [dailyTime, setDailyTime] = useState(
    schedule?.rule.kind === 'daily' ? schedule.rule.time : '09:00',
  );

  const [weeklyDays, setWeeklyDays] = useState<number[]>(
    schedule?.rule.kind === 'weekly' ? schedule.rule.days : [1, 2, 3, 4, 5],
  );
  const [weeklyTime, setWeeklyTime] = useState(
    schedule?.rule.kind === 'weekly' ? schedule.rule.time : '09:00',
  );

  const defaultIntervalMinutes = schedule?.rule.kind === 'interval'
    ? schedule.rule.everyMinutes
    : 30;
  const isHours = defaultIntervalMinutes >= 60 && defaultIntervalMinutes % 60 === 0;
  const [intervalVal, setIntervalVal] = useState(
    isHours ? defaultIntervalMinutes / 60 : defaultIntervalMinutes,
  );
  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'hours'>(
    isHours ? 'hours' : 'minutes',
  );

  const [errors, setErrors] = useState<ScheduleFormErrors>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState('');

  const targetConv = conversations.find((c) => c.id === conversationId);
  const targetWs = workspaces.find((w) => w.id === workspaceId);

  const resolvedModel = modelChoice === 'default' ? null : (() => {
    const [pId, mId] = modelChoice.split(':');
    return pId && mId ? { providerId: pId, modelId: mId } : null;
  })();

  const currentFormData: ScheduleFormData = {
    name,
    message,
    targetKind,
    conversationId,
    conversationTitle: targetConv?.title || '',
    workspaceId,
    workspaceName: targetWs?.name || '',
    model: resolvedModel,
    ruleKind,
    onceAt: new Date(onceIso).getTime(),
    dailyTime,
    weeklyDays,
    weeklyTime,
    intervalValue: intervalVal,
    intervalUnit,
  };

  function toggleWeeklyDay(day: number) {
    setWeeklyDays((prev) => {
      const next = prev.includes(day)
        ? prev.filter((d) => d !== day)
        : [...prev, day].sort((a, b) => a - b);
      if (errors.weeklyDays) {
        setErrors((errs) => ({ ...errs, weeklyDays: undefined }));
      }
      return next;
    });
  }

  function handleIntervalChange(num: number, unit: 'minutes' | 'hours') {
    setIntervalVal(num);
    setIntervalUnit(unit);
    const totalMinutes = unit === 'hours' ? num * 60 : num;
    if (totalMinutes < 5) {
      setErrors((errs) => ({ ...errs, interval: t(lang, 'schedule_err_interval_min') }));
    } else {
      setErrors((errs) => ({ ...errs, interval: undefined }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const val = validateScheduleForm(currentFormData, lang);
    if (!val.valid) {
      setErrors(val.errors);
      return;
    }
    setBusy(true);
    setServerError('');
    try {
      const payload = formDataToPayload(currentFormData, schedule?.enabled ?? true);
      if (isEditing && schedule) {
        await patchSchedule(schedule.id, payload, lang);
      } else {
        await createSchedule(payload, lang);
      }
      onToast(t(lang, 'schedule_saved'));
      onClose();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const zhDays = ['一', '二', '三', '四', '五', '六', '日'];
  const enDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="modal-overlay" data-testid="next-schedule-dialog-overlay">
      <div
        className="modal-dialog schedule-dialog"
        role="dialog"
        aria-labelledby={titleId}
        aria-modal="true"
        data-testid="next-schedule-dialog"
      >
        <h3 id={titleId}>
          {isEditing ? t(lang, 'schedule_dialog_title_edit') : t(lang, 'schedule_dialog_title_new')}
          <button
            type="button"
            className="confirm-close"
            onClick={onClose}
            aria-label={t(lang, 'btn_cancel')}
          >
            ×
          </button>
        </h3>

        <form onSubmit={handleSubmit} className="schedule-dialog-form">
          {/* Name */}
          <div className="schedule-form-group">
            <label className="schedule-form-label" htmlFor="sched-input-name">
              {t(lang, 'schedule_name_label')}
            </label>
            <input
              id="sched-input-name"
              className={`ns-input${errors.name ? ' is-error' : ''}`}
              data-testid="next-schedule-name-input"
              value={name}
              placeholder={t(lang, 'schedule_name_placeholder')}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors((errs) => ({ ...errs, name: undefined }));
              }}
            />
            {errors.name ? (
              <div className="schedule-field-err" data-testid="next-schedule-err-name">
                {errors.name}
              </div>
            ) : null}
          </div>

          {/* Message */}
          <div className="schedule-form-group">
            <label className="schedule-form-label" htmlFor="sched-input-message">
              {t(lang, 'schedule_message_label')}
            </label>
            <textarea
              id="sched-input-message"
              className={`ns-input schedule-textarea${errors.message ? ' is-error' : ''}`}
              data-testid="next-schedule-message-input"
              rows={3}
              value={message}
              placeholder={t(lang, 'schedule_message_placeholder')}
              onChange={(e) => {
                setMessage(e.target.value);
                if (errors.message) setErrors((errs) => ({ ...errs, message: undefined }));
              }}
            />
            {errors.message ? (
              <div className="schedule-field-err" data-testid="next-schedule-err-message">
                {errors.message}
              </div>
            ) : null}
          </div>

          {/* Target */}
          <div className="schedule-form-group">
            <label className="schedule-form-label">{t(lang, 'schedule_target_label')}</label>
            <div className="schedule-segmented-controls" role="radiogroup">
              <button
                type="button"
                className={`schedule-seg-btn${targetKind === 'conversation' ? ' is-active' : ''}`}
                data-testid="next-schedule-target-conv"
                onClick={() => setTargetKind('conversation')}
              >
                {t(lang, 'schedule_target_conv')}
              </button>
              <button
                type="button"
                className={`schedule-seg-btn${targetKind === 'new' ? ' is-active' : ''}`}
                data-testid="next-schedule-target-new"
                onClick={() => setTargetKind('new')}
              >
                {t(lang, 'schedule_target_new')}
              </button>
            </div>

            {targetKind === 'conversation' ? (
              <div className="schedule-target-subrow">
                <select
                  className="ns-input"
                  data-testid="next-schedule-conv-select"
                  value={conversationId}
                  onChange={(e) => {
                    setConversationId(e.target.value);
                    if (errors.conversationId) {
                      setErrors((errs) => ({ ...errs, conversationId: undefined }));
                    }
                  }}
                >
                  {conversations.length === 0 ? (
                    <option value="">{t(lang, 'schedule_target_select_conv')}</option>
                  ) : null}
                  {conversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
                {errors.conversationId ? (
                  <div className="schedule-field-err">{errors.conversationId}</div>
                ) : null}
              </div>
            ) : (
              <div className="schedule-target-subrow schedule-new-grid">
                <div>
                  <label className="schedule-sublabel" htmlFor="sched-select-ws">
                    {t(lang, 'schedule_target_select_ws')}
                  </label>
                  <select
                    id="sched-select-ws"
                    className="ns-input"
                    data-testid="next-schedule-ws-select"
                    value={workspaceId}
                    onChange={(e) => {
                      setWorkspaceId(e.target.value);
                      if (errors.workspaceId) {
                        setErrors((errs) => ({ ...errs, workspaceId: undefined }));
                      }
                    }}
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="schedule-sublabel" htmlFor="sched-select-model">
                    {t(lang, 'schedule_target_model_label')}
                  </label>
                  <select
                    id="sched-select-model"
                    className="ns-input"
                    data-testid="next-schedule-model-select"
                    value={modelChoice}
                    onChange={(e) => setModelChoice(e.target.value)}
                  >
                    <option value="default">{t(lang, 'schedule_target_model_default')}</option>
                    {providers.flatMap((p) =>
                      p.models.map((m) => (
                        <option key={`${p.id}:${m.id}`} value={`${p.id}:${m.id}`}>
                          {p.name} · {m.name || m.id}
                        </option>
                      )),
                    )}
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Time Rule */}
          <div className="schedule-form-group">
            <label className="schedule-form-label">{t(lang, 'schedule_rule_label')}</label>
            <div className="schedule-segmented-controls" role="radiogroup">
              <button
                type="button"
                className={`schedule-seg-btn${ruleKind === 'once' ? ' is-active' : ''}`}
                data-testid="next-schedule-rule-once"
                onClick={() => setRuleKind('once')}
              >
                {t(lang, 'schedule_rule_once')}
              </button>
              <button
                type="button"
                className={`schedule-seg-btn${ruleKind === 'daily' ? ' is-active' : ''}`}
                data-testid="next-schedule-rule-daily"
                onClick={() => setRuleKind('daily')}
              >
                {t(lang, 'schedule_rule_daily')}
              </button>
              <button
                type="button"
                className={`schedule-seg-btn${ruleKind === 'weekly' ? ' is-active' : ''}`}
                data-testid="next-schedule-rule-weekly"
                onClick={() => setRuleKind('weekly')}
              >
                {t(lang, 'schedule_rule_weekly')}
              </button>
              <button
                type="button"
                className={`schedule-seg-btn${ruleKind === 'interval' ? ' is-active' : ''}`}
                data-testid="next-schedule-rule-interval"
                onClick={() => setRuleKind('interval')}
              >
                {t(lang, 'schedule_rule_interval')}
              </button>
            </div>

            {ruleKind === 'once' ? (
              <div className="schedule-rule-subrow">
                <input
                  type="datetime-local"
                  className="ns-input"
                  data-testid="next-schedule-once-input"
                  value={onceIso}
                  onChange={(e) => {
                    setOnceIso(e.target.value);
                    if (errors.onceAt) setErrors((errs) => ({ ...errs, onceAt: undefined }));
                  }}
                />
                {errors.onceAt ? <div className="schedule-field-err">{errors.onceAt}</div> : null}
              </div>
            ) : null}

            {ruleKind === 'daily' ? (
              <div className="schedule-rule-subrow">
                <input
                  type="time"
                  className="ns-input"
                  data-testid="next-schedule-daily-time"
                  value={dailyTime}
                  onChange={(e) => {
                    setDailyTime(e.target.value);
                    if (errors.dailyTime) setErrors((errs) => ({ ...errs, dailyTime: undefined }));
                  }}
                />
                {errors.dailyTime ? (
                  <div className="schedule-field-err">{errors.dailyTime}</div>
                ) : null}
              </div>
            ) : null}

            {ruleKind === 'weekly' ? (
              <div className="schedule-rule-subrow">
                <div className="schedule-days-picker" data-testid="next-schedule-weekly-days">
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => {
                    const active = weeklyDays.includes(d);
                    const label = lang === 'en' ? enDays[d - 1] : zhDays[d - 1];
                    return (
                      <button
                        key={d}
                        type="button"
                        className={`schedule-day-chip${active ? ' is-active' : ''}`}
                        data-day={d}
                        onClick={() => toggleWeeklyDay(d)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="schedule-time-row">
                  <span className="schedule-sublabel">{t(lang, 'schedule_rule_time_label')}</span>
                  <input
                    type="time"
                    className="ns-input"
                    data-testid="next-schedule-weekly-time"
                    value={weeklyTime}
                    onChange={(e) => {
                      setWeeklyTime(e.target.value);
                      if (errors.weeklyTime) {
                        setErrors((errs) => ({ ...errs, weeklyTime: undefined }));
                      }
                    }}
                  />
                </div>
                {errors.weeklyDays ? (
                  <div className="schedule-field-err">{errors.weeklyDays}</div>
                ) : null}
              </div>
            ) : null}

            {ruleKind === 'interval' ? (
              <div className="schedule-rule-subrow">
                <div className="schedule-interval-row">
                  <input
                    type="number"
                    min="1"
                    className={`ns-input is-number${errors.interval ? ' is-error' : ''}`}
                    data-testid="next-schedule-interval-input"
                    value={intervalVal}
                    onChange={(e) =>
                      handleIntervalChange(parseInt(e.target.value, 10) || 0, intervalUnit)
                    }
                  />
                  <select
                    className="ns-input"
                    data-testid="next-schedule-interval-unit"
                    value={intervalUnit}
                    onChange={(e) =>
                      handleIntervalChange(intervalVal, e.target.value as 'minutes' | 'hours')
                    }
                  >
                    <option value="minutes">{t(lang, 'schedule_rule_interval_unit_min')}</option>
                    <option value="hours">{t(lang, 'schedule_rule_interval_unit_hour')}</option>
                  </select>
                </div>
                {errors.interval ? (
                  <div className="schedule-field-err" data-testid="next-schedule-err-interval">
                    {errors.interval}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {serverError ? (
            <div className="ns-inline-err" data-testid="next-schedule-server-err">
              {serverError}
            </div>
          ) : null}

          <div className="modal-actions">
            <button
              type="button"
              className="btn"
              data-testid="next-schedule-cancel"
              onClick={onClose}
            >
              {t(lang, 'btn_cancel')}
            </button>
            <button
              type="submit"
              className="btn p"
              data-testid="next-schedule-submit"
              disabled={busy || Boolean(errors.interval)}
            >
              {t(lang, 'btn_confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
