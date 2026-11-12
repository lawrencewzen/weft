// Map Pi Durable agent events onto the HTTP/SSE names the UI already listens for.
// Nothing here is stored. HTTP status is the last submission record.
import path from 'node:path';
import { retryDelayMs } from '@earendil-works/pi-ai/utils/retry';
import { DEFAULT_RETRY_POLICY } from '@earendil-works/pi-durable';
import { redactAuthText } from '../core/redact.mjs';
import { extractPasteTexts, parseUserMessageParts } from '../core/user-message-parts.mjs';
import { overlayContextWindow, presentContext } from '../core/usage.mjs';
import { askByToolCall } from './ask.mjs';
import { HANDOFF_REQUEST_KIND } from './handoff.mjs';
import { isAutoContinueText } from './continuation.mjs';
import { parentNoteText, USER_TO_SUBAGENT_KIND } from './subagent-control.mjs';
import { isSubagentReportText } from './subagent-report.mjs';
import { latestCallUsage, reportedUsage } from './usage.mjs';

/** messageId for an assistant partial that has no transcript entry yet. */
export const LIVE_MESSAGE_ID = 'live';

/** True for the legacy `'live'` id and for `live-1`, `live-2`, … */
export function isLiveMessageId(id) {
  const value = id == null ? '' : String(id);
  return value === LIVE_MESSAGE_ID || value.startsWith('live-');
}

/** One id per in-flight assistant generation. Cleared when that message ends. */
function ensureLiveId(ctx) {
  if (!ctx) return LIVE_MESSAGE_ID;
  if (ctx.liveId) return ctx.liveId;
  ctx.liveSeq = (Number(ctx.liveSeq) || 0) + 1;
  ctx.liveId = `live-${ctx.liveSeq}`;
  return ctx.liveId;
}

export function createMapContext({ retry = DEFAULT_RETRY_POLICY, contextWindow = null } = {}) {
  return {
    retry,
    toolInputs: new Map(),
    liveSeq: 0,
    liveId: null,
    contextWindow: contextWindow ?? null,
  };
}

function kindOfUserText(text) {
  if (isAutoContinueText(text)) return 'auto-continue';
  if (isSubagentReportText(text)) return 'subagent-report';
  return '';
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (block && typeof block.text === 'string' && block.type !== 'toolCall') return block.text;
    return '';
  }).join('');
}

function decodedBase64Bytes(data) {
  const text = String(data || '').replace(/\s+/g, '');
  if (!text || text.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

function imageBlocksOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block || block.type !== 'image') continue;
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType : '';
    const data = typeof block.data === 'string' ? block.data : '';
    if (!mimeType || !data) continue;
    const bytes = decodedBase64Bytes(data);
    if (bytes == null) continue;
    const image = { mediaType: mimeType, data, bytes };
    if (typeof block.name === 'string' && block.name.trim()) image.name = block.name.trim();
    out.push(image);
  }
  return out;
}

/** Metadata only. present() / old GET must not carry base64. */
function imagesOf(content) {
  return imageBlocksOf(content).map((image, index) => {
    const meta = { index, mediaType: image.mediaType, bytes: image.bytes };
    if (image.name) meta.name = image.name;
    return meta;
  });
}

/** Full image (with data) for GET /messages/{id}/images/{index}. Index matches imagesOf. */
export function findUserMessageImage(entries, messageId, index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return null;
  const want = String(messageId ?? '');
  if (!want) return null;
  for (const entry of entries || []) {
    if (entry?.kind !== 'pi.user') continue;
    if (String(entry.id) !== want) continue;
    return imageBlocksOf(entry.model?.[0]?.content)[n] || null;
  }
  return null;
}

/** Full paste text for GET /messages/{id}/pastes/{index}. Index matches pastes metadata. */
export function findUserMessagePaste(entries, messageId, index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return null;
  const want = String(messageId ?? '');
  if (!want) return null;
  for (const entry of entries || []) {
    if (entry?.kind !== 'pi.user') continue;
    if (String(entry.id) !== want) continue;
    const pastes = extractPasteTexts(entry.model?.[0]?.content);
    if (n >= pastes.length) return null;
    return pastes[n];
  }
  return null;
}

