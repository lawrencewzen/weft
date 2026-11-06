import type { components } from '../../../src/v2/contract.gen';

type Item = components['schemas']['ThreadItemSystemNote'];

function systemNoteTestId(kind: string): string {
  return kind === 'auto_continue' ? 'next-auto-continue-note' : 'next-item-system-note';
}

export function SystemNote({ item }: { item: Item }) {
  const testId = systemNoteTestId(item.noteKind);
  return (
    <div
      className="handoff-note msg-side-agent"
      data-testid={testId}
      data-role="system"
      data-kind={item.noteKind}
      data-id={item.id}
    >
      <span>{item.text}</span>
    </div>
  );
}
