import type { IncomingMessage } from 'node:http';

export const LAUNCHER_ID = 'weft-open';
export const DEFAULT_IDLE_EXIT_MINUTES = 30;
const MAX_CHECK_INTERVAL_MS = 60_000;

export function launchedByOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.WEFT_LAUNCHED_BY || '').trim() === LAUNCHER_ID;
}

/** Idle minutes. Default 30; 0 disables exit. Fractional values are allowed for tests. */
export function resolveIdleExitMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.WEFT_IDLE_EXIT_MINUTES || '').trim();
  if (!raw) return DEFAULT_IDLE_EXIT_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_EXIT_MINUTES;
  return n;
}

export function idleCheckIntervalMs(idleMs: number): number {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return MAX_CHECK_INTERVAL_MS;
  return Math.max(1, Math.min(MAX_CHECK_INTERVAL_MS, idleMs / 4));
}

export type IdleWatcher = {
  touch(): void;
  trackConnection(req: IncomingMessage): void;
  start(): void;
  dispose(): void;
};

/**
 * Exit when the launcher started us and we stay idle for WEFT_IDLE_EXIT_MINUTES.
 * Idle means: no live Harness tasks, no long-lived connections, no HTTP since last activity.
 * Manual `npm start` does not set WEFT_LAUNCHED_BY, so this watcher never fires there.
 */
export function createIdleWatcher(opts: {
  hasActiveWork: () => boolean | Promise<boolean>;
  shutdown: () => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): IdleWatcher {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const enabled = launchedByOpen(env);
  const minutes = resolveIdleExitMinutes(env);
  const idleMs = minutes * 60_000;
  const tracked = new WeakSet<IncomingMessage>();

  let lastTouch = now();
  let connections = 0;
  let disposed = false;
  let started = false;
  let checking = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function touch(): void {
    lastTouch = now();
  }

  function trackConnection(req: IncomingMessage): void {
    if (tracked.has(req)) return;
    tracked.add(req);
    connections += 1;
    const onClose = (): void => {
      req.off('close', onClose);
      connections = Math.max(0, connections - 1);
      if (connections === 0) lastTouch = now();
    };
    req.on('close', onClose);
  }

  async function tick(): Promise<void> {
    if (disposed || checking || connections > 0) return;
    if (now() - lastTouch < idleMs) return;
    checking = true;
    try {
      const busy = await opts.hasActiveWork();
      if (disposed) return;
      if (busy) {
        lastTouch = now();
        return;
      }
      if (connections > 0) return;
      if (now() - lastTouch < idleMs) return;
      console.log('WEFT_IDLE_EXIT');
      opts.shutdown();
    } catch (err) {
      console.error(`WEFT_IDLE_CHECK ${err instanceof Error ? err.message : err}`);
    } finally {
      checking = false;
    }
  }

  function start(): void {
    if (disposed || started) return;
    started = true;
    lastTouch = now();
    if (!enabled || idleMs <= 0) return;
    timer = setInterval(() => {
      void tick();
    }, idleCheckIntervalMs(idleMs));
    timer.unref();
  }

  return {
    touch,
    trackConnection,
    start,
    dispose(): void {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
