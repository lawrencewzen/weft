import type { components } from '../../../src/v2/contract.gen';
import { pendingThreadImages } from '../../../src/v2/views/message-images';
import { recordLocalPastes } from './attachments';
import type { ConversationSend, ThreadItem } from './store';

type MessageImage = components['schemas']['MessageImage'];

export type SendMode = 'steer' | 'queue';

/** One user message that is on screen but not yet confirmed by the server thread. */
export type PendingUser = {
  /** React key / dedupe key from the send requestId. */
  key: string;
  text: string;
  images?: MessageImage[];
  files?: components['schemas']['SendMessageFile'][];
  pastes?: string[];
  /** How many server items already had this exact text when we sent it. */
  baseline: number;
  /** When POST /messages resolved, or null while it is still in flight. */
  doneAt: number | null;
  /** steer = 插话 (thread bubble); queue = 排队 (composer chip only). */
  mode?: SendMode;
};

export type QueueChip = {
  requestId: string;
  text: string;
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
 * Last resort for a send the server does not report at all: once the POST resolved, stop
 * waiting after this long. A send the server still lists as queued is never dropped by it.
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
 * Did the server thread catch up with this send? In this order:
 *
 * 1. The server reports this requestId with an entry (`sends`): settle as soon as that entry
 *    is on screen. The entry may render as a user bubble, a subagent-report card or a system
 *    note, so we match the id and never the text.
 * 2. The server reports it as still queued (`entryId: null`, `dropped: false`): keep showing
 *    it, however long the queue takes. A steer sent during a long tool call waits in Pi
 *    Durable's inbox until the batch ends; dropping it on a timer would make the message
 *    vanish and come back later.
 * 3. The server reports it as dropped (`dropped: true`): the input was withdrawn or failed
 *    before it landed, so nothing will appear.
 * 4. The server does not report this requestId at all (service restarted, or the send aged
 *    out of the window it keeps): fall back to the text rule, and to `PENDING_TIMEOUT_MS`
 *    after the POST resolved, because nothing else can tell us it landed.
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
      if (send.entryId) return !ids.has(send.entryId);
      // Still in the inbox: keep waiting; withdrawn: nothing will appear.
      return !send.dropped;
    }
    if (byText.has(entry.key)) return false;
    return !(entry.doneAt != null && now - entry.doneAt >= timeoutMs);
  });
}

export function sendModeOf(send: SendEntry | PendingUser | null | undefined): SendMode {
  return send?.mode === 'queue' ? 'queue' : 'steer';
}

/** Queue chips: inbox follow-ups that have not landed and were not withdrawn. */
export function queueChips(
  pending: readonly PendingUser[],
  sends: readonly SendEntry[] | null | undefined,
): QueueChip[] {
  const out: QueueChip[] = [];
  const seen = new Set<string>();
  for (const send of sends || []) {
    if (sendModeOf(send) !== 'queue' || send.dropped || send.entryId) continue;
    seen.add(send.requestId);
    out.push({ requestId: send.requestId, text: typeof send.text === 'string' ? send.text : '' });
  }
  for (const entry of pending) {
    if (sendModeOf(entry) !== 'queue' || seen.has(entry.key)) continue;
    out.push({ requestId: entry.key, text: entry.text });
  }
  return out;
}

/**
 * Rebuild in-flight steers/queues from the server `sends` list (refresh, or
 * a send that landed in this process before the client stored it).
 */
export function hydratePendingFromSends(
  pending: readonly PendingUser[],
  sends: readonly SendEntry[] | null | undefined,
): PendingUser[] {
  const have = new Set(pending.map((entry) => entry.key));
  const extra: PendingUser[] = [];
  for (const send of sends || []) {
    if (have.has(send.requestId) || send.dropped || send.entryId) continue;
    extra.push({
      key: send.requestId,
      text: typeof send.text === 'string' ? send.text : '',
      baseline: 0,
      doneAt: 0,
      mode: sendModeOf(send),
    });
  }
  return extra.length ? [...pending, ...extra] : pending as PendingUser[];
}

export function threadPending(pending: readonly PendingUser[]): PendingUser[] {
  return pending.filter((entry) => sendModeOf(entry) !== 'queue');
}

/** Render a pending send exactly like a confirmed user message. */
export function pendingItem(entry: PendingUser): ThreadItem {
  const images = pendingThreadImages(entry.images);
  const steered = entry.mode === 'steer';
  const files: components['schemas']['ThreadUserFile'][] = (entry.files || []).map((f) => ({
    path: f.path,
    name: f.name || f.path.split('/').pop() || f.path,
    bytes: f.bytes ?? 0,
  }));
  const pastes: components['schemas']['ThreadUserPaste'][] = (entry.pastes || []).map((p) => ({
    lines: p.split('\n').length,
    chars: p.length,
    preview: p.split('\n').slice(0, 8).join('\n'),
  }));
  if (entry.pastes?.length) {
    recordLocalPastes(`local:${entry.key}`, entry.pastes);
  }
  return {
    kind: 'user',
    id: `local:${entry.key}`,
    text: entry.text,
    pathRefs: [],
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
    ...(pastes.length ? { pastes } : {}),
    ...(steered ? { steered: true } : {}),
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
