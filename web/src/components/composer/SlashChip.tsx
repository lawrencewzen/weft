import type { Lang } from '../../data/lang';
import type { SlashChip } from '../../data/slashCommand';
import { t } from '../../i18n';

export function chipLabel(lang: Lang, chip: SlashChip): string {
  if (chip.kind === 'skill') return chip.name;
  if (chip.kind === 'compact') return t(lang, 'slash_chip_compact');
  return t(lang, chip.kind === 'handoff' ? 'slash_chip_handoff' : 'slash_chip_schedule');
}

/** The rounded block at the start of the input, and at the start of a chat bubble. */
export function InlineChip({
  label,
  kind,
  testId,
  flash = false,
  title,
}: {
  label: string;
  kind: SlashChip['kind'];
  testId: string;
  flash?: boolean;
  title?: string;
}) {
  return (
    <span
      className={`slash-chip${flash ? ' is-flash' : ''}`}
      data-testid={testId}
      data-kind={kind}
      data-flash={flash ? 'true' : undefined}
      title={title}
    >
      {label}
    </span>
  );
}
