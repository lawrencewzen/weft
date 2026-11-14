// Structured local JSONL execution logger for scheduled tasks.
// Writes detailed per-run execution logs under `<dataDir>/logs/schedules/` and updates
// `schedule_runs` SQLite metadata (finish time, duration, tokens, tool counts, logFile).
// Never logs prompt/response/tool bodies into `service.log`.
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { withCancel } from '@earendil-works/chord/context';
import { formatTime, log } from '../core/log.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { isAutoContinueText, isPromptUserMessage } from './continuation.mjs';
import { textOf } from './events.mjs';
import { HANDOFF_REQUEST_KIND } from './handoff.mjs';
import { isSubagentReportText } from './subagent-report.mjs';
import { reportedUsage } from './usage.mjs';

const MAX_TEXT_BYTES = 64 * 1024;
const DEFAULT_MAX_RUNS = 50;
const MAX_ARRAY_ITEMS = 200;
const MAX_OBJECT_KEYS = 200;
const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|auth|cookie|credential|private[-_]?key/i;

function numId(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeSegment(value) {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'unknown').slice(0, 80);
}

function fileStamp(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  return date.toISOString().replace(/:/g, '-').replace(/\..+$/, 'Z');
}

export function relativeScheduleLogFile(scheduleId, runId, at) {
  return path.posix.join('logs', 'schedules', safeSegment(scheduleId), `${fileStamp(at)}-${safeSegment(runId)}.jsonl`);
}

function resolveLogPath(dataDir, relPath) {
  if (!dataDir || !relPath) return null;
  const parts = String(relPath).split('/').filter(Boolean);
  return path.join(dataDir, ...parts);
}

function formatTs(ms) {
  if (!Number.isFinite(ms)) return null;
  return formatTime(new Date(ms));
}

export function clipText(raw, maxBytes = MAX_TEXT_BYTES) {
  const clean = redactSecrets(String(raw ?? ''));
  const totalBytes = Buffer.byteLength(clean, 'utf8');
  if (totalBytes <= maxBytes) return { text: clean, truncated: false, bytes: totalBytes };

  const suffix = `\n… [truncated, ${totalBytes} bytes total]`;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = Math.max(0, maxBytes - suffixBytes);
  let lo = 0;
  let hi = clean.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(clean.slice(0, mid), 'utf8') <= budget) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) {
    const code = clean.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1;
  }
  return { text: clean.slice(0, lo) + suffix, truncated: true, bytes: totalBytes };
}

export function sanitizeValue(value, keyHint = '', depth = 0) {
  if (value == null) return value;
  if (typeof value === 'boolean' || typeof value === 'number') {
    return SECRET_KEY.test(keyHint) ? '[REDACTED]' : value;
  }
  if (typeof value === 'string') {
    if (SECRET_KEY.test(keyHint)) return '[REDACTED]';
    return clipText(value).text;
  }
  if (depth > 8) return '[nested]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, '', depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) out.push(`… [${value.length - MAX_ARRAY_ITEMS} more items]`);
    return out;
  }
  if (typeof value === 'object') {
    const isImagePart = (value.type === 'image' || String(value.mimeType || '').startsWith('image/'))
      && typeof value.data === 'string';
    const out = {};
    const entries = Object.entries(value);
    for (const [k, v] of entries.slice(0, MAX_OBJECT_KEYS)) {
      if (isImagePart && k === 'data') {
        out[k] = `[image omitted, ${v.length} chars]`;
      } else {
        out[k] = sanitizeValue(v, k, depth + 1);
      }
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    return out;
  }
  return clipText(String(value)).text;
}

function emptySummary({ trigger = 'scheduled', state = 'running' } = {}) {
  return {
    trigger,
    state,
    llmCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    compactions: 0,
    retries: 0,
    unavailableTools: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    models: [],
    tools: {},
  };
}

function describeTarget(schedule) {
  const t = schedule?.target;
  if (!t || typeof t !== 'object') return null;
  return {
    kind: t.kind,
    workspaceId: t.workspaceId ?? null,
    conversationId: t.conversationId ?? null,
  };
}

