import { useEffect, useId, useRef, useState } from 'react';
import type { Lang } from '../data/lang';
import {
  contextIsWarn,
  contextRemainPercent,
  type ComposerModelOption,
  type ContextUsage,
} from '../data/composerModel';
import { formatTokenCount, t } from '../i18n';

type Props = {
  lang: Lang;
  context: ContextUsage;
  selected?: ComposerModelOption | null;
  /** Manual compaction; omitted (e.g. a draft) renders the action disabled. */
  compact?: { state: 'idle' | 'running' | 'failed'; error?: string | null; onCompact: () => void };
};

export function ContextChip({ lang, context, selected, compact }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const warn = contextIsWarn(context.level);
  const remain = contextRemainPercent(context);
  const ringRadius = 7.5;
  const circumference = 2 * Math.PI * ringRadius;
  const windowTokens = context.window || selected?.contextWindow || 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (!wrap.current?.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      setOpen(false);
      chipRef.current?.focus();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) actionRef.current?.focus({ preventScroll: true });
  }, [open]);

  const running = compact?.state === 'running';
  const usageText = `${formatTokenCount(context.used)} / ${formatTokenCount(windowTokens)}`;

  return (
    <div
      className="context-chip-wrap"
      ref={wrap}
      onBlur={(ev) => {
        if (open && !ev.currentTarget.contains(ev.relatedTarget as Node | null) && ev.relatedTarget) setOpen(false);
      }}
    >
    <button
      ref={chipRef}
      type="button"
      className={`context-chip${warn ? ' is-warn' : ''}${context.percent >= 70 ? ' has-num' : ''}`}
      data-testid="next-context-chip"
      data-level={context.level}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={() => setOpen((v) => !v)}
      title={t(lang, 'ctx_title', {
        used: formatTokenCount(context.used),
        window: formatTokenCount(windowTokens),
        usedPct: context.percent,
        leftPct: remain,
      })}
    >
      <svg className="ctx-ring" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle className="ctx-ring-track" cx="10" cy="10" r="7.5" fill="none" strokeWidth="2.5" />
        <circle
          className="ctx-ring-fill"
          cx="10"
          cy="10"
          r="7.5"
          fill="none"
          strokeWidth="2.5"
          strokeDasharray={`${(Math.min(100, context.percent) / 100) * circumference} ${circumference}`}
        />
      </svg>
      {context.percent >= 70 ? (
        <span className="context-chip-pct">{t(lang, 'ctx_percent', { n: context.percent })}</span>
      ) : null}
    </button>
    {open ? (
      <div
        className="context-pop"
        id={panelId}
        role="dialog"
        aria-label={t(lang, 'ctx_menu_title')}
        data-testid="next-context-pop"
      >
        <div className="context-pop-usage" data-testid="next-context-pop-usage">{usageText}</div>
        <button
          ref={actionRef}
          type="button"
          className={`context-pop-act${compact?.error ? ' is-err' : ''}`}
          data-testid="next-menu-compact"
          data-state={compact?.state ?? 'unavailable'}
          disabled={!compact || running}
          aria-busy={running}
          onClick={compact?.onCompact}
        >
          <span>{t(lang, 'ctx_compact')}</span>
          {running ? (
            <span className="run-spin" data-testid="next-compact-spin" aria-hidden="true"><span /></span>
          ) : compact?.error ? (
            <span className="context-pop-err">{compact.error}</span>
          ) : null}
        </button>
      </div>
    ) : null}
    </div>
  );
}
