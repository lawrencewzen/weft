/** Per-conversation stuck timers for running sub-agents. No polling. */

import {
  DEFAULT_STUCK_AFTER_MS,
  finiteTs,
  resolveStuckAfterMs,
  type SubagentLike,
} from '../views/subagents.ts';

export type TimerHandle = ReturnType<typeof setTimeout>;

export type StuckWatchOpts = {
  stuckAfterMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export type StuckWatch = {
  retain(cid: string): void;
  release(cid: string): void;
  subscriberCount(cid: string): number;
  /** Replace the wanted set for this conversation. Used when the caller has the full list. */
  sync(cid: string, agents: SubagentLike[] | null | undefined): void;
  /** Update timers for these agents only; leave the rest. */
  patch(cid: string, agents: SubagentLike[] | null | undefined): void;
  listen(fn: (cid: string) => void): () => void;
  timerCount(cid?: string): number;
  dispose(): void;
};

type AgentTimer = {
  lastActivityAt: number;
  handle: TimerHandle;
};

type ConvState = {
  retain: number;
  timers: Map<string, AgentTimer>;
};

function agentIdOf(agent: SubagentLike): string {
  return String(agent?.id || '');
}

export function createStuckWatch(opts: StuckWatchOpts = {}): StuckWatch {
  const stuckAfterMs = opts.stuckAfterMs ?? resolveStuckAfterMs();
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  });
  const clearTimer = opts.clearTimer ?? ((handle: TimerHandle) => {
    clearTimeout(handle);
  });
  const states = new Map<string, ConvState>();
  const listeners = new Set<(cid: string) => void>();
  let disposed = false;

  function stateOf(cid: string): ConvState {
    let state = states.get(cid);
    if (!state) {
      state = { retain: 0, timers: new Map() };
      states.set(cid, state);
    }
    return state;
  }

  function clearAll(cid: string): void {
    const state = states.get(cid);
    if (!state) return;
    for (const entry of state.timers.values()) clearTimer(entry.handle);
    state.timers.clear();
  }

  function drop(cid: string): void {
    clearAll(cid);
    states.delete(cid);
  }

  function fire(cid: string): void {
    if (disposed) return;
    for (const fn of listeners) {
      try {
        fn(cid);
      } catch (err) {
        console.error(`WEFT_V2_STUCK ${cid}`, err);
      }
    }
  }

  function wantedOf(agents: SubagentLike[] | null | undefined): Map<string, number> {
    const wanted = new Map<string, number>();
    const t = now();
    for (const agent of agents || []) {
      const id = agentIdOf(agent);
      if (!id) continue;
      if (String(agent.status || '') !== 'running') continue;
      const last = finiteTs(agent.lastActivityAt);
      if (!last) continue;
      // Fire once the view would become stuck: now − last > stuckAfterMs.
      if (last + stuckAfterMs + 1 - t <= 0) continue;
      wanted.set(id, last);
    }
    return wanted;
  }

  function schedule(cid: string, state: ConvState, id: string, last: number): void {
    const existing = state.timers.get(id);
    if (existing && existing.lastActivityAt === last) return;
    if (existing) {
      clearTimer(existing.handle);
      state.timers.delete(id);
    }
    const delay = Math.max(0, last + stuckAfterMs + 1 - now());
    const handle = setTimer(() => {
      const current = states.get(cid)?.timers.get(id);
      if (!current || current.handle !== handle) return;
      state.timers.delete(id);
      fire(cid);
    }, delay);
    state.timers.set(id, { lastActivityAt: last, handle });
  }

  function apply(
    cid: string,
    agents: SubagentLike[] | null | undefined,
    replace: boolean,
  ): void {
    if (disposed || !cid) return;
    const state = states.get(cid);
    if (!state || state.retain <= 0) {
      if (state) clearAll(cid);
      return;
    }
    const wanted = wantedOf(agents);
    if (replace) {
      for (const [id, entry] of state.timers) {
        const last = wanted.get(id);
        if (last != null && last === entry.lastActivityAt) continue;
        clearTimer(entry.handle);
        state.timers.delete(id);
      }
    } else {
      for (const agent of agents || []) {
        const id = agentIdOf(agent);
        if (!id) continue;
        if (wanted.has(id)) continue;
        const entry = state.timers.get(id);
        if (!entry) continue;
        clearTimer(entry.handle);
        state.timers.delete(id);
      }
    }
    for (const [id, last] of wanted) schedule(cid, state, id, last);
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
    sync(cid, agents) {
      apply(cid, agents, true);
    },
    patch(cid, agents) {
      apply(cid, agents, false);
    },
    listen(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    timerCount(cid) {
      if (cid) return states.get(cid)?.timers.size || 0;
      let n = 0;
      for (const state of states.values()) n += state.timers.size;
      return n;
    },
    dispose() {
      disposed = true;
      for (const cid of [...states.keys()]) drop(cid);
      listeners.clear();
    },
  };
}

export { DEFAULT_STUCK_AFTER_MS, resolveStuckAfterMs };
