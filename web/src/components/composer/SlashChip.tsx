import type { Lang } from '../../data/lang';
import type { SlashChip } from '../../data/slashCommand';
import { t } from '../../i18n';

export function chipLabel(lang: Lang, chip: SlashChip): string {
  if (chip.kind === 'skill') return chip.name;
  return t(lang, chip.kind === 'handoff' ? 'slash_chip_handoff' : 'slash_chip_schedule');
}

/** The rounded block at the start of the input, and at the start of a chat bubble. */
export function InlineChip({
  label,
  kind,
  testId,
}: {
  label: string;
  kind: SlashChip['kind'];
  testId: string;
}) {
  return (
    <span className="slash-chip" data-testid={testId} data-kind={kind}>
      {label}
    </span>
  );
}