function addAssistantUsage(summary, message) {
  const u = reportedUsage(message);
  if (!u) return null;
  const input = Number(u.input) || 0;
  const output = Number(u.output) || 0;
  const cacheRead = Number(u.cacheRead) || 0;
  const cacheWrite = Number(u.cacheWrite) || 0;
  const totalTokens = Number(u.totalTokens) || (input + output + cacheRead + cacheWrite);
  const cost = typeof u.cost?.total === 'number' ? u.cost.total : 0;
  summary.inputTokens += input;
  summary.outputTokens += output;
  summary.cacheReadTokens += cacheRead;
  summary.cacheWriteTokens += cacheWrite;
  summary.totalTokens += totalTokens;
  summary.cost += cost;
  return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

function toolCallIdsOfEntry(entry) {
  const msg = entry?.model?.[0];
  const ids = new Set();
  for (const part of Array.isArray(msg?.content) ? msg.content : []) {
    if ((part?.type === 'toolCall' || part?.type === 'toolUse') && part.id) {
      ids.add(String(part.id));
    }
  }
  return ids;
}

function formatEntryRecord(entry, runState) {
  const entryId = String(entry.id);
  const byTaskId = entry.byTaskId ? String(entry.byTaskId) : undefined;
  const kind = String(entry.kind || '');

  if (kind === 'pi.user') {
    const msg = entry.model?.[0] || {};
    const raw = textOf(msg.content);
    const subtype = isAutoContinueText(raw)
      ? 'auto_continue'
      : isSubagentReportText(raw)
        ? 'subagent_report'
        : 'prompt';
    const ts = Number.isFinite(msg.timestamp) ? msg.timestamp : null;
    return {
      type: 'user_message',
      entryId,
      ts,
      at: formatTs(ts),
      byTaskId,
      subtype,
      text: clipText(raw).text,
    };
  }

  if (kind === 'pi.assistant') {
    const msg = entry.model?.[0] || {};
    const thinkingParts = [];
    const textParts = [];
    const toolCalls = [];
    for (const part of Array.isArray(msg.content) ? msg.content : []) {
      if (part?.type === 'thinking' && part.thinking) {
        thinkingParts.push(part.thinking);
      } else if (part?.type === 'text' && part.text) {
        textParts.push(part.text);
      } else if (part?.type === 'toolCall' || part?.type === 'toolUse') {
        const id = String(part.id || '');
        const name = String(part.name || '');
        const rawArgs = part.arguments ?? part.input ?? {};
        const args = sanitizeValue(rawArgs);
        toolCalls.push({ id, name, arguments: args });
        const cmd = typeof rawArgs?.command === 'string' ? clipText(rawArgs.command, 4096).text : undefined;
        if (id) runState.toolCallMeta.set(id, { name, command: cmd });
        runState.summary.toolCalls += 1;
        runState.summary.tools[name] = (runState.summary.tools[name] || 0) + 1;
      }
    }

    const modelName = msg.responseModel || msg.model || null;
    if (modelName && !runState.modelSet.has(String(modelName))) {
      runState.modelSet.add(String(modelName));
      runState.summary.models.push(String(modelName));
    }
    runState.summary.llmCalls += 1;
    const usage = addAssistantUsage(runState.summary, msg);
    const ts = Number.isFinite(msg.timestamp) ? msg.timestamp : null;
    const errText = msg.errorMessage ? clipText(msg.errorMessage, 4096).text : null;

    if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
      runState.lastAssistantFailure = errText || String(msg.stopReason);
    }

    const rec = {
      type: 'llm_call',
      entryId,
      ts,
      at: formatTs(ts),
      byTaskId,
      provider: msg.provider ?? null,
      model: modelName,
      requestedModel: msg.model ?? null,
      thinkingLevel: msg.thinkingLevel ?? null,
      durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : null,
      stopReason: msg.stopReason ?? null,
      errorMessage: errText,
      usage,
      text: textParts.length > 0 ? clipText(textParts.join('\n\n')).text : '',
      toolCalls,
    };
    if (thinkingParts.length > 0) rec.thinking = clipText(thinkingParts.join('\n\n')).text;
    return rec;
  }

  if (kind === 'pi.tool-result') {
    const msg = entry.model?.[0] || {};
    const toolCallId = String(msg.toolCallId || '');
    const meta = runState.toolCallMeta.get(toolCallId);
    const toolName = String(msg.toolName || meta?.name || '');
    const isError = Boolean(msg.isError);
    if (isError) runState.summary.toolErrors += 1;
    const rawOut = textOf(msg.content);
    const ts = Number.isFinite(msg.timestamp) ? msg.timestamp : null;
    const details = msg.details != null ? sanitizeValue(msg.details) : undefined;
    const command = meta?.command
      ?? (typeof msg.details?.command === 'string' ? clipText(msg.details.command, 4096).text : undefined);
    const rec = {
      type: 'tool_result',
      entryId,
      ts,
      at: formatTs(ts),
      byTaskId,
      toolCallId,
      toolName,
      isError,
      durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : null,
      output: clipText(rawOut).text,
    };
    if (command !== undefined) rec.command = command;
    if (typeof msg.details?.exitCode === 'number') rec.exitCode = msg.details.exitCode;
    if (details !== undefined) rec.details = details;
    if (Array.isArray(msg.nestedCalls) && msg.nestedCalls.length > 0) {
      rec.nestedCalls = msg.nestedCalls.slice(0, 50).map((c) => sanitizeValue(c));
    }
    return rec;
  }

  if (kind === 'pi.compaction') {
    runState.summary.compactions += 1;
    return {
      type: 'compaction',
      entryId,
      byTaskId,
      data: sanitizeValue(entry.data),
      head: entry.head ? sanitizeValue(entry.head) : undefined,
    };
  }

  if (kind === 'pi.retry' || kind.includes('retry')) {
    runState.summary.retries += 1;
    return {
      type: 'retry',
      kind,
      entryId,
      byTaskId,
      data: sanitizeValue(entry.data),
    };
  }

  if (kind === 'pi.diagnostic') {
    if (entry.data?.code === 'tool_unavailable') {
      runState.summary.unavailableTools += 1;
    }
    return {
      type: 'diagnostic',
      kind,
      entryId,
      byTaskId,
      data: sanitizeValue(entry.data),
    };
  }

  return {
    type: kind === HANDOFF_REQUEST_KIND ? 'handoff_request' : 'entry',
    kind,
    entryId,
    byTaskId,
    data: entry.data != null ? sanitizeValue(entry.data) : undefined,
    model: Array.isArray(entry.model) ? sanitizeValue(entry.model) : undefined,
  };
}

