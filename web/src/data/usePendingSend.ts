import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  countUserText,
  hydratePendingFromSends,
  pendingItem,
  queueChips,
  settlePending,
  threadPending,
  waitingForAgent,
  PENDING_TIMEOUT_MS,
  type SendEntry,
  type PendingUser,
  type SendMode,
  type QueueChip,
} from './pendingSend';
import type { components } from '../../../src/v2/contract.gen';
import type { ThreadItem } from './store';

type MessageImage = components['schemas']['MessageImage'];
type Send = (text: string, requestId: string, images?: MessageImage[], mode?: SendMode) => Promise<unknown>;

/**
 * Optimistic send: the user message goes on screen before the request resolves, and the
 * 「思考中」row takes over until the server thread (or the run state) has something to show.
 *
 * `sends` is the server's answer to "which entry did my requestId become": the pending item
 * leaves the screen in the same render that shows the server item, so the two are never
 * visible together.
 */
export function usePendingSend(items: readonly ThreadItem[], send: Send, sends?: readonly SendEntry[] | null) {
  const [pending, setPending] = useState<PendingUser[]>([]);
  const itemsRef = useRef<readonly ThreadItem[]>(items);
  itemsRef.current = items;
  const sendsRef = useRef<readonly SendEntry[] | null>(sends ?? null);
  sendsRef.current = sends ?? null;

  const merged = useMemo(
    () => hydratePendingFromSends(pending, sends ?? null),
    [pending, sends],
  );

  // Show only what the server has not caught up with yet; the stored list is pruned after.
  const shown = useMemo(
    () => settlePending(merged, items, { sends: sends ?? null, now: Date.now() }),
    [merged, items, sends],
  );

  useEffect(() => {
    if (shown.length !== pending.length) setPending(shown);
  }, [shown, pending]);

  // Last resort for a send the server does not report at all; a queued one is kept.
  useEffect(() => {
    const waits = pending
      .filter((entry) => entry.doneAt != null)
      .map((entry) => Math.max(0, entry.doneAt! + PENDING_TIMEOUT_MS - Date.now()));
    if (!waits.length) return;
    const timer = setTimeout(() => {
      setPending((prev) => {
        const next = settlePending(prev, itemsRef.current, {
          sends: sendsRef.current,
          now: Date.now(),
        });
        // Same list (nothing settled, e.g. still queued): keep the state object so the
        // effect does not schedule another timer for a deadline that already passed.
        return next.length === prev.length ? prev : next;
      });
    }, Math.min(...waits) + 10);
    return () => clearTimeout(timer);
  }, [pending]);

  const sendWithPending = useCallback(async (
    text: string,
    requestId: string,
    images?: MessageImage[],
    mode?: SendMode,
  ) => {
    const key = requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: PendingUser = {
      key,
      text,
      images,
      baseline: countUserText(itemsRef.current, text),
      doneAt: null,
      mode,
    };
    setPending((prev) => [...prev, entry]);
    try {
      const result = await send(text, requestId, images, mode);
      setPending((prev) => prev.map((item) => (
        item.key === key ? { ...item, doneAt: Date.now() } : item
      )));
      return result;
    } catch (err) {
      setPending((prev) => prev.filter((item) => item.key !== key));
      throw err;
    }
  }, [send]);

  const dropLocal = useCallback((requestId: string) => {
    setPending((prev) => prev.filter((item) => item.key !== requestId));
  }, []);

  const thread = useMemo(() => threadPending(shown), [shown]);
  const pendingItems = useMemo<ThreadItem[]>(() => thread.map(pendingItem), [thread]);
  const queued = useMemo<QueueChip[]>(() => queueChips(shown, sends ?? null), [shown, sends]);

  return {
    pending: pendingItems,
    queue: queued,
    sending: thread.length > 0,
    send: sendWithPending,
    dropLocal,
  };
}

export { waitingForAgent };
