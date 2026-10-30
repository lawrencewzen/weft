import { useState } from 'react';
import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { focusSubagent } from '../data/focusSubagent';
import { t } from '../i18n';
import { Markdown } from './Markdown';
import { StatusIcon } from './StatusIcon';

type Item = components['schemas']['ThreadItemSubagentReport'];

export function SubagentReport({
  item,
  lang,
  conversationId,
}: {
  item: Item;
  lang: Lang;
  conversationId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const failed = item.reportKind === 'failed';
  const title = failed
    ? t(lang, 'subagent_report_failed', { name: item.name })
    : t(lang, 'subagent_report_answered', { name: item.name });
  const reason = failed ? item.body.replace(/\s+/g, ' ').trim().slice(0, 48) : '';

  return (
    <div
      className={`subagent-report msg-side-agent${open ? ' is-open' : ''}${failed ? ' is-failed' : ''}`}
      data-testid="next-item-subagent-report"
      data-kind="subagent-report"
      data-id={item.id}
    >
      <div className="subagent-report-head">
        <button
          type="button"
          className="subagent-report-summary"
          data-testid="next-subagent-report-summary"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <StatusIcon
            status={failed ? 'failed' : 'done'}
            size={14}
            className="subagent-report-icon"
            lang={lang}
            aria-hidden="true"
          />
          <span className="subagent-report-text">
            {title}
            {reason ? <span className="subagent-report-reason">{reason}</span> : null}
          </span>
          <svg className="subagent-report-chevron icon" viewBox="0 0 24 24" aria-hidden="true">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
        {item.subagentId && conversationId ? (
          <button
            type="button"
            className="subagent-report-open"
            data-testid="next-report-open"
            title={t(lang, 'subagent_open_title')}
            onClick={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              focusSubagent(item.subagentId as string);
            }}
          >
            {t(lang, 'subagent_open')}
          </button>
        ) : null}
      </div>
      <div className="subagent-report-body msg-body" data-testid="next-subagent-report-body">
        <Markdown
          text={item.body}
          copyLabel={t(lang, 'copy_code')}
          copiedLabel={t(lang, 'copied')}
        />
      </div>
    </div>
  );
}
