import type { components } from '../../../src/v2/contract.gen';
import type { Lang } from '../data/lang';
import { t } from '../i18n';
import { ContextDivider } from './ContextDivider';
import { UserCommandBubble } from './UserCommandBubble';

export type SystemNoteRequest = {
  by?: 'user' | 'model';
  instructions?: string;
};

export type SystemNoteItem = components['schemas']['ThreadItemSystemNote'] & {
  request?: SystemNoteRequest;
};

export function SystemNote({ item, lang }: { item: SystemNoteItem; lang: Lang }) {
  const isUser = item.request?.by === 'user';
  const userBubble = isUser ? (
    <UserCommandBubble
      kind={item.noteKind === 'handoff' ? 'handoff' : 'compaction'}
      instructions={item.request?.instructions}
      lang={lang}
      id={`cmd:${item.id}`}
    />
  ) : null;

  if (item.noteKind === 'handoff') {
    return (
      <>
        {userBubble}
        <ContextDivider
          kind="handoff"
          id={item.id}
          lang={lang}
          title={t(lang, 'handoff_new_context')}
          detail={item.detail}
          detailLabel={t(lang, 'handoff_details')}
        />
      </>
    );
  }

  if (item.noteKind === 'compaction') {
    return (
      <>
        {userBubble}
        <ContextDivider
          kind="compaction"
          id={item.id}
          lang={lang}
          title={t(lang, 'compaction_title')}
          meta={item.text}
          detail={item.detail}
          detailLabel={t(lang, 'compaction_details')}
        />
      </>
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
