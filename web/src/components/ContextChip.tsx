import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Lang } from '../data/lang';
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  contextIsWarn,
  contextRemainPercent,
  contextWindowOptions,
  parseContextWindowInput,
  type ComposerModelOption,
  type ContextUsage,
} from '../data/composerModel';
import { formatTokenCount, t } from '../i18n';

type Props = {
  lang: Lang;
  context: ContextUsage;
  selected: ComposerModelOption | null;
  onSetWindow: (window: number | null) => Promise<unknown> | unknown;
};

export function ContextBanner({
  lang,
  context,
  onNewChat,
}: {
  lang: Lang;
  context: ContextUsage;
  onNewChat: () => void;
}) {
  if (!contextIsWarn(context.level)) return null;
  return (
    <div className="composer-ctx-banner" data-testid="next-context-banner" data-level={context.level}>
      <span>{t(lang, 'ctx_banner', { n: context.percent })}</span>
      <button
        type="button"
        className="composer-ctx-new"
        data-testid="next-context-new"
        onClick={onNewChat}
      >
        {t(lang, 'ctx_banner_new')}
      </button>
    </div>
  );
}

export function ContextChip({ lang, context, selected, onSetWindow }: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const warn = contextIsWarn(context.level);
  const remain = contextRemainPercent(context);
  const circumference = 2 * Math.PI * 5;
  const canEdit = Boolean(selected?.providerId && selected.modelId);
  const windowTokens = selected?.contextWindow || context.window;
  const options = contextWindowOptions(windowTokens);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    const onDown = (ev: MouseEvent) => {
      if (!wrap.current?.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  async function pick(tokens: number | null) {
    if (!canEdit) return;
    setOpen(false);
    setError(null);
    await onSetWindow(tokens);
  }

  function submitCustom(event: FormEvent) {
    event.preventDefault();
    const parsed = parseContextWindowInput(custom);
    if (parsed == null) {
      setError(t(lang, 'ctx_window_range', { min: CONTEXT_WINDOW_MIN, max: CONTEXT_WINDOW_MAX }));
      return;
    }
    void pick(parsed);
  }

  return (
      <div className="chip-selector-wrap context-chip-wrap" ref={wrap}>
        <button
          type="button"
          className={`context-chip${warn ? ' is-warn' : ''}${open ? ' is-open' : ''}`}
          data-testid="next-context-chip"
          data-level={context.level}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={!canEdit}
          title={t(lang, 'ctx_title', {
            used: formatTokenCount(context.used),
            window: formatTokenCount(windowTokens),
            usedPct: context.percent,
            leftPct: remain,
          })}
          onClick={() => {
            if (!canEdit) return;
            setOpen((value) => !value);
            setError(null);
          }}
        >
          <svg className="ctx-ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
            <circle className="ctx-ring-track" cx="7" cy="7" r="5" fill="none" strokeWidth="2" />
            <circle
              className="ctx-ring-fill"
              cx="7"
              cy="7"
              r="5"
              fill="none"
              strokeWidth="2"
              strokeDasharray={`${(Math.min(100, context.percent) / 100) * circumference} ${circumference}`}
            />
          </svg>
          <span className="context-chip-pct">{t(lang, 'ctx_percent', { n: context.percent })}</span>
        </button>
        {open ? (
          <div className="context-menu" data-testid="next-context-menu" role="menu">
            <div className="chip-menu-stat">
              {t(lang, 'ctx_menu_used', {
                count: formatTokenCount(context.used),
                pct: context.percent,
              })}
            </div>
            <div className="chip-menu-stat">
              {t(lang, 'ctx_menu_remain', {
                count: formatTokenCount(Math.max(0, windowTokens - context.used)),
                pct: remain,
              })}
            </div>
            <div className="chip-menu-sep" />
            <div className="chip-menu-title">{t(lang, 'ctx_menu_limit')}</div>
            {options.map((option) => (
              <button
                key={option.tokens}
                type="button"
                className={`model-menu-item${option.selected ? ' is-selected' : ''}`}
                role="menuitem"
                aria-selected={option.selected}
                data-testid="next-context-option"
                data-tokens={option.tokens}
                onClick={() => { void pick(option.tokens); }}
              >
                <span>{formatTokenCount(option.tokens)}{option.custom ? ` · ${t(lang, 'ctx_custom_mark')}` : ''}</span>
                {option.selected ? <span className="model-menu-check" aria-hidden="true">✓</span> : null}
              </button>
            ))}
            <form className="context-custom" onSubmit={submitCustom}>
              <input
                className="context-custom-input"
                data-testid="next-context-custom"
                inputMode="numeric"
                placeholder={t(lang, 'ctx_custom_placeholder')}
                value={custom}
                onChange={(event) => {
                  setCustom(event.target.value);
                  setError(null);
                }}
              />
              <button type="submit" className="context-custom-apply" data-testid="next-context-apply">
                {t(lang, 'ctx_custom_apply')}
              </button>
            </form>
            {error ? <div className="context-custom-error">{error}</div> : null}
            <button
              type="button"
              className="model-menu-item"
              data-testid="next-context-restore"
              onClick={() => { void pick(null); }}
            >
              {t(lang, 'ctx_restore')}
            </button>
          </div>
        ) : null}
      </div>
  );
}