function toolBody({ id, name, status, input, output, path, added, removed }) {
  const tool = { id, name, status };
  if (input !== undefined) tool.input = input;
  if (output !== undefined) tool.output = output;
  if (path) tool.path = path;
  if (added != null) tool.added = added;
  if (removed != null) tool.removed = removed;
  return tool;
}

function withAsk(tool, askMap) {
  if (!tool?.id || !askMap) return tool;
  const ask = askMap.get(String(tool.id));
  if (ask) tool.ask = ask;
  return tool;
}

function assistantModelName(entry) {
  const value = entry?.model?.[0]?.model;
  return typeof value === 'string' && value ? value : '';
}

function messageDone(entry) {
  const message = entry.model?.[0];
  const parts = entry.kind === 'pi.user' ? parseUserMessageParts(message?.content) : null;
  const text = parts ? parts.text : textOf(message?.content);
  const data = { messageId: String(entry.id) };
  if (text) data.text = text;
  if (entry.kind === 'pi.user') {
    data.role = 'user';
    const kind = kindOfUserText(text);
    if (kind) data.kind = kind;
  } else {
    const model = assistantModelName(entry);
    if (model) data.model = model;
    const stopReason = message?.stopReason;
    if (typeof stopReason === 'string' && stopReason) data.stopReason = stopReason;
  }
  return { event: 'message.done', data };
}

function usageEvent(entry, ctx) {
  if (entry.kind !== 'pi.assistant') return null;
  const presented = overlayContextWindow(
    presentContext(reportedUsage(entry.model?.[0])),
    ctx?.contextWindow,
  );
  if (!presented.usage) return null;
  return { event: 'usage', data: presented };
}

/** Code, reason, and redacted detail only. Sentences are built by the v2 view for `lang`. */
function errorForSubmission(record) {
  const raw = typeof record.detail === 'string' ? record.detail : '';
  const detail = raw ? redactAuthText(raw) : '';
  const reason = typeof record.reason === 'string' ? record.reason : '';
  if (reason === 'no_model' || /\bE_NO_MODEL\b/.test(detail)) {
    return { code: 'E_NO_MODEL', reason: 'no_model' };
  }
  const effective = reason || 'model_error';
  const out = {
    code: effective === 'model_error' ? 'E_LLM' : effective,
    reason: effective,
  };
  if (detail) out.detail = detail;
  return out;
}

function isRunSubmission(record) {
  return record?.type === 'input' || record?.type === 'continue';
}

function unavailableTool(entry) {
  const diagnostics = entry?.data?.diagnostics;
  return Array.isArray(diagnostics) && diagnostics.some((item) => item?.code === 'tool_unavailable');
}

function toolOutput(entry, result) {
  if (unavailableTool(entry)) return 'E_UNKNOWN_TOOL';
  return result ? textOf(result.content) : undefined;
}

function diffOf(result) {
  const details = result?.details;
  if (!details || typeof details !== 'object') return {};
  return {
    path: typeof details.path === 'string' ? details.path : undefined,
    added: details.added,
    removed: details.removed,
  };
}

function toolDelta(ev) {
  const output = ev?.output;
  if (!output || typeof output !== 'object') return null;
  const toolId = ev.toolCallId == null ? '' : String(ev.toolCallId);
  if (!toolId) return null;
  const data = { toolId, toolName: ev.toolName || '' };
  if (typeof output.set === 'string') {
    data.set = output.set;
    return { event: 'tool.delta', data };
  }
  if (typeof output.append === 'string' && output.append) data.append = output.append;
  const trim = Number(output.trimStart);
  if (Number.isFinite(trim) && trim > 0) data.trimStart = trim;
  if (data.append == null && data.trimStart == null) return null;
  return { event: 'tool.delta', data };
}

