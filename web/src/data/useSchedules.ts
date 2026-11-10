import { useSession } from './session';
import { SCHEDULES_TOPIC, type Schedule } from './store';
import { useStoreTopic } from './useStoreTopic';

export type SchedulesState = {
  schedules: Schedule[];
  enabledCount: number;
  ready: boolean;
  status: ReturnType<typeof useSession>['status'];
};

export function useSchedules(): SchedulesState {
  const { store, status } = useSession();
  useStoreTopic(store, SCHEDULES_TOPIC);
  const schedules = store.schedules();
  const enabledCount = schedules.filter((s) => s.enabled).length;
  const ready = store.hasTopic(SCHEDULES_TOPIC);

  return { schedules, enabledCount, ready, status };
}
