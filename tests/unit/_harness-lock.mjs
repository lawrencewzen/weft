/** Serialize in-process Harness opens across test files in the same Node process. */
let tail = Promise.resolve();

export function withHarnessLock(fn) {
  const run = tail.then(fn, fn);
  tail = run.then(() => undefined, () => undefined);
  return run;
}