function toolEnd(ev, ctx) {
  const args = ctx.toolInputs.get(ev.toolCallId) || {};
  const result = ev.entry?.model?.[0];
  const diff = diffOf(result);
  const output = toolOutput(ev.entry, result);
  const status = result ? (result.isError ? 'error' : 'completed') : 'error';
  return {
    event: 'tool.end',
    data: {
      tool: toolBody({
        id: ev.toolCallId,
        name: ev.toolName || result?.toolName,
        status,
        input: args,
        output,
        path: diff.path || args.path,
        added: diff.added,
        removed: diff.removed,
      }),
    },
  };
}

function queuedInputs(inbox) {
  return (inbox?.items || []).some((item) => item?.mode === 'steer' || item?.mode === 'followUp');
}

/**
 * HTTP status of one submission record.
 * `queued` / `placed` are running. `done` is finished.
 * `unanswered` is failed, except `reason: "aborted"`, which is stopped.
 * The error text is that record's reason and detail.
 */
export function statusFromSubmission(record) {
  if (record?.status === 'queued' || record?.status === 'placed') return { status: 'running' };
  if (record?.status === 'done') return { status: 'done' };
  if (record?.status === 'unanswered') {
    if (record.reason === 'aborted') return { status: 'stopped' };
    return { status: 'failed', llmError: errorForSubmission(record) };
  }
  throw new Error(`Unexpected submission status ${record?.status}`);
}

/**
 * One watchEvents batch, in order, as the SSE names the UI already handles.
 * A `snapshot` is not replayed; the caller pushes the current status so the
 * client refetches the conversation.
 */
export function mapHarnessBatch(batch, ctx) {
  const events = [];
  let refresh = false;
  for (const ev of batch || []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'snapshot') {
      refresh = true;
      continue;
    }
    if (ev.type === 'run_start') {
      events.push({ event: 'status', data: { status: 'running' } });
      continue;
    }
    if (ev.type === 'inbox_update' && queuedInputs({ items: ev.items })) {
      events.push({ event: 'status', data: { status: 'running' } });
      continue;
    }
    if (ev.type === 'message_update') {
      for (const change of ev.changes || []) {
        if (change?.type === 'text_delta' && change.delta) {
          events.push({
            event: 'message.delta',
            data: { messageId: ensureLiveId(ctx), text: String(change.delta) },
          });
        }
      }
      continue;
    }
    if (ev.type === 'message_end' && (ev.entry?.kind === 'pi.user' || ev.entry?.kind === 'pi.assistant')) {
      const done = messageDone(ev.entry);
      if (ev.entry.kind === 'pi.assistant' && ctx.liveId) {
        done.data.liveId = ctx.liveId;
        ctx.liveId = null;
      }
      events.push(done);
      const usage = usageEvent(ev.entry, ctx);
      if (usage) events.push(usage);
      continue;
    }
    if (ev.type === 'tool_execution_start') {
      const input = ev.args && typeof ev.args === 'object' ? ev.args : {};
      ctx.toolInputs.set(ev.toolCallId, input);
      events.push({
        event: 'tool.start',
        data: {
          tool: toolBody({
            id: ev.toolCallId,
            name: ev.toolName,
            status: 'running',
            input,
            path: input.path,
          }),
        },
      });
      continue;
    }
    if (ev.type === 'tool_execution_update') {
      const mapped = toolDelta(ev);
      if (mapped) events.push(mapped);
      continue;
    }
    if (ev.type === 'tool_execution_end') {
      events.push(toolEnd(ev, ctx));
      continue;
    }
    if (ev.type === 'auto_retry_start') {
      events.push({
        event: 'retry',
        data: {
          attempt: ev.attempt,
          delayMs: retryDelayMs(ctx.retry || DEFAULT_RETRY_POLICY, ev.attempt),
          reason: redactAuthText(ev.errorMessage || ''),
        },
      });
      continue;
    }
    if (ev.type === 'task_failed') {
      events.push({
        event: 'error',
        data: { code: 'E_LLM', message: redactAuthText(ev.message || ev.kind || 'task failed') },
      });
      events.push({ event: 'status', data: { status: 'failed' } });
      continue;
    }
    if (ev.type === 'submission' && isRunSubmission(ev.record) && ev.record.status === 'done') {
      events.push({ event: 'status', data: { status: 'done' } });
      continue;
    }
    if (ev.type === 'submission' && isRunSubmission(ev.record) && ev.record.status === 'unanswered') {
      if (ev.record.reason === 'aborted') {
        events.push({ event: 'status', data: { status: 'stopped' } });
        continue;
      }
      events.push({ event: 'error', data: errorForSubmission(ev.record) });
      events.push({ event: 'status', data: { status: 'failed' } });
    }
  }
  return { events, refresh };
}

