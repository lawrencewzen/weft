import { useState } from 'react';
import type { components } from '../../../src/v2/contract.gen';
import type { Lang } from '../data/lang';
import { t } from '../i18n';
import { Markdown } from './Markdown';

type Item = components['schemas']['ThreadItemSystemNote'];

export function SystemNote({ item, lang = 'zh' }: { item: Item; lang?: Lang }) {
  const [expanded, setExpanded] = useState(false);

  if (item.noteKind === 'handoff') {
    return (
      <div
        className="handoff-divider-container"
        data-testid="next-item-system-note"
        data-role="system"
        data-kind="handoff"
        data-id={item.id}
      >
        <div className="handoff-divider-bar" data-testid="next-handoff-divider">
          <span className="handoff-divider-line" />
          <span className="handoff-divider-title" data-testid="next-handoff-title">
            {t(lang, 'handoff_new_context')}
          </span>
          <span className="handoff-divider-line" />
          {item.detail ? (
            <button
              type="button"
              className="handoff-detail-toggle"
              data-testid="next-handoff-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              <span>{t(lang, 'handoff_details')}</span>
              <svg
                className={`handoff-chevron icon${expanded ? ' is-open' : ''}`}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          ) : null}
        </div>
        {expanded && item.detail ? (
          <div className="handoff-detail-body" data-testid="next-handoff-detail">
            <Markdown
              text={item.detail}
              copyLabel={t(lang, 'copy_code')}
              copiedLabel={t(lang, 'copied')}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="handoff-note msg-side-agent"
      data-testid="next-item-system-note"
      data-role="system"
      data-kind={item.noteKind}
      data-id={item.id}
    >
      <span>{item.text}</span>
    </div>
  );
}
