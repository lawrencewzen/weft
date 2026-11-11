// Run records for the server log, taken from what the conversation watch already yields.
// It looks at the SSE events one watch update produced, plus the Pi view they came from.
// It logs ids, names, durations, token counts and error text. It never logs message text,
// prompts, tool arguments or tool output.
import { log as defaultLog } from '../core/log.mjs';
import { reportedUsage } from './usage.mjs';

export const SLOW_TOOL_MS = 10_000;

function short(text, max = 300) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function numberOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function createRunLog({ log = defaultLog, now = Date.now } = {}) {
  const tools = new Map();
  const compactions = new Map();
  const failureKeys = new Map();

  function modelCall(cid, messageId, view) {
    const entry = (view?.entries || []).find((e) => e?.kind === 'pi.assistant' && String(e.id) === String(messageId));
    const message = entry?.model?.[0];
    if (!message) return;
    const usage = reportedUsage(message);
    const started = numberOrUndefined(message.timestamp);
    const ms = started != null && started > 0 && now() >= started ? now() - started : undefined;
    const fields = {
      cid,
      provider: message.provider,
      model: message.model,
      ms,
      inputTokens: numberOrUndefined(usage?.input),
      outputTokens: numberOrUndefined(usage?.output),
      stopReason: message.stopReason,
    };
    if (message.stopReason === 'error') {
      log.error('WEFT_LLM', short(message.errorMessage || 'model call failed'), fields);
    } else {
      log.info('WEFT_LLM', 'model call', fields);
    }
  }

  function toolEnd(cid, tool) {
    const key = `${cid}:${tool?.id}`;
    const began = tools.get(key);
    tools.delete(key);
    const ms = began ? now() - began.at : undefined;
    const failed = tool?.status === 'error';
    const fields = { cid, tool: tool?.name || began?.name, ms, error: failed };
    if (failed) log.warn('WEFT_TOOL', 'tool failed', fields);
    else if (ms != null && ms > SLOW_TOOL_MS) log.info('WEFT_TOOL', 'slow tool', fields);
  }

  function compactionState(cid, view, snapshot) {
    const live = view?.docs?.['pi.live'];
    const running = Array.isArray(live?.compactions) ? live.compactions : [];
    const failure = live?.compactionFailure;
    const known = compactions.get(cid) || new Map();
    const seen = new Set();
    for (const row of running) {
      const id = String(row?.taskId);
      seen.add(id);
      if (known.has(id)) continue;
      known.set(id, { at: now(), trigger: row?.trigger });
      if (!snapshot) log.info('WEFT_COMPACTION', 'compaction started', { cid, trigger: row?.trigger, blocking: row?.blocking });
    }
    const failedId = failure ? String(failure.taskId) : '';
    for (const [id, info] of known) {
      if (seen.has(id)) continue;
      known.delete(id);
      if (id === failedId || snapshot) continue;
      log.info('WEFT_COMPACTION', 'compaction finished', { cid, trigger: info.trigger, ms: now() - info.at });
    }
    compactions.set(cid, known);
    const key = failure ? `${failure.taskId}|${failure.error}` : '';
    if (key && key !== failureKeys.get(cid) && !snapshot) {
      log.error('WEFT_COMPACTION', 'compaction failed', { cid, trigger: failure.trigger, error: short(failure.error) });
    }
    failureKeys.set(cid, key);
  }

  return {
    /** One watch update: its mapped SSE events and the view they came from. */
    observe(cid, view, events, { snapshot = false } = {}) {
      try {
        for (const ev of events || []) {
          const data = ev?.data;
          if (ev?.event === 'tool.start') {
            tools.set(`${cid}:${data?.tool?.id}`, { at: now(), name: data?.tool?.name });
          } else if (ev?.event === 'tool.end') {
            toolEnd(cid, data?.tool);
          } else if (ev?.event === 'message.done' && data?.role !== 'user') {
            modelCall(cid, data?.messageId, view);
          } else if (ev?.event === 'reset') {
            log.info('WEFT_HANDOFF', 'handoff completed', { cid });
          } else if (ev?.event === 'retry') {
            log.warn('WEFT_LLM', short(data?.reason || 'retrying'), { cid, attempt: data?.attempt, delayMs: data?.delayMs });
          } else if (ev?.event === 'error') {
            log.error('WEFT_RUN', short(data?.detail || data?.message || data?.reason || 'run failed'), { cid, code: data?.code, reason: data?.reason });
          }
        }
        compactionState(cid, view, snapshot);
      } catch {
        // logging must never break the watch
      }
    },
    forget(cid) {
      compactions.delete(cid);
      failureKeys.delete(cid);
      for (const key of [...tools.keys()]) if (key.startsWith(`${cid}:`)) tools.delete(key);
    },
  };
}