/**
 * Baseline for one conversation watch. The first `projectViewUpdate` records the
 * attached view and emits nothing; later calls emit the SSE names `mapHarnessBatch`
 * used to derive from `watchEvents`.
 */
export function createViewProjector() {
  return {
    ready: false,
    seen: new Set(),
    text: '',
    tools: new Map(),
    run: false,
    retryKey: '',
    queued: false,
    compactionKey: '',
  };
}

function compactionKeyOf(live) {
  const running = Array.isArray(live?.compactions) ? live.compactions : [];
  const failure = live?.compactionFailure;
  return JSON.stringify({
    running: running.map((row) => [row?.taskId, row?.trigger, row?.blocking, row?.attempt]),
    failure: failure ? [failure.taskId, failure.trigger, failure.error] : null,
  });
}

function liveOf(view) {
  const docs = view?.docs;
  const live = docs && typeof docs === 'object' ? docs['pi.live'] : undefined;
  return live && typeof live === 'object' ? live : {};
}

function inboxOf(view) {
  const docs = view?.docs;
  const inbox = docs && typeof docs === 'object' ? docs['pi.inbox'] : undefined;
  return inbox && typeof inbox === 'object' ? inbox : {};
}

function rememberTool(projector, callId, input) {
  if (!callId || projector.tools.has(callId)) return projector.tools.get(callId);
  const known = { output: '', ended: false, input: input || {} };
  projector.tools.set(callId, known);
  return known;
}

/**
 * One `Conversation.watch` value, as the SSE names the UI already handles.
 * The first call is the attached snapshot: no replay, `refresh` so the caller
 * pushes the current submission status. A run that disappears sets `runEnded`;
 * the caller reads that submission instead of `pi.live.runFailure`.
 */
