import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  countUserText,
  pendingItem,
  settlePending,
  waitingForAgent,
  PENDING_TIMEOUT_MS,
  type SendEntry,
  type PendingUser,
} from './pendingSend';
import type { ThreadItem } from './store';

type Send = (text: string, requestId: string) => Promise<unknown>;

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

  // Show only what the server has not caught up with yet; the stored list is pruned after.
  const shown = useMemo(
    () => settlePending(pending, items, { sends: sends ?? null, now: Date.now() }),
    [pending, items, sends],
  );

  useEffect(() => {
    if (shown.length !== pending.length) setPending(shown);
  }, [shown, pending]);

  // Last resort for a send whose entry never arrives: drop it once the cap passes.
  useEffect(() => {
    const waits = pending
      .filter((entry) => entry.doneAt != null)
      .map((entry) => Math.max(0, entry.doneAt! + PENDING_TIMEOUT_MS - Date.now()));
    if (!waits.length) return;
    const timer = setTimeout(() => {
      setPending((prev) => settlePending(prev, itemsRef.current, {
        sends: sendsRef.current,
        now: Date.now(),
      }));
    }, Math.min(...waits) + 10);
    return () => clearTimeout(timer);
  }, [pending]);

  const sendWithPending = useCallback(async (text: string, requestId: string) => {
    const key = requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: PendingUser = {
      key,
      text,
      baseline: countUserText(itemsRef.current, text),
      doneAt: null,
    };
    setPending((prev) => [...prev, entry]);
    try {
      const result = await send(text, requestId);
      setPending((prev) => prev.map((item) => (
        item.key === key ? { ...item, doneAt: Date.now() } : item
      )));
      return result;
    } catch (err) {
      setPending((prev) => prev.filter((item) => item.key !== key));
      throw err;
    }
  }, [send]);

  const pendingItems = useMemo<ThreadItem[]>(() => shown.map(pendingItem), [shown]);

  return { pending: pendingItems, sending: shown.length > 0, send: sendWithPending };
}

export { waitingForAgent };