function isExternalUserBoundary(entry, startEntryId) {
  if (Number(entry.id) <= startEntryId || entry.kind !== 'pi.user') return false;
  const msg = entry.model?.[0];
  const text = textOf(msg?.content);
  return isPromptUserMessage({ role: 'user', kind: entry.data?.kind, text });
}

function sliceSettledEntries(allEntries, settled) {
  const startEntryId = Number(settled.entry);
  const out = [];
  if (settled.status === 'done' && settled.answer != null) {
    const answerId = Number(settled.answer);
    let pendingCallIds = null;
    for (const entry of allEntries) {
      const id = Number(entry.id);
      if (id < startEntryId) continue;
      if (id < answerId) {
        out.push(entry);
        continue;
      }
      if (id === answerId) {
        out.push(entry);
        pendingCallIds = toolCallIdsOfEntry(entry);
        continue;
      }
      if (pendingCallIds && pendingCallIds.size > 0 && entry.kind === 'pi.tool-result') {
        const callId = String(entry.model?.[0]?.toolCallId || '');
        if (pendingCallIds.has(callId)) {
          out.push(entry);
          pendingCallIds.delete(callId);
          continue;
        }
      }
      break;
    }
    return out;
  }

  for (const entry of allEntries) {
    const id = Number(entry.id);
    if (id < startEntryId) continue;
    if (isExternalUserBoundary(entry, startEntryId)) break;
    out.push(entry);
  }
  return out;
}

