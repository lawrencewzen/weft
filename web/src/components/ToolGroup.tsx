import { useEffect, useState } from 'react';
import type { Lang } from '../data/lang';
import type { ThreadItem, ToolCall } from '../data/store';
import { formatElapsed, t } from '../i18n';
import { ToolRow } from './ToolRow';

const TOOL_GROUP_PREVIEW = 8;

type Item = Extract<ThreadItem, { kind: 'tool_group' }>;

type Props = {
  item: Item;
  toolsById: Record<string, ToolCall>;
  lang: Lang;
  onLoadOutput: (toolId: string) => Promise<{ text: string }>;
};

export function ToolGroup({ item, toolsById, lang, onLoadOutput }: Props) {
  const [open, setOpen] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const tools = item.toolIds.map((id) => toolsById[id]).filter((tool): tool is ToolCall => Boolean(tool));
  const hidden = !showOlder && tools.length > TOOL_GROUP_PREVIEW ? tools.length - TOOL_GROUP_PREVIEW : 0;
  const visible = hidden ? tools.slice(-TOOL_GROUP_PREVIEW) : tools;
  const spinning = item.summary.running || item.live;
  const realFailed = item.summary.failed > 0 && !spinning;
  const thinking = item.live && !item.summary.running
    ? `${t(lang, 'tool_sum_join')}${t(lang, 'pending_thinking')}`
    : '';
  const groupClass = [
    'tool-group',
    open ? 'is-open' : '',
    spinning ? 'is-running' : '',
    item.live ? 'is-live' : '',
    realFailed ? 'is-failed' : '',
  ].filter(Boolean).join(' ');
  const olderKey = hidden === 1 ? 'tool_group_older_one' : 'tool_group_older';

  useEffect(() => {
    if (item.live) setSeenAt((prev) => prev ?? Date.now());
    else setSeenAt(null);
  }, [item.live, item.id]);

  useEffect(() => {
    if (!item.live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [item.live]);

  const elapsed = item.live && seenAt != null ? formatElapsed(now - seenAt) : null;

  return (
    <div className={groupClass} data-testid="next-tool-group" data-id={item.id} data-live={item.live ? 'true' : 'false'}>
      <button
        type="button"
        className="tool-group-summary"
        data-testid="next-tool-group-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {spinning ? <span className="tool-group-spin" data-testid="next-tool-group-spinner" aria-hidden="true" /> : null}
        <span className="tool-group-text" data-testid="next-tool-group-text">{item.summary.text}{thinking}</span>
        {item.summary.failed > 0 ? (
          <span className="tool-group-fail" data-testid="next-tool-group-fail">
            {t(lang, 'tool_fail_count', { n: item.summary.failed })}
          </span>
        ) : null}
        {elapsed ? (
          <span className="pending-elapsed" data-testid="next-tool-group-elapsed">{elapsed}</span>
        ) : null}
        <svg className="tool-group-chevron icon" viewBox="0 0 24 24" aria-hidden="true">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      <div className="tool-group-list" data-testid="next-tool-group-list">
        {hidden > 0 ? (
          <button
            type="button"
            className="tool-group-older"
            data-testid="next-tool-group-older"
            onClick={() => setShowOlder(true)}
          >
            {t(lang, olderKey, { n: hidden })}
          </button>
        ) : null}
        {visible.map((tool) => (
          <ToolRow key={tool.id} tool={tool} lang={lang} onLoadOutput={onLoadOutput} />
        ))}
      </div>
    </div>
  );
}
