import type { ConversationSend, ThreadItem } from './store';

/** One user message that is on screen but not yet confirmed by the server thread. */
export type PendingUser = {
  /** React key / dedupe key from the send requestId. */
  key: string;
  text: string;
  /** How many server items already had this exact text when we sent it. */
  baseline: number;
  /** When POST /messages resolved, or null while it is still in flight. */
  doneAt: number | null;
};

/** Where one send landed, as `ConversationView.sends` reports it. */
export type SendEntry = ConversationSend;

export type SettleOptions = {
  /** `ConversationView.sends`: requestId → entry of every recent send. */
  sends?: readonly SendEntry[] | null;
  /** Current time in ms; only used by the timeout rule. */
  now?: number;
  /** How long after a resolved send we stop waiting for the server item. */
  timeoutMs?: number;
};

/**
 * Last resort: a resolved send whose entry never shows up (and whose submission is
 * still reported as running) must not sit on screen forever.
 */
export const PENDING_TIMEOUT_MS = 10_000;

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
 * Same-text sends are told apart by order: the i-th still-pending send of one text matches
 * the (baseline + i)-th server item of that text, so an older identical message never clears
 * a newer send and two identical sends do not collapse into one.
 */
function caughtUpByText(pending: readonly PendingUser[], items: readonly ThreadItem[]): Set<string> {
  const done = new Set<string>();
  const seen = new Map<string, number>();
  for (const entry of pending) {
    const text = entry.text.trim();
    const index = seen.get(text) ?? 0;
    seen.set(text, index + 1);
    if (countUserText(items, text) > entry.baseline + index) done.add(entry.key);
  }
  return done;
}

/**
 * Did the server thread catch up with this send?
 *
 * 1. By requestId: the server reports, for each send, the entry it wrote. The entry may
 *    render as a user bubble, a subagent-report card or a system note, so we settle on the
 *    entry id and never look at the text.
 * 2. By text: fallback for a send the server no longer reports (older than its window).
 * 3. After PENDING_TIMEOUT_MS once the POST resolved.
 */
export function settlePending(
  pending: readonly PendingUser[],
  items: readonly ThreadItem[],
  opts: SettleOptions = {},
): PendingUser[] {
  if (!pending.length) return [];
  const { sends = null, now = 0, timeoutMs = PENDING_TIMEOUT_MS } = opts;
  const ids = new Set(items.map((item) => item.id));
  const byText = caughtUpByText(pending, items);
  const byRequest = new Map<string, SendEntry>();
  for (const send of sends || []) byRequest.set(send.requestId, send);
  return pending.filter((entry) => {
    const send = byRequest.get(entry.key);
    if (send) {
      // The server already told us which entry this send became.
      if (send.entryId) {
        if (ids.has(send.entryId)) return false;
      } else if (send.dropped) {
        // Withdrawn while still queued: no entry will ever appear.
        return false;
      }
    }
    if (byText.has(entry.key)) return false;
    return !(entry.doneAt != null && now - entry.doneAt >= timeoutMs);
  });
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
