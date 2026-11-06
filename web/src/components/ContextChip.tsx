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
  onOpen?: () => void;
};

export function ContextChip({ lang, context, selected, onOpen }: Props) {
  const warn = contextIsWarn(context.level);
  const remain = contextRemainPercent(context);
  const ringRadius = 7.5;
  const circumference = 2 * Math.PI * ringRadius;
  const windowTokens = context.window || selected?.contextWindow || 0;

  return (
    <button
      type="button"
      className={`context-chip${warn ? ' is-warn' : ''}`}
      data-testid="next-context-chip"
      data-level={context.level}
      aria-haspopup="true"
      onClick={onOpen}
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
      <span className="context-chip-pct">{t(lang, 'ctx_percent', { n: context.percent })}</span>
    </button>
  );
}
