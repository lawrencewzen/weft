// T111-2: a model stream that goes quiet after the response started is cut off, so Pi Durable's
// own error path and `retry` policy take over. Pi's `stream.timeoutMs` only reaches the SDK
// request timeout and does not stop a body that stalls midway; neither pi-ai nor Pi Durable has
// a stream idle timeout for HTTP APIs. This is a fetch wrapper, not a runtime: no retry loop,
// no scheduling, no checkpoint. The error text carries "timeout", which Pi's classifier retries.
export const DEFAULT_STREAM_IDLE_MS = 120_000;
/** Marker in the error text. `src/v2/phrases/run-error.ts` maps it to a sentence. */
export const STREAM_IDLE_MARKER = 'Model stream idle timeout';

function createModelIdleError(idleMs) {
  return new Error(`${STREAM_IDLE_MARKER}: no data for ${idleMs}ms`);
}

export function streamIdleMs(env = process.env) {
  const n = Number(env?.WEFT_STREAM_IDLE_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_STREAM_IDLE_MS;
}

/**
 * Wrap a fetch so the response body fails when no chunk arrives for `idleMs`.
 * The clock starts when the response (headers) arrives and restarts on every chunk, thinking
 * included. Waiting for the connection or first byte of headers is left to the caller's timeout.
 * A caller abort passes through unchanged, so it still reads as aborted.
 */
export function withIdleTimeout(baseFetch, idleMs) {
  const base = baseFetch || globalThis.fetch;
  return async function idleFetch(input, init) {
    const response = await base(input, init);
    if (!response.body) return response;
    const reader = response.body.getReader();
    let timer = null;
    let timedOut = false;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const body = new ReadableStream({
      start(controller) {
        const arm = () => {
          clear();
          timer = setTimeout(() => {
            timedOut = true;
            const error = createModelIdleError(idleMs);
            reader.cancel(error).catch(() => {});
            try { controller.error(error); } catch { /* already closed */ }
          }, idleMs);
        };
        arm();
        (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (timedOut) return;
              if (done) {
                clear();
                controller.close();
                return;
              }
              arm();
              controller.enqueue(value);
            }
          } catch (error) {
            clear();
            if (!timedOut) controller.error(error);
          }
        })();
      },
      cancel(reason) {
        clear();
        return reader.cancel(reason);
      },
    }, { highWaterMark: 0 });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

// APIs that must not get `options.fetch`: google-generative-ai and google-vertex throw
// "Custom fetch is not supported"; bedrock-converse-stream uses the AWS SDK and ignores it.
// They keep pi-ai's own timeouts, with no idle timeout of ours.
export const STREAM_IDLE_SKIP_APIS = new Set(['google-generative-ai', 'google-vertex', 'bedrock-converse-stream']);

/** Provider whose `stream` / `streamSimple` run with the idle-timeout fetch. */
export function withStreamIdle(provider, { env = process.env } = {}) {
  if (!provider) return provider;
  const wrap = (fn, target) => (model, context, options) => (STREAM_IDLE_SKIP_APIS.has(model?.api)
    ? fn.call(target, model, context, options)
    : fn.call(target, model, context, {
      ...options,
      fetch: withIdleTimeout(options?.fetch, streamIdleMs(env)),
    }));
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'stream' || prop === 'streamSimple') return typeof value === 'function' ? wrap(value, target) : value;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
