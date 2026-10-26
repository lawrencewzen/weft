import type { ThreadItem } from './store';

/** One user message that is on screen but not yet confirmed by the server thread. */
export type PendingUser = {
  /** React key / dedupe key from the send requestId. */
  key: string;
  text: string;
  /** How many server items already had this exact text when we sent it. */
  baseline: number;
};

function textOf(item: ThreadItem): string {
  if (item.kind !== 'user') return '';
  return typeof item.text === 'string' ? item.text.trim() : '';
}

/** Number of confirmed user items with the same text, used to tell a match from an old copy. */
export function countUserText(items: readonly ThreadItem[], text: string): number {
  const want = text.trim();
  if (!want) return 0;
  let n = 0;
  for (const item of items) {
    if (textOf(item) === want) n += 1;
  }
  return n;
}

/**
 * Drop pending sends the server thread has caught up with. Same text is sent twice →
 * the count has to grow past the baseline, so an older identical message never clears it.
 */
export function settlePending(
  pending: readonly PendingUser[],
  items: readonly ThreadItem[],
): PendingUser[] {
  if (!pending.length) return [];
  return pending.filter((entry) => countUserText(items, entry.text) <= entry.baseline);
}

/** Render a pending send exactly like a confirmed user message. */
export function pendingItem(entry: PendingUser): ThreadItem {
  return {
    kind: 'user',
    id: `local:${entry.key}`,
    text: entry.text,
    pathRefs: [],
  } as ThreadItem;
}

/** The「思考中」row belongs under the last user message while the agent has not shown anything. */
export function waitingForAgent(
  items: readonly ThreadItem[],
  opts: { running: boolean; pending: boolean },
): boolean {
  if (opts.pending) return true;
  if (!opts.running) return false;
  const last = items[items.length - 1];
  return !last || last.kind === 'user';
}
