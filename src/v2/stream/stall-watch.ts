/** Per-conversation stall timers for the main run. No polling. */

import {
  DEFAULT_STALL_AFTER_MS,
  finiteTs,
  resolveStallAfterMs,
} from '../views/run.ts';

export type StallWatchOpts = {
  stallAfterMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type StallSyncInput = {
  running?: boolean;
  lastActivityAt?: unknown;
};

export type StallWatch = {
  retain(cid: string): void;
  release(cid: string): void;
  subscriberCount(cid: string): number;
  /** Replace the wanted timer for this conversation. */
  sync(cid: string, input: StallSyncInput | null | undefined): void;
  listen(fn: (cid: string) => void): () => void;
  timerCount(cid?: string): number;
  dispose(): void;
};

type ConvState = {
  retain: number;
  lastActivityAt: number;
  handle: unknown | null;
};

export function createStallWatch(opts: StallWatchOpts = {}): StallWatch {
  const stallAfterMs = opts.stallAfterMs ?? resolveStallAfterMs();
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  });
  const clearTimer = opts.clearTimer ?? ((handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
  const states = new Map<string, ConvState>();
  const listeners = new Set<(cid: string) => void>();
  let disposed = false;

  function stateOf(cid: string): ConvState {
    let state = states.get(cid);
    if (!state) {
      state = { retain: 0, lastActivityAt: 0, handle: null };
      states.set(cid, state);
    }
    return state;
  }

  function clearHandle(state: ConvState): void {
    if (state.handle == null) return;
    clearTimer(state.handle);
    state.handle = null;
  }

  function drop(cid: string): void {
    const state = states.get(cid);
    if (!state) return;
    clearHandle(state);
    states.delete(cid);
  }

  function fire(cid: string): void {
    if (disposed) return;
    for (const fn of listeners) {
      try {
        fn(cid);
      } catch (err) {
        console.error(`WEFT_V2_STALL ${cid}`, err);
      }
    }
  }

  function wantedLast(input: StallSyncInput | null | undefined): number | null {
    if (!input?.running) return null;
    const last = finiteTs(input.lastActivityAt);
    if (!last) return null;
    // Fire once the view would become stalled: now − last > stallAfterMs.
    if (last + stallAfterMs + 1 - now() <= 0) return null;
    return last;
  }

  function schedule(cid: string, state: ConvState, last: number): void {
    if (state.handle && state.lastActivityAt === last) return;
    clearHandle(state);
    const delay = Math.max(0, last + stallAfterMs + 1 - now());
    const handle = setTimer(() => {
      const current = states.get(cid);
      if (!current || current.handle !== handle) return;
      current.handle = null;
      fire(cid);
    }, delay);
    state.lastActivityAt = last;
    state.handle = handle;
  }

  return {
    retain(cid) {
      if (disposed || !cid) return;
      stateOf(cid).retain += 1;
    },
    release(cid) {
      if (!cid) return;
      const state = states.get(cid);
      if (!state) return;
      state.retain -= 1;
      if (state.retain > 0) return;
      drop(cid);
    },
    subscriberCount(cid) {
      return states.get(cid)?.retain || 0;
    },
    sync(cid, input) {
      if (disposed || !cid) return;
      const state = states.get(cid);
      if (!state || state.retain <= 0) {
        if (state) clearHandle(state);
        return;
      }
      const last = wantedLast(input);
      if (last == null) {
        clearHandle(state);
        state.lastActivityAt = 0;
        return;
      }
      schedule(cid, state, last);
    },
    listen(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    timerCount(cid) {
      if (cid) return states.get(cid)?.handle != null ? 1 : 0;
      let n = 0;
      for (const state of states.values()) {
        if (state.handle != null) n += 1;
      }
      return n;
    },
    dispose() {
      disposed = true;
      for (const cid of [...states.keys()]) drop(cid);
      listeners.clear();
    },
  };
}

export { DEFAULT_STALL_AFTER_MS, resolveStallAfterMs };
