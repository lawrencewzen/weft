import type { components } from '../../../src/v2/contract.gen';
import type { Lang } from '../data/lang';
import { t } from '../i18n';
import { ContextDivider } from './ContextDivider';

type Item = components['schemas']['ThreadItemSystemNote'];

export function SystemNote({ item, lang }: { item: Item; lang: Lang }) {
  if (item.noteKind === 'handoff') {
    return (
      <ContextDivider
        kind="handoff"
        id={item.id}
        lang={lang}
        title={t(lang, 'handoff_new_context')}
        detail={item.detail}
        detailLabel={t(lang, 'handoff_details')}
      />
    );
  }

  if (item.noteKind === 'compaction') {
    return (
      <ContextDivider
        kind="compaction"
        id={item.id}
        lang={lang}
        title={t(lang, 'compaction_title')}
        meta={item.text}
        detail={item.detail}
        detailLabel={t(lang, 'compaction_details')}
      />
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
