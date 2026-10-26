import { useMemo, type MouseEvent } from 'react';
import type { components } from '../../../src/v2/contract.gen';
import { pathChipFromEvent } from '../data/pathChip';
import { useRightPane } from '../data/rightPaneContext';
import { pathResolver, renderMarkdown } from '../markdown';

type PathRef = components['schemas']['PathRef'];

type Props = {
  text: string;
  pathRefs?: PathRef[];
  copyLabel: string;
  copiedLabel: string;
};

export function Markdown({ text, pathRefs, copyLabel, copiedLabel }: Props) {
  const { openFile } = useRightPane();
  const html = useMemo(
    () => renderMarkdown(text, { resolvePath: pathResolver(pathRefs), copyLabel }),
    [text, pathRefs, copyLabel],
  );

  function onClick(event: MouseEvent<HTMLDivElement>) {
    const chip = pathChipFromEvent(event.target);
    if (chip) {
      event.preventDefault();
      openFile(chip.path, chip.line);
      return;
    }
    const btn = (event.target as HTMLElement | null)?.closest?.('.code-copy-btn');
    if (!btn || !(btn instanceof HTMLElement)) return;
    event.preventDefault();
    const card = btn.closest('.code-block-card');
    const code = card?.querySelector('pre.code-block-pre')?.textContent ?? '';
    const label = btn.querySelector('[data-copy-label]');
    const restore = () => {
      if (label) label.textContent = copyLabel;
    };
    const ok = () => {
      if (label) label.textContent = copiedLabel;
      window.setTimeout(restore, 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(ok, restore);
    } else {
      restore();
    }
  }

  return (
    <div
      className="msg-body"
      data-testid="next-markdown"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
