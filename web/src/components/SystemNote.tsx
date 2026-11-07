import type { components } from '../../../src/v2/contract.gen';

type Item = components['schemas']['ThreadItemSystemNote'];

export function SystemNote({ item }: { item: Item }) {
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
