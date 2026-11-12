import type { Lang } from '../data/lang';
import { t } from '../i18n';
import { InlineChip } from './composer/SlashChip';
import { Markdown } from './Markdown';

export function UserCommandBubble({
  kind,
  instructions,
  lang,
  id,
}: {
  kind: 'handoff' | 'compaction';
  instructions?: string;
  lang: Lang;
  id?: string;
}) {
  const label = t(lang, kind === 'handoff' ? 'slash_chip_handoff' : 'slash_chip_compact');
  const chip = <InlineChip label={label} kind={kind} testId="next-user-chip" />;
  const trimmed = instructions?.trim();

  return (
    <div
      className="msg-group msg-side-user"
      data-testid="next-item-user"
      data-role="user"
      data-command={kind}
      data-id={id}
    >
      <Markdown
        text={trimmed || ''}
        copyLabel={t(lang, 'copy_code')}
        copiedLabel={t(lang, 'copied')}
        leading={chip}
      />
    </div>
  );
}