export function projectViewUpdate(projector, view, mapCtx) {
  const snapshot = projector.ready !== true;
  const events = [];
  const live = liveOf(view);
  const run = live.run != null;
  const queued = queuedInputs(inboxOf(view));
  const nextText = textOf(live.generation?.message?.content);
  const compactionKey = compactionKeyOf(live);

  if (!snapshot) {
    if (run && !projector.run) {
      events.push({ event: 'status', data: { status: 'running' } });
    }
    if (queued && !projector.queued) {
      events.push({ event: 'status', data: { status: 'running' } });
    }
    if (compactionKey !== projector.compactionKey) {
      events.push({ event: 'compaction', data: {} });
    }
    const retry = live.generation?.retry;
    if (retry && (retry.at != null || retry.error)) {
      const attempt = Number(live.generation?.attempt) || 0;
      const key = `${attempt}|${retry.at}|${retry.error || ''}`;
      if (key !== projector.retryKey) {
        projector.retryKey = key;
        events.push({
          event: 'retry',
          data: {
            attempt,
            delayMs: retryDelayMs(mapCtx?.retry || DEFAULT_RETRY_POLICY, attempt),
            reason: redactAuthText(retry.error || ''),
          },
        });
      }
    } else {
      projector.retryKey = '';
    }
    if (nextText && (projector.text === '' || nextText.startsWith(projector.text))) {
      const delta = nextText.slice(projector.text.length);
      if (delta) {
        events.push({
          event: 'message.delta',
          data: { messageId: ensureLiveId(mapCtx), text: delta },
        });
      }
    } else if (nextText) {
      if (mapCtx) mapCtx.liveId = null;
      events.push({
        event: 'message.delta',
        data: { messageId: ensureLiveId(mapCtx), text: nextText },
      });
    }
  }

  for (const entry of view?.entries || []) {
    if (!entry || entry.id == null) continue;
    const key = String(entry.id);
    if (projector.seen.has(key)) continue;
    projector.seen.add(key);
    // Not a user or assistant bubble. The summary stays out of message.done.
    // The thread note is rebuilt from this entry; the event only refreshes SSE.
    if (entry.kind === 'pi.compaction') {
      if (!snapshot) events.push({ event: 'compaction', data: { entryId: key } });
      continue;
    }
    // A reset starts a new context and is not a chat bubble. The event only
    // refreshes the conversation entity, so the chip does not wait for a reply.
    if (entry.kind === 'pi.reset') {
      if (!snapshot) events.push({ event: 'reset', data: { entryId: key } });
      continue;
    }
    if (!snapshot && (entry.kind === 'pi.user' || entry.kind === 'pi.assistant')) {
      const done = messageDone(entry);
      if (entry.kind === 'pi.assistant' && mapCtx?.liveId) {
        done.data.liveId = mapCtx.liveId;
        mapCtx.liveId = null;
      }
      events.push(done);
      const usage = usageEvent(entry, mapCtx);
      if (usage) events.push(usage);
    }
    if (entry.kind === 'pi.assistant') {
      const content = entry.model?.[0]?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'toolCall' || block.id == null) continue;
          const callId = String(block.id);
          if (projector.tools.has(callId)) continue;
          const input = block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments)
            ? block.arguments
            : {};
          mapCtx?.toolInputs?.set(callId, input);
          rememberTool(projector, callId, input);
          if (!snapshot) {
            events.push({
              event: 'tool.start',
              data: {
                tool: toolBody({
                  id: callId,
                  name: block.name,
                  status: 'running',
                  input,
                  path: typeof input.path === 'string' ? input.path : undefined,
                }),
              },
            });
          }
        }
      }
    }
    if (entry.kind === 'pi.tool-result') {
      const result = entry.model?.[0];
      const callId = result?.toolCallId == null ? '' : String(result.toolCallId);
      const known = callId ? projector.tools.get(callId) : undefined;
      if (known?.ended) continue;
      if (callId) projector.tools.set(callId, { output: known?.output || '', ended: true, input: known?.input || {} });
      if (!snapshot && callId) {
        events.push(toolEnd({
          toolCallId: callId,
          toolName: result?.toolName,
          entry,
        }, mapCtx));
      }
    }
  }

  const slots = Array.isArray(live.tools) ? live.tools : [];
  if (!snapshot) {
    for (const slot of slots) {
      if (!slot || slot.callId == null) continue;
      const callId = String(slot.callId);
      let known = projector.tools.get(callId);
      if (!known) {
        mapCtx?.toolInputs?.set(callId, {});
        known = rememberTool(projector, callId, {});
        events.push({
          event: 'tool.start',
          data: {
            tool: toolBody({
              id: callId,
              name: slot.name,
              status: 'running',
              input: {},
            }),
          },
        });
      }
      if (known.ended) continue;
      const output = typeof slot.output === 'string' ? slot.output : '';
      if (output && output !== known.output) {
        if (known.output && output.startsWith(known.output)) {
          const append = output.slice(known.output.length);
          if (append) {
            events.push({
              event: 'tool.delta',
              data: { toolId: callId, toolName: slot.name || '', append },
            });
          }
        } else {
          events.push({
            event: 'tool.delta',
            data: { toolId: callId, toolName: slot.name || '', set: output },
          });
        }
        known.output = output;
      }
      if (slot.status === 'done' && slot.entry == null) {
        events.push(toolEnd({ toolCallId: callId, toolName: slot.name }, mapCtx));
        known.ended = true;
      }
    }
  } else {
    for (const slot of slots) {
      if (!slot || slot.callId == null) continue;
      const callId = String(slot.callId);
      const known = projector.tools.get(callId) || { output: '', ended: false, input: {} };
      if (typeof slot.output === 'string') known.output = slot.output;
      if (slot.status === 'done') known.ended = true;
      projector.tools.set(callId, known);
      if (mapCtx?.toolInputs && !mapCtx.toolInputs.has(callId)) mapCtx.toolInputs.set(callId, known.input || {});
    }
    const retry = live.generation?.retry;
    projector.retryKey = retry ? `${live.generation?.attempt}|${retry.at}|${retry.error || ''}` : '';
  }

  const runEnded = !snapshot && projector.run && !run;
  projector.text = nextText;
  projector.run = run;
  projector.queued = queued;
  projector.compactionKey = compactionKey;
  projector.ready = true;
  return { events, refresh: snapshot, runEnded };
}

