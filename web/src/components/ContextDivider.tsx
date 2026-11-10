import { useState, type ReactNode } from 'react';
import type { Lang } from '../data/lang';
import { t } from '../i18n';
import { Markdown } from './Markdown';

export type ContextDividerKind = 'handoff' | 'compaction';

function CompactIcon() {
  return (
    <svg className="icon handoff-divider-icon" viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/** Shared divider shell: `line  [icon] title meta  line  [details]`. */
export function ContextDividerBar({
  testPrefix,
  children,
  action,
}: {
  testPrefix: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="handoff-divider-bar" data-testid={`next-${testPrefix}-divider`}>
      <span className="handoff-divider-line" />
      <span className="handoff-divider-label">{children}</span>
      <span className="handoff-divider-line" />
      {action}
    </div>
  );
}

/** The same divider while the work is still running: faint, with a small spinner. */
export function ContextDividerPending({ lang }: { lang: Lang }) {
  return (
    <div
      className="handoff-divider-container is-pending"
      data-testid="next-thread-compacting"
      data-kind="compaction"
      role="status"
    >
      <ContextDividerBar testPrefix="compaction-pending">
        <span className="run-spin" aria-hidden="true"><span /></span>
        <span className="handoff-divider-title">{t(lang, 'compacting_context')}</span>
      </ContextDividerBar>
    </div>
  );
}

export function ContextDivider({
  kind,
  id,
  lang,
  title,
  meta,
  detail,
  detailLabel,
}: {
  kind: ContextDividerKind;
  id: string;
  lang: Lang;
  title: string;
  /** Faint key info right of the title, written by the server. */
  meta?: string;
  /** Full text shown as Markdown on expand. */
  detail?: string;
  detailLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="handoff-divider-container"
      data-testid="next-item-system-note"
      data-role="system"
      data-kind={kind}
      data-id={id}
    >
      <ContextDividerBar
        testPrefix={kind}
        action={detail ? (
          <button
            type="button"
            className="handoff-detail-toggle"
            data-testid={`next-${kind}-toggle`}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <span>{detailLabel}</span>
            <svg
              className={`handoff-chevron icon${expanded ? ' is-open' : ''}`}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        ) : null}
      >
        {kind === 'compaction' ? <CompactIcon /> : null}
        <span className="handoff-divider-title" data-testid={`next-${kind}-title`}>{title}</span>
        {meta ? (
          <span className="handoff-divider-meta" data-testid={`next-${kind}-meta`}>{meta}</span>
        ) : null}
      </ContextDividerBar>
      {expanded && detail ? (
        <div className="handoff-detail-body" data-testid={`next-${kind}-detail`}>
          <Markdown
            text={detail}
            copyLabel={t(lang, 'copy_code')}
            copiedLabel={t(lang, 'copied')}
          />
        </div>
      ) : null}
    </div>
  );
}
