/** Live `schedules` topic: one `schedule` entity per scheduled task. */

import type { components } from '../contract.gen.ts';
import type { Entity, EventHub } from './hub.ts';
import { log as serverLog, logLine } from '../../core/log.mjs';

export const SCHEDULES_TOPIC = 'schedules';
export const COALESCE_MS = 50;

type Schedule = components['schemas']['Schedule'];

export type SchedulesTopicOpts = {
  load?: () => Promise<Schedule[]>;
  coalesceMs?: number;
  log?: (line: string) => void;
};

export type SchedulesTopic = {
  notify(): void;
  subscriberActive(): boolean;
  dispose(): void;
};

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function entitiesFromSchedules(list: Schedule[]): Entity[] {
  return list.map((schedule) => ({ entity: 'schedule', id: schedule.id, value: schedule }));
}

export function attachSchedulesTopic(hub: EventHub, opts: SchedulesTopicOpts = {}): SchedulesTopic {
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  const log = opts.log ?? ((line: string) => {
    logLine('debug', line);
  });
  let last = new Map<string, Schedule>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let disposed = false;
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = tail.then(fn, fn) as Promise<T>;
    tail = run.then(() => {}, () => {});
    return run;
  }

  async function load(): Promise<Schedule[]> {
    return opts.load ? opts.load() : [];
  }

  function mapOf(list: Schedule[]): Map<string, Schedule> {
    return new Map(list.map((schedule) => [schedule.id, schedule]));
  }

  async function publishDiff(): Promise<void> {
    if (disposed || !active) return;
    let list: Schedule[];
    try {
      list = await load();
    } catch (err) {
      serverLog.error('WEFT_V2_SCHEDULES_SNAPSHOT', '', err);
      return;
    }
    if (disposed || !active) return;
    const next = mapOf(list);
    for (const id of last.keys()) {
      if (!next.has(id)) hub.publish(SCHEDULES_TOPIC, { event: 'remove', entity: 'schedule', id });
    }
    for (const [id, value] of next) {
      if (jsonEq(last.get(id), value)) continue;
      hub.publish(SCHEDULES_TOPIC, { event: 'upsert', entity: 'schedule', id, value });
    }
    last = next;
  }

  function clearCoalesce(): void {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  hub.register(SCHEDULES_TOPIC, {
    async snapshot() {
      const list = await enqueue(async () => {
        const loaded = await load();
        last = mapOf(loaded);
        return loaded;
      });
      return entitiesFromSchedules(list);
    },
    onFirstSubscribe() {
      if (disposed || active) return;
      active = true;
      log('WEFT_V2_SCHEDULES_SUB');
    },
    onLastUnsubscribe() {
      if (!active) return;
      active = false;
      clearCoalesce();
      last = new Map();
      log('WEFT_V2_SCHEDULES_UNSUB');
    },
  });

  return {
    notify() {
      if (disposed || !active) return;
      if (coalesceMs <= 0) {
        void enqueue(() => publishDiff());
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void enqueue(() => publishDiff());
      }, coalesceMs);
      timer.unref?.();
    },
    subscriberActive() {
      return active;
    },
    dispose() {
      disposed = true;
      active = false;
      clearCoalesce();
    },
  };
}