/** Transcript entries to the REST message list, plus the latest reported call usage. */
export function messagesFromEntries(entries) {
  const calls = new Map();
  const askMap = askByToolCall(entries);
  const usage = latestCallUsage(entries);
  for (const entry of entries || []) {
    if (entry?.kind !== 'pi.assistant') continue;
    const content = entry.model?.[0]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'toolCall' && block.id) {
        calls.set(block.id, { name: block.name, input: block.arguments || {} });
      }
    }
  }
  const answered = new Set();
  const messages = [];
  // A user-requested handoff leaves a weft.handoff-request entry (with the focus
  // text) before the model's reset. Pending until that reset or a later user turn.
  let handoffRequest = null;
  for (const entry of entries || []) {
    if (entry?.kind === HANDOFF_REQUEST_KIND) {
      const focus = typeof entry.data?.instructions === 'string' ? entry.data.instructions.trim() : '';
      handoffRequest = { by: 'user', ...(focus ? { instructions: focus } : {}) };
      continue;
    }
    if (entry?.kind === 'pi.user') handoffRequest = null;
    // The model sees this entry as a user summary. The thread gets a system note,
    // not a user or assistant bubble. The summary body (inside <summary>…</summary>,
    // without the model-facing preamble) becomes the note text, shown on expand.
    if (entry?.kind === 'pi.compaction') {
      const raw = textOf(entry.model?.[0]?.content);
      const inner = /<summary>([\s\S]*)<\/summary>/.exec(raw);
      const detail = (inner ? inner[1] : raw).trim();
      const note = {
        id: String(entry.id),
        role: 'note',
        kind: 'compaction',
      };
      if (detail) note.text = detail;
      // Manual compaction is the POST /compact path (Conversation.compact); the
      // focus text lives on the task input and is joined in by the kernel.
      if (entry.data?.reason === 'manual') note.request = { by: 'user' };
      messages.push(note);
      continue;
    }
    // pi.reset starts the new context. The model sees its user text; the thread
    // shows a handoff divider at this entry, and the text is the note detail.
    if (entry?.kind === 'pi.reset') {
      const detail = textOf(entry.model?.[0]?.content).trim();
      const note = {
        id: String(entry.id),
        role: 'note',
        kind: 'handoff',
      };
      if (detail) note.text = detail;
      if (handoffRequest) note.request = handoffRequest;
      handoffRequest = null;
      messages.push(note);
      continue;
    }
    if (entry?.kind === USER_TO_SUBAGENT_KIND) {
      const data = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
        ? entry.data
        : {};
      const name = data.name == null ? '' : String(data.name);
      const text = data.text == null ? '' : String(data.text);
      messages.push({
        id: String(entry.id),
        role: 'note',
        text: parentNoteText(name, text),
      });
      continue;
    }
    if (entry?.kind === 'pi.user' || entry?.kind === 'pi.assistant') {
      const content = entry.model?.[0]?.content;
      const parts = entry.kind === 'pi.user' ? parseUserMessageParts(content) : null;
      const text = parts ? parts.text : textOf(content);
      if (entry.kind === 'pi.assistant' && !text) continue;
      const msg = {
        id: String(entry.id),
        entryId: String(entry.id),
        role: entry.kind === 'pi.user' ? 'user' : 'assistant',
      };
      if (text) msg.text = text;
      if (entry.kind === 'pi.user') {
        const kind = kindOfUserText(text);
        if (kind) msg.kind = kind;
        const images = imagesOf(content);
        if (images.length) msg.images = images;
        if (parts?.pastes.length) msg.pastes = parts.pastes;
        if (parts?.files.length) msg.files = parts.files;
      }
      if (entry.kind === 'pi.assistant') {
        const model = assistantModelName(entry);
        if (model) msg.model = model;
        const stopReason = entry.model?.[0]?.stopReason;
        if (typeof stopReason === 'string' && stopReason) msg.stopReason = stopReason;
      }
      messages.push(msg);
      continue;
    }
    if (entry?.kind !== 'pi.tool-result') continue;
    const result = entry.model?.[0];
    if (!result) continue;
    if (result.toolCallId) answered.add(result.toolCallId);
    const known = calls.get(result.toolCallId) || {};
    const input = known.input || {};
    const diff = diffOf(result);
    const tool = toolBody({
      id: result.toolCallId,
      name: result.toolName || known.name,
      status: result.isError ? 'error' : 'completed',
      input,
      output: toolOutput(entry, result),
      path: diff.path || input.path,
      added: diff.added,
      removed: diff.removed,
    });
    messages.push({ id: String(entry.id), role: 'tool', text: tool.output || '', tool: withAsk(tool, askMap) });
  }
  // A tool call with no result yet is still running. The refresh must keep it,
  // or a GET during the call erases the live tool.start row.
  for (const [id, known] of calls) {
    if (answered.has(id)) continue;
    const input = known.input || {};
    const tool = toolBody({
      id,
      name: known.name,
      status: 'running',
      input,
      path: typeof input.path === 'string' ? input.path : undefined,
    });
    messages.push({ id: `tool-${id}`, role: 'tool', tool: withAsk(tool, askMap) });
  }
  return { messages, usage };
}

