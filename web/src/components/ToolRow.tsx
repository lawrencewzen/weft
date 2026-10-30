import { useState, type MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import { useRightActions } from '../data/rightPaneContext';
import type { ToolCall } from '../data/store';
import { t, toolActionLabel } from '../i18n';

type Props = {
  tool: ToolCall;
  lang: Lang;
  onLoadOutput: (toolId: string) => Promise<{ text: string }>;
};

function KindIcon({ kind }: { kind: ToolCall['kind'] }) {
  if (kind === 'read') {
    return (
      <svg className="tool-kind-icon icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    );
  }
  if (kind === 'write') {
    return (
      <svg className="tool-kind-icon icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="12" y1="18" x2="12" y2="12" />
        <line x1="9" y1="15" x2="15" y2="15" />
      </svg>
    );
  }
  if (kind === 'edit') {
    return (
      <svg className="tool-kind-icon icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    );
  }
  if (kind === 'ls') {
    return (
      <svg className="tool-kind-icon icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    );
  }
  if (kind === 'grep') {
    return (
      <svg className="tool-kind-icon icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
    );
  }
  if (kind === 'bash') {
    return (
      <svg className="tool-kind-icon icon" viewBox="0 0 24 24" aria-hidden="true">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    );
  }
  return (
    <svg className="tool-kind-icon icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

export function ToolRow({ tool, lang, onLoadOutput }: Props) {
  const { openChangeDiff, openTerminal } = useRightActions();
  const realFail = tool.failure === 'real';
  const changeKind = tool.kind === 'write' || tool.kind === 'edit';
  const [toggled, setToggled] = useState<boolean | null>(null);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const open = toggled ?? (realFail && !changeKind);

  const showDiff = Boolean(tool.diff && (tool.diff.added != null || tool.diff.removed != null));
  const added = tool.diff?.added != null ? `+${tool.diff.added}` : '';
  const removed = tool.diff?.removed != null ? `−${tool.diff.removed}` : '';
  const pathClass = tool.heading.fromIntent ? 'tool-path is-intent' : 'tool-path';
  const rowClass = [
    'tool-row',
    tool.status === 'interrupted' ? 'tool-interrupted' : '',
    realFail ? 'is-failed' : '',
  ].filter(Boolean).join(' ');

  async function toggle() {
    if (changeKind) {
      if (tool.path) openChangeDiff(tool.path);
      return;
    }
    setToggled((value) => !(value ?? (realFail && !changeKind)));
  }

  async function showAll(event: MouseEvent) {
    event.stopPropagation();
    if (loading || fullText != null) return;
    setLoading(true);
    try {
      const out = await onLoadOutput(tool.id);
      setFullText(out.text);
    } finally {
      setLoading(false);
    }
  }

  const body = fullText ?? tool.output.preview;
  const truncated = fullText == null && tool.output.truncated;

  return (
    <div className="tool-row-wrapper">
      <div
        className={rowClass}
        data-testid="next-tool-row"
        data-tool={tool.kind}
        data-path={tool.path || ''}
        data-tool-id={tool.id}
        onClick={() => { void toggle(); }}
      >
        <div className="tool-main">
          <KindIcon kind={tool.kind} />
          <span className="tool-action">{toolActionLabel(lang, tool.kind)}</span>
          <span className={pathClass} data-testid="next-tool-row-path">{tool.heading.title}</span>
          {tool.heading.detail ? (
            <span className="tool-path-orig" data-testid="next-tool-row-orig">{tool.heading.detail}</span>
          ) : null}
          {tool.hint.text ? (
            <span
              className={`tool-row-hint${tool.hint.failed && tool.failure !== 'probe' ? ' is-failed' : ''}`}
              data-testid="next-tool-row-hint"
            >
              {tool.hint.text}
            </span>
          ) : null}
          <span className={`tool-diff-badge${showDiff ? '' : ' is-hidden'}`}>
            <span className="add" data-testid="next-tool-row-added">{added}</span>
            <span className="del" data-testid="next-tool-row-removed">{removed}</span>
          </span>
        </div>
        <div className="tool-meta">
          {tool.kind === 'bash' ? (
            <button
              type="button"
              className="tool-open-term"
              data-testid="next-tool-open-term"
              onClick={(event) => {
                event.stopPropagation();
                openTerminal(tool.id);
              }}
            >
              {t(lang, 'term_view_in')}
            </button>
          ) : null}
          {realFail ? (
            <span className="tool-row-status is-failed" data-testid="next-tool-row-status">{t(lang, 'tool_status_failed')}</span>
          ) : tool.status === 'interrupted' ? (
            <span className="tool-row-status is-interrupted" data-testid="next-tool-row-status">{t(lang, 'tool_status_interrupted')}</span>
          ) : null}
        </div>
        {!changeKind ? (
          <div className="tool-detail-card" data-testid="next-tool-row-detail" style={{ display: open ? 'block' : 'none' }}>
            {open && body ? (
              <div className={`tool-detail-block${realFail ? ' is-failed' : ''}`}>{body}</div>
            ) : null}
            {open && truncated ? (
              <button
                type="button"
                className="tool-detail-more"
                data-testid="next-tool-output-more"
                onClick={(event) => { void showAll(event); }}
              >
                {t(lang, 'tool_show_all')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
