import { useMemo, type MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import { copyText } from '../data/copyText';
import { pathChipFromEvent } from '../data/pathChip';
import { useRightActions } from '../data/rightPaneContext';
import { t } from '../i18n';
import { renderMarkdown } from '../markdown';
import { InlineChip } from './composer/SlashChip';

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
  const { openFile } = useRightActions();
  const label = t(lang, kind === 'handoff' ? 'slash_chip_handoff' : 'slash_chip_compact');
  const chip = <InlineChip label={label} kind={kind} testId="next-user-chip" />;
  const trimmed = instructions?.trim();

  const inlineHtml = useMemo(() => {
    if (!trimmed) return '';
    const html = renderMarkdown(trimmed, { copyLabel: t(lang, 'copy_code') });
    return html.replace(/^<p>/, '').replace(/<\/p>\s*$/, '');
  }, [trimmed, lang]);

  function onClick(event: MouseEvent<HTMLDivElement>) {
    const pathChip = pathChipFromEvent(event.target);
    if (pathChip) {
      event.preventDefault();
      openFile(pathChip.path, pathChip.line);
      return;
    }
    const btn = (event.target as HTMLElement | null)?.closest?.('.code-copy-btn');
    if (!btn || !(btn instanceof HTMLElement)) return;
    event.preventDefault();
    const card = btn.closest('.code-block-card');
    const code = card?.querySelector('pre.code-block-pre')?.textContent ?? '';
    const labelEl = btn.querySelector('[data-copy-label]');
    const copyLabel = t(lang, 'copy_code');
    const copiedLabel = t(lang, 'copied');
    const restore = () => {
      if (labelEl) labelEl.textContent = copyLabel;
    };
    const ok = () => {
      if (labelEl) labelEl.textContent = copiedLabel;
      window.setTimeout(restore, 1200);
    };
    void copyText(code).then((success) => {
      if (success) {
        ok();
      } else {
        restore();
      }
    });
  }

  return (
    <div
      className="msg-group msg-side-user user-cmd-group"
      data-testid="next-item-user"
      data-role="user"
      data-command={kind}
      data-id={id}
    >
      <div className="msg-body user-cmd-body" data-testid="next-markdown" onClick={onClick}>
        {chip}
        {trimmed ? (
          <span
            className="user-cmd-text"
            data-testid="next-user-cmd-text"
            dangerouslySetInnerHTML={{ __html: inlineHtml }}
          />
        ) : null}
      </div>
    </div>
  );
}