async function fetchEntriesFrom(conversation, minEntryId, ctx) {
  const collected = [];
  const startId = numId(minEntryId);
  if (startId == null) return collected;
  let cursor;
  while (true) {
    const page = await conversation.entries({ minEntryId: startId, order: 'ascending' }, 200, cursor, ctx);
    const items = Array.isArray(page?.items) ? page.items : [];
    collected.push(...items);
    if (!page?.next || items.length === 0) break;
    cursor = page.next;
  }
  return collected;
}

/**
 * Create the local per-run logger for scheduled task executions.
 */
export function createScheduleRunLogger({
  store,
  harness,
  context,
  dataDir = null,
  now = Date.now,
  maxKeep = DEFAULT_MAX_RUNS,
  logger = log,
  onRunUpdated = () => {},
} = {}) {
  if (!store) throw new Error('store is required');
  if (!harness) throw new Error('harness is required');

  const active = new Map();
  let closed = false;

  function logFileFor(scheduleId, runId, at) {
    return dataDir ? relativeScheduleLogFile(scheduleId, runId, at) : null;
  }

  function immediateSummary({ trigger = 'scheduled', state = 'running' } = {}) {
    return emptySummary({ trigger, state });
  }

  function createWriter(relPath) {
    const fullPath = resolveLogPath(dataDir, relPath);
    let chain = Promise.resolve();
    let dirReady = false;
    return {
      fullPath,
      write(record) {
        if (!fullPath) return Promise.resolve();
        const line = `${JSON.stringify(record)}\n`;
        chain = chain.then(async () => {
          if (!dirReady) {
            await mkdir(path.dirname(fullPath), { recursive: true });
            dirReady = true;
          }
          await appendFile(fullPath, line, { encoding: 'utf8', mode: 0o600 });
        }).catch((err) => {
          logger.error('WEFT_SCHEDULE_LOG_WRITE', `schedule run log write failed: ${relPath}`, err);
        });
        return chain;
      },
      flush() {
        return chain;
      },
    };
  }

  async function pruneScheduleLogs(scheduleId) {
    if (!dataDir || !Number.isFinite(maxKeep) || maxKeep < 1) return;
    const dir = path.join(dataDir, 'logs', 'schedules', safeSegment(scheduleId));
    try {
      const names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
      const excess = names.length - maxKeep;
      if (excess <= 0) return;
      for (const name of names.slice(0, excess)) {
        await rm(path.join(dir, name), { force: true });
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        logger.error('WEFT_SCHEDULE_LOG_PRUNE', `prune failed for ${scheduleId}`, err);
      }
    }
  }

  async function removeScheduleLogs(scheduleId) {
    if (!dataDir || !scheduleId) return;
    const dir = path.join(dataDir, 'logs', 'schedules', safeSegment(scheduleId));
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      logger.error('WEFT_SCHEDULE_LOG_REMOVE', `remove failed for ${scheduleId}`, err);
    }
  }

  function logRunSummaryToService(scheduleId, runId, status, summary, durationMs, relPath, error) {
    const fields = {
      schedule: scheduleId,
      runId,
      status,
      durationMs,
      llmCalls: summary.llmCalls,
      toolCalls: summary.toolCalls,
      toolErrors: summary.toolErrors,
      tokens: summary.totalTokens,
      logFile: relPath,
    };
    if (status === 'failed') {
      logger.error('WEFT_SCHEDULE_RUN', error ? String(error) : 'schedule run failed', fields);
    } else {
      logger.info('WEFT_SCHEDULE_RUN', 'schedule run completed', fields);
    }
  }

  async function recordImmediate({ schedule, run, trigger = 'scheduled', prompt }) {
    if (!run) return;
    const relPath = run.logFile || logFileFor(schedule?.id || run.scheduleId, run.id, run.at);
    const writer = createWriter(relPath);
    const startedAt = run.at;
    const finishedAt = run.finishedAt ?? startedAt;
    const durationMs = run.durationMs ?? Math.max(0, finishedAt - startedAt);
    const summary = run.summary || emptySummary({ trigger, state: run.status });
    summary.state = run.status;

    writer.write({
      type: 'run_start',
      scheduleId: run.scheduleId,
      scheduleName: schedule?.name ? clipText(schedule.name, 512).text : null,
      runId: run.id,
      submissionId: run.submissionId ?? null,
      conversationId: run.conversationId ?? null,
      target: describeTarget(schedule),
      trigger,
      ts: startedAt,
      at: formatTs(startedAt),
      prompt: clipText(prompt ?? schedule?.message ?? '').text,
    });
    writer.write({
      type: 'run_end',
      scheduleId: run.scheduleId,
      runId: run.id,
      status: run.status,
      error: run.error ? clipText(run.error, 4096).text : null,
      ts: finishedAt,
      at: formatTs(finishedAt),
      durationMs,
      summary,
    });
    await writer.flush();
    logRunSummaryToService(run.scheduleId, run.id, run.status, summary, durationMs, relPath, run.error);
    await pruneScheduleLogs(run.scheduleId);
  }

  function evaluateOutcome(settled, ownEntries, initialStatus, runState) {
    if (settled?.status === 'done') {
      const answerEntry = settled.answer != null
        ? (ownEntries || []).find((entry) => Number(entry?.id) === Number(settled.answer))
        : null;
      const answerMsg = answerEntry?.model?.[0];
      if (answerMsg?.stopReason === 'error' || answerMsg?.stopReason === 'aborted') {
        const msg = answerMsg.errorMessage || String(answerMsg.stopReason);
        return { status: 'failed', error: clipText(msg, 4096).text };
      }
      if (runState.lastAssistantFailure && runState.summary.llmCalls > 0 && answerMsg?.stopReason == null) {
        return { status: 'failed', error: runState.lastAssistantFailure };
      }
      return { status: initialStatus === 'missed_caught_up' ? 'missed_caught_up' : 'ok', error: null };
    }
    const detail = settled?.detail || settled?.reason || runState.lastAssistantFailure || 'run unanswered';
    return { status: 'failed', error: clipText(String(detail), 4096).text };
  }

  async function finalizeRun(runState, { status, error, finishedAt, scheduleId, runId, relPath }) {
    const durationMs = Math.max(0, finishedAt - runState.startedAt);
    runState.summary.state = status;
    runState.writer.write({
      type: 'run_end',
      scheduleId,
      runId,
      status,
      error: error ? clipText(error, 4096).text : null,
      ts: finishedAt,
      at: formatTs(finishedAt),
      durationMs,
      summary: runState.summary,
    });
    await runState.writer.flush();

    try {
      await store.updateScheduleRun(runId, {
        status,
        error: error ?? null,
        finishedAt,
        durationMs,
        summary: runState.summary,
        logFile: relPath,
      });
    } catch (err) {
      if (!closed) logger.error('WEFT_SCHEDULE_RUN_DB', `failed updating schedule run ${runId}`, err);
    }

    logRunSummaryToService(scheduleId, runId, status, runState.summary, durationMs, relPath, error);
    await pruneScheduleLogs(scheduleId);
    if (!closed && status === 'failed') {
      try { onRunUpdated(runId, status); } catch { /* view updates must not throw */ }
    }
  }

  function startRunTracker({ schedule, run, trigger = 'scheduled', prompt, initialStatus = 'ok', harnessId, submissionId, recovered = false }) {
    if (!run?.id || submissionId == null || submissionId === '') return null;
    if (closed || active.has(run.id)) return active.get(run.id)?.done || null;

    const scheduleId = schedule?.id || run.scheduleId;
    const relPath = run.logFile || logFileFor(scheduleId, run.id, run.at);
    const { context: runCtx, cancel } = withCancel(context);
    const writer = createWriter(relPath);
    const runState = {
      startedAt: run.at,
      summary: emptySummary({ trigger, state: 'running' }),
      modelSet: new Set(),
      toolCallMeta: new Map(),
      seenEntryIds: new Set(),
      lastAssistantFailure: null,
      writer,
    };

    const emitEntry = (entry) => {
      if (!entry || entry.id == null) return;
      const key = String(entry.id);
      if (runState.seenEntryIds.has(key)) return;
      runState.seenEntryIds.add(key);
      const record = formatEntryRecord(entry, runState);
      writer.write(record);
    };

    if (!recovered) {
      writer.write({
        type: 'run_start',
        scheduleId,
        scheduleName: schedule?.name ? clipText(schedule.name, 512).text : null,
        runId: run.id,
        submissionId,
        conversationId: run.conversationId ?? null,
        target: describeTarget(schedule),
        trigger,
        ts: run.at,
        at: formatTs(run.at),
        prompt: clipText(prompt ?? schedule?.message ?? '').text,
      });
    } else {
      writer.write({
        type: 'run_resumed',
        scheduleId,
        runId: run.id,
        submissionId,
        ts: now(),
        at: formatTs(now()),
      });
    }

    let watch = null;
    let watchChain = Promise.resolve();
    const entryInfo = { cancel, done: null, stopWatch: async () => {} };

    const execute = async () => {
      try {
        const subId = numId(submissionId);
        if (subId == null) {
          await finalizeRun(runState, {
            status: 'failed',
            error: 'invalid submission id',
            finishedAt: now(),
            scheduleId,
            runId: run.id,
            relPath,
          });
          return;
        }
        const sub = await harness.submission(subId, runCtx);
        if (!sub) {
          await finalizeRun(runState, {
            status: 'failed',
            error: 'submission not found',
            finishedAt: now(),
            scheduleId,
            runId: run.id,
            relPath,
          });
          return;
        }

        const convId = numId(harnessId);
        const initialSubState = await sub.status(runCtx);
        const conv = convId != null ? await harness.conversation(convId, runCtx) : null;

        let placedStartId = initialSubState.status === 'placed' || initialSubState.status === 'done' || initialSubState.status === 'unanswered'
          ? (initialSubState.entry != null ? Number(initialSubState.entry) : null)
          : null;
        let boundaryHit = false;

        if (conv && (initialSubState.status === 'queued' || initialSubState.status === 'placed')) {
          watch = await conv.watch(runCtx);
          const enqueueEntries = (entries) => {
            if (!Array.isArray(entries) || entries.length === 0) return;
            watchChain = watchChain.then(async () => {
              if (closed || boundaryHit) return;
              if (placedStartId == null) {
                try {
                  const st = await sub.status(runCtx);
                  if (st?.entry != null && st.status !== 'queued') placedStartId = Number(st.entry);
                } catch { /* wait for settle reconciliation */ }
              }
              if (placedStartId == null) return;
              for (const entry of entries) {
                const id = Number(entry?.id);
                if (!Number.isFinite(id) || id < placedStartId) continue;
                if (isExternalUserBoundary(entry, placedStartId)) {
                  boundaryHit = true;
                  break;
                }
                emitEntry(entry);
              }
            }).catch(() => {});
          };
          enqueueEntries(watch.value?.entries);
          watch.start((call) => {
            if (call?.kind !== 'value') return;
            enqueueEntries(call.value?.entries);
          });
        }

        const settled = await sub.wait(runCtx);
        if (watch) {
          try { await watch.stop(); } catch { /* already stopped */ }
          watch = null;
        }
        await watchChain;

        if (closed) {
          writer.write({
            type: 'run_interrupted',
            scheduleId,
            runId: run.id,
            reason: 'service_closing',
            ts: now(),
            at: formatTs(now()),
          });
          await writer.flush();
          return;
        }

        const resolvedConv = conv || (settled.entry != null && convId != null ? await harness.conversation(convId, runCtx) : null);
        let ownEntries = [];
        if (resolvedConv && settled.entry != null) {
          const tailEntries = await fetchEntriesFrom(resolvedConv, settled.entry, runCtx);
          ownEntries = sliceSettledEntries(tailEntries, settled);
          for (const entry of ownEntries) emitEntry(entry);
        }

        const outcome = evaluateOutcome(settled, ownEntries, initialStatus, runState);
        await finalizeRun(runState, {
          status: outcome.status,
          error: outcome.error,
          finishedAt: now(),
          scheduleId,
          runId: run.id,
          relPath,
        });
      } catch (err) {
        if (watch) {
          try { await watch.stop(); } catch { /* already stopped */ }
          watch = null;
        }
        if (closed) {
          await writer.flush();
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('WEFT_SCHEDULE_RUN_TRACK', `tracking failed for ${run.id}`, err);
        await finalizeRun(runState, {
          status: 'failed',
          error: msg,
          finishedAt: now(),
          scheduleId,
          runId: run.id,
          relPath,
        });
      } finally {
        active.delete(run.id);
      }
    };

    entryInfo.stopWatch = async () => {
      if (watch) {
        try { await watch.stop(); } catch { /* already stopped */ }
        watch = null;
      }
    };
    entryInfo.done = execute();
    active.set(run.id, entryInfo);
    return entryInfo.done;
  }

  function trackRun(params) {
    return startRunTracker({ ...params, recovered: false });
  }

  async function recoverUnfinished() {
    if (closed || typeof store.listUnfinishedScheduleRuns !== 'function') return false;
    let changed = false;
    const unfinished = await store.listUnfinishedScheduleRuns();
    for (const run of unfinished) {
      if (closed) break;
      const schedule = await store.getSchedule(run.scheduleId);
      const conv = run.conversationId ? await store.getConversation(run.conversationId) : null;
      const relPath = run.logFile || logFileFor(run.scheduleId, run.id, run.at);

      const subId = numId(run.submissionId);
      if (subId == null) {
        await finalizeRun({
          startedAt: run.at,
          summary: emptySummary({ trigger: run.summary?.trigger || 'scheduled', state: 'failed' }),
          modelSet: new Set(),
          toolCallMeta: new Map(),
          seenEntryIds: new Set(),
          lastAssistantFailure: null,
          writer: createWriter(relPath),
        }, {
          status: 'failed',
          error: 'interrupted by server restart',
          finishedAt: now(),
          scheduleId: run.scheduleId,
          runId: run.id,
          relPath,
        });
        changed = true;
        continue;
      }

      const sub = await harness.submission(subId, context);
      if (!sub) {
        await finalizeRun({
          startedAt: run.at,
          summary: emptySummary({ trigger: run.summary?.trigger || 'scheduled', state: 'failed' }),
          modelSet: new Set(),
          toolCallMeta: new Map(),
          seenEntryIds: new Set(),
          lastAssistantFailure: null,
          writer: createWriter(relPath),
        }, {
          status: 'failed',
          error: 'submission not found after restart',
          finishedAt: now(),
          scheduleId: run.scheduleId,
          runId: run.id,
          relPath,
        });
        changed = true;
        continue;
      }

      const st = await sub.status(context);
      const tracker = startRunTracker({
        schedule,
        run,
        trigger: run.summary?.trigger || 'scheduled',
        prompt: schedule?.message ?? '',
        initialStatus: run.status === 'missed_caught_up' ? 'missed_caught_up' : 'ok',
        harnessId: conv?.harnessId ?? null,
        submissionId: run.submissionId,
        recovered: true,
      });
      if ((st.status === 'done' || st.status === 'unanswered') && tracker) {
        await tracker;
        changed = true;
      }
    }
    return changed;
  }

  async function whenIdle() {
    while (active.size > 0) {
      await Promise.allSettled([...active.values()].map((item) => item.done));
    }
  }

  async function close() {
    closed = true;
    const snapshot = [...active.values()];
    for (const item of snapshot) {
      try { item.cancel(); } catch { /* ignore */ }
      try { await item.stopWatch(); } catch { /* ignore */ }
    }
    await Promise.allSettled(snapshot.map((item) => item.done));
    active.clear();
  }

  return {
    logFileFor,
    immediateSummary,
    recordImmediate,
    trackRun,
    removeScheduleLogs,
    recoverUnfinished,
    whenIdle,
    close,
  };
}
