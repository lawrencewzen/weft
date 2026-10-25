import type { components } from '../../../src/v2/contract.gen';

type Item = components['schemas']['ThreadItemSystemNote'];

export function SystemNote({ item }: { item: Item }) {
  const testId = item.noteKind === 'auto_continue' ? 'next-auto-continue-note' : 'next-item-system-note';
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
