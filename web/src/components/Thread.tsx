import { useLayoutEffect, useRef } from 'react';
import type { Lang } from '../data/lang';
import type { ConversationActions } from '../data/useConversation';
import type { ThreadItem, ToolCall } from '../data/store';
import { t } from '../i18n';
import { AssistantMessage } from './AssistantMessage';
import { SubagentReport } from './SubagentReport';
import { SystemNote } from './SystemNote';
import { ToolGroup } from './ToolGroup';
import { UserMessage } from './UserMessage';

const STICK_PX = 80;

type Props = {
  items: ThreadItem[];
  toolsById: Record<string, ToolCall>;
  lang: Lang;
  running: boolean;
  actions: ConversationActions;
  stickNonce: number;
};

export function Thread({ items, toolsById, lang, running, actions, stickNonce }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!stick.current) return;
    const inner = el.querySelector('.thread-inner');
    const padBottom = inner ? parseFloat(getComputedStyle(inner).paddingBottom) || 0 : 0;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = maxScroll <= padBottom + 1 ? 0 : maxScroll;
  }, [items, stickNonce]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  }

  return (
    <div className="center-thread" data-testid="next-thread" ref={scroller} onScroll={onScroll}>
      {items.length === 0 ? (
        <div className="thread-empty">{t(lang, 'empty_chat_hint')}</div>
      ) : (
        <div className="thread-inner">
          {items.map((item) => {
            if (item.kind === 'user') return <UserMessage key={item.id} item={item} lang={lang} />;
            if (item.kind === 'assistant') {
              return (
                <AssistantMessage
                  key={item.id}
                  item={item}
                  lang={lang}
                  canContinue={item.truncated && !running}
                  onContinue={(requestId) => actions.continueRun(requestId)}
                />
              );
            }
            if (item.kind === 'tool_group') {
              return (
                <ToolGroup
                  key={item.id}
                  item={item}
                  toolsById={toolsById}
                  lang={lang}
                  onLoadOutput={actions.loadToolOutput}
                />
              );
            }
            if (item.kind === 'subagent_report') {
              return <SubagentReport key={item.id} item={item} lang={lang} />;
            }
            if (item.kind === 'system_note') {
              return <SystemNote key={item.id} item={item} />;
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}
