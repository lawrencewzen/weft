// Startup phase timing. The timer counts from process start (performance.now() is measured
// from performance.timeOrigin) and each mark closes one phase: its duration is the time since
// the previous mark, so the phases always add up to the total.
import { performance } from 'node:perf_hooks';

export const STARTUP_TAG = 'WEFT_STARTUP';

export function createStartupTimer({ now = () => performance.now() } = {}) {
  const phases = [];
  let last = 0;
  return {
    /** Close the phase `name` at the current time. Marking the same name twice adds up. */
    mark(name) {
      const t = now();
      const ms = Math.max(0, t - last);
      last = t;
      const existing = phases.find((p) => p.name === name);
      if (existing) existing.ms += ms;
      else phases.push({ name, ms });
      return ms;
    },
    /** { phases: { name: ms }, totalMs } in whole milliseconds; the phase sum differs from total only by rounding. */
    snapshot() {
      return {
        phases: Object.fromEntries(phases.map((p) => [p.name, Math.round(p.ms)])),
        totalMs: Math.round(last),
      };
    },
  };
}

/** The fields of the WEFT_STARTUP record: `<phase>Ms` per phase, `totalMs`, and the data scale. */
export function startupFields(snapshot, scale = {}) {
  const fields = {};
  for (const [name, ms] of Object.entries(snapshot.phases)) fields[`${name}Ms`] = ms;
  fields.totalMs = snapshot.totalMs;
  for (const [k, v] of Object.entries(scale)) if (v !== undefined) fields[k] = v;
  return fields;
}

export function logStartupSummary(logger, snapshot, scale) {
  logger.info(STARTUP_TAG, 'ready', startupFields(snapshot, scale));
}
