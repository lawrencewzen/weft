/**
 * A clock for the Harness (`now` and `setTimer`). Time is real time plus an offset that `advance()`
 * moves forward. Short timers (pacing inside a run) stay real. Long ones, such as a task's sleep,
 * wait in a list until `advance()` passes their time, then fire.
 */
export function createFakeClock(start = Date.now(), { realBelowMs = 2000 } = {}) {
  let offset = start - Date.now();
  const timers = new Set();
  const now = () => Date.now() + offset;
  function setTimer(callback, delayMs) {
    if (!(delayMs > realBelowMs)) {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    }
    const timer = { due: now() + delayMs, callback };
    timers.add(timer);
    return () => timers.delete(timer);
  }
  function advance(ms) {
    offset += ms;
    const current = now();
    for (const timer of [...timers]) {
      if (timer.due > current) continue;
      timers.delete(timer);
      timer.callback();
    }
  }
  return { now, setTimer, advance, pending: () => timers.size };
}