const FILE_CHANGE_TOOLS = new Set(['write', 'edit']);

function asTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isWindowsPath(p) {
  return typeof p === 'string' && (/^[A-Za-z]:[\\/]/.test(p) || /^[A-Za-z]:$/.test(p) || p.includes('\\'));
}

function getPathImpl(fromCwd, toCwd, filePath) {
  if (process.platform === 'win32' || isWindowsPath(fromCwd) || isWindowsPath(toCwd) || isWindowsPath(filePath)) {
    return path.win32;
  }
  return path.posix;
}

function isInsideRootWith(root, target, p) {
  const rel = p.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${p.sep}`) && rel !== '..' && !p.isAbsolute(rel));
}

function normalizePosixSeparators(p) {
  const s = String(p ?? '').replaceAll('\\', '/');
  if (/^[a-z]:/i.test(s)) {
    return s[0].toUpperCase() + s.slice(1);
  }
  return s;
}

/**
 * Relocate a file path from a child cwd onto the main workspace.
 * Files under the main workspace are rewritten relative to it, using `/`.
 * Files outside the main workspace touched by the conversation keep their absolute path.
 * Sub-agents in a different worktree touching non-main files are ignored (returns null).
 */
export function rebaseChangePath(filePath, fromCwd, toCwd) {
  if (filePath == null) return null;
  const raw = String(filePath).trim();
  if (!raw) return null;
  if (!fromCwd || !toCwd) return normalizePosixSeparators(raw);

  const p = getPathImpl(fromCwd, toCwd, raw);
  const from = p.resolve(String(fromCwd));
  const to = p.resolve(String(toCwd));
  const abs = p.resolve(from, raw);

  if (isInsideRootWith(to, abs, p)) {
    const moved = p.relative(to, abs);
    return moved ? moved.split(p.sep).join('/') : normalizePosixSeparators(raw);
  }

  // Not inside toCwd:
  // If from and to refer to the same root (e.g. main agent cwd), keep as absolute outside-workspace path.
  if (p.relative(from, to) === '') {
    return normalizePosixSeparators(abs.split(p.sep).join('/'));
  }

  // Sub-agent in another worktree: ignore
  return null;
}

/**
 * write/edit (and any other tool-result with details.path) from a transcript, in order.
 * `attributed` is true only for write/edit — bash and similar cannot set `by`.
 */
export function writesFromEntries(entries) {
  const writes = [];
  let index = 0;
  for (const entry of entries || []) {
    if (entry?.kind !== 'pi.tool-result') continue;
    const result = entry.model?.[0];
    const details = result?.details;
    if (!details || typeof details.path !== 'string') continue;
    const toolName = typeof result.toolName === 'string' ? result.toolName : '';
    writes.push({
      path: details.path,
      before: details.before,
      after: details.after,
      added: details.added,
      removed: details.removed,
      oversized: details.oversized === true,
      linesBefore: details.linesBefore,
      linesAfter: details.linesAfter,
      toolCallId: result.toolCallId || null,
      toolName,
      attributed: FILE_CHANGE_TOOLS.has(toolName),
      entryId: entry.id,
      timestamp: asTimestamp(result.timestamp),
      index: index++,
    });
  }
  return writes;
}

/** First details.path per conversation. Later edits of the same path keep that baseline. */
export function baselinesFromEntries(entries) {
  const byPath = new Map();
  for (const write of writesFromEntries(entries)) {
    if (byPath.has(write.path)) continue;
    byPath.set(write.path, {
      path: write.path,
      before: write.before,
      after: write.after,
      added: write.added,
      removed: write.removed,
      oversized: write.oversized,
      linesBefore: write.linesBefore,
      linesAfter: write.linesAfter,
      toolCallId: write.toolCallId,
    });
  }
  return [...byPath.values()];
}

/**
 * Order write/edit events across the main conversation and its descendants.
 * Timestamps (when both sides have them) are the only cross-source clock.
 * entryId / index are per-transcript: comparing them across sourceIndex is
 * meaningless. Without timestamps, same-source rows use entryId then index;
 * different sources fall back to sourceIndex (main conversation first). That
 * last step is an approximation when timestamps are missing.
 */
function compareWrites(a, b) {
  if (a.timestamp != null && b.timestamp != null && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  if (a.sourceIndex === b.sourceIndex) {
    const idA = Number(a.entryId);
    const idB = Number(b.entryId);
    if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) return idA - idB;
    return a.index - b.index;
  }
  return a.sourceIndex - b.sourceIndex;
}

/**
 * Merge write/edit snapshots from the main conversation and its descendants.
 * Same path: the earliest write is the baseline (`before`); the last write/edit
 * sets `by`. Sources whose files sit outside `workspacePath` (another worktree)
 * are skipped — see rebaseChangePath.
 *
 * `sources`: `{ writer, workspacePath, writes }[]`
 * `writer`: `{ kind: 'main' }` | `{ kind: 'subagent', agentId, name }` | null
 */
export function mergeFileChanges(sources, { workspacePath } = {}) {
  const mainWs = workspacePath || '';
  const events = [];
  const list = Array.isArray(sources) ? sources : [];
  for (let sourceIndex = 0; sourceIndex < list.length; sourceIndex++) {
    const source = list[sourceIndex] || {};
    const fromCwd = source.workspacePath || mainWs;
    for (const write of source.writes || []) {
      const relocated = rebaseChangePath(write.path, fromCwd, mainWs || fromCwd);
      if (relocated == null) continue;
      events.push({
        ...write,
        path: relocated,
        writer: source.writer ?? null,
        sourceIndex,
      });
    }
  }
  events.sort(compareWrites);
  const byPath = new Map();
  for (const ev of events) {
    let row = byPath.get(ev.path);
    if (!row) {
      row = {
        path: ev.path,
        before: ev.before,
        after: ev.after,
        added: ev.added,
        removed: ev.removed,
        oversized: ev.oversized === true,
        linesBefore: ev.linesBefore,
        linesAfter: ev.linesAfter,
        toolCallId: ev.toolCallId,
        by: null,
      };
      byPath.set(ev.path, row);
    } else {
      row.after = ev.after;
      if (ev.oversized === true) row.oversized = true;
      if (ev.added != null) row.added = ev.added;
      if (ev.removed != null) row.removed = ev.removed;
      if (ev.linesAfter != null) row.linesAfter = ev.linesAfter;
    }
    if (ev.attributed && ev.writer) row.by = ev.writer;
  }
  return [...byPath.values()];
}
