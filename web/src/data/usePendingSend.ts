import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { countUserText, pendingItem, settlePending, waitingForAgent, type PendingUser } from './pendingSend';
import type { ThreadItem } from './store';

type Send = (text: string, requestId: string) => Promise<unknown>;

/**
 * Optimistic send: the user message goes on screen before the request resolves, and the
 * 「思考中」row takes over until the server thread (or the run state) has something to show.
 */
export function usePendingSend(items: readonly ThreadItem[], send: Send) {
  const [pending, setPending] = useState<PendingUser[]>([]);
  const itemsRef = useRef<readonly ThreadItem[]>(items);
  itemsRef.current = items;

  useEffect(() => {
    if (!pending.length) return;
    const next = settlePending(pending, items);
    if (next.length !== pending.length) setPending(next);
  }, [items, pending]);

  const sendWithPending = useCallback(async (text: string, requestId: string) => {
    const entry: PendingUser = {
      key: requestId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      baseline: countUserText(itemsRef.current, text),
    };
    setPending((prev) => [...prev, entry]);
    try {
      return await send(text, requestId);
    } catch (err) {
      setPending((prev) => prev.filter((item) => item.key !== entry.key));
      throw err;
    }
  }, [send]);

  const shown = useMemo<ThreadItem[]>(() => pending.map(pendingItem), [pending]);

  return { pending: shown, sending: pending.length > 0, send: sendWithPending };
}

export { waitingForAgent };
