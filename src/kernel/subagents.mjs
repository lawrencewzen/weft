// Subagent host over Pi Durable conversations dispatched by the `task` tool.
// Ownership, abort, and restart reuse belong to the Harness. This module
// configures a self-contained child (fixed no-ask instructions; environment and
// project_context come from the shared prompt sections) and reads what `task`
// committed: tool details, `TasksDoc`, the ownership task graph, and child transcripts.
import { LiveDoc } from '@earendil-works/pi-durable';
import { agentEventData } from '../core/agents.mjs';
import { isCommandToolName } from '../core/config.mjs';
import { createMapContext, createViewProjector, projectViewUpdate, textOf } from './events.mjs';
import { ASK_TOOL_NAME } from './ask.mjs';
import { HANDOFF_TOOL_NAME } from './handoff.mjs';
import { TASK_TOOL_NAME, TasksDoc } from './task-tool.mjs';
import { log } from '../core/log.mjs';

export const SUBAGENT_INSTRUCTIONS = [
  'You are a subagent dispatched to complete one task independently.',
  'You cannot ask the user questions, and you will not receive answers.',
  'If information is missing or you hit a blocker, do not stop to ask; continue with the most reasonable assumption, or end.',
  'Your last message must be a report to the main agent: what you did, the result, what is unfinished and why, and what the main agent needs to supply.',
  'Do not ask the user questions in the report.',
].join(' ');

const DISPATCH_TOOLS = new Set([TASK_TOOL_NAME, 'skill']);
/** Dispatch tools, ask, handoff, and schedule (only the main agent sets schedules): a child cannot question the user or reset the parent's context. */
export const CHILD_HIDDEN_TOOLS = new Set([...DISPATCH_TOOLS, ASK_TOOL_NAME, HANDOFF_TOOL_NAME, 'schedule']);

/** Display title from the dispatch description. Empty or whitespace is omitted. */
export function cleanTitle(value) {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/\s+/g, ' ').trim();
  return title || undefined;
}

function childTools(parentAgent) {
  return (parentAgent?.tools || []).filter((tool) => tool?.name && !CHILD_HIDDEN_TOOLS.has(tool.name));
}

function statsOf(messages) {
  let toolCalls = 0;
  let step = 0;
  let lastText = '';
  for (const message of messages || []) {
    if (message?.role === 'assistant') {
      step += 1;
      if (message.text) lastText = String(message.text);
    } else if (message?.role === 'tool' || message?.tool) {
      step += 1;
      toolCalls += 1;
    }
  }
  return { toolCalls, step, totalSteps: step, lastText };
}

const ACTION_CAP = 60;
const PRIMARY_ARG_KEYS = ['command', 'cmd', 'path', 'query', 'pattern', 'url', 'prompt', 'message', 'task'];
const TERMINAL_CHILD = new Set(['done', 'stopped', 'failed', 'error']);

function clipAction(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return undefined;
  return value.length <= ACTION_CAP ? value : value.slice(0, ACTION_CAP);
}

function asTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toolCallsFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block && block.type === 'toolCall' && block.name);
}

function primaryArg(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  for (const key of PRIMARY_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const [key, value] of Object.entries(args)) {
    if (key === 'description') continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Last-tool label for a running child. Prefer `description`, else `name: primary`. */
export function currentActionText(name, args) {
  const description = typeof args?.description === 'string' ? args.description.trim() : '';
  if (description) return clipAction(description);
  const primary = primaryArg(args);
  const label = String(name || '').trim();
  if (!label && !primary) return undefined;
  return clipAction(primary ? `${label}: ${primary}` : label);
}

function takeTool(call) {
  if (!call?.name) return null;
  const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
    ? call.arguments
    : (call.input && typeof call.input === 'object' && !Array.isArray(call.input) ? call.input : {});
  return { name: call.name, args };
}

/**
 * Extra chip fields from a child transcript. Missing timestamps or text are omitted.
 * `entries` are preferred (pi-ai `timestamp` lives on `entry.model[0]`); mapped
 * `messages` are the fallback when entries are absent.
 */
export function activityFields(transcript, status) {
  const messages = transcript?.messages || [];
  const entries = transcript?.entries || [];
  let brief;
  let startedAt;
  let lastActivityAt;
  let lastTs;
  let sawFirst = false;
  let lastWasAssistantText = false;
  let lastTool = null;

  const noteFirst = (model) => {
    const ts = asTimestamp(model?.timestamp);
    if (!sawFirst) {
      sawFirst = true;
      if (ts != null) startedAt = ts;
    }
    if (ts != null) lastTs = ts;
    return ts;
  };

  if (entries.length) {
    for (const entry of entries) {
      const model = entry?.model?.[0];
      if (entry?.kind === 'pi.user') {
        noteFirst(model);
        lastWasAssistantText = false;
        if (brief == null) {
          const text = textOf(model?.content);
          if (text) brief = text;
        }
      } else if (entry?.kind === 'pi.assistant') {
        const ts = noteFirst(model);
        if (ts != null) lastActivityAt = ts;
        const calls = toolCallsFromContent(model?.content);
        const text = textOf(model?.content);
        if (calls.length) {
          lastTool = takeTool(calls[calls.length - 1]);
          lastWasAssistantText = false;
        } else if (text) {
          lastWasAssistantText = true;
        }
      } else if (entry?.kind === 'pi.tool-result') {
        const ts = noteFirst(model);
        if (ts != null) lastActivityAt = ts;
        lastWasAssistantText = false;
        if (!lastTool && model?.toolName) lastTool = takeTool({ name: model.toolName, arguments: {} });
      }
    }
  } else {
    for (const message of messages) {
      if (message?.role === 'user') {
        noteFirst(message);
        lastWasAssistantText = false;
        if (brief == null && message.text) brief = String(message.text);
      } else if (message?.role === 'assistant') {
        const ts = noteFirst(message);
        if (ts != null) lastActivityAt = ts;
        const tool = message.tool || (Array.isArray(message.toolCalls) ? message.toolCalls[message.toolCalls.length - 1] : null);
        if (tool?.name) {
          lastTool = takeTool({ name: tool.name, arguments: tool.arguments || tool.input || {} });
          lastWasAssistantText = false;
        } else if (message.text) {
          lastWasAssistantText = true;
        }
      } else if (message?.role === 'tool' || message?.tool) {
        const ts = noteFirst(message);
        if (ts != null) lastActivityAt = ts;
        lastWasAssistantText = false;
        if (message.tool?.name) lastTool = takeTool({ name: message.tool.name, arguments: message.tool.input || {} });
      }
    }
  }

  const out = {};
  if (brief) out.brief = brief;
  if (startedAt != null) out.startedAt = startedAt;
  if (lastActivityAt != null) out.lastActivityAt = lastActivityAt;
  if (TERMINAL_CHILD.has(status) && lastTs != null) out.endedAt = lastTs;
  if (status === 'running' && !lastWasAssistantText && lastTool) {
    const action = currentActionText(lastTool.name, lastTool.args);
    if (action) out.currentAction = action;
  }
  return out;
}

function childStatus(busy, childLive, generation, stats) {
  if (busy) return 'running';
  const outcome = generation?.state?.outcome;
  if (outcome?.status === 'aborted' || childLive?.runFailure?.reason === 'aborted') {
    return 'stopped';
  }
  if (
    outcome?.status === 'failed'
    || outcome?.status === 'faulted'
    || outcome?.status === 'orphaned'
    || childLive?.runFailure
  ) {
    return 'failed';
  }
  if (outcome?.status === 'completed' || stats.lastText) return 'done';
  return 'waiting';
}

/** First non-empty tool-call id wins, so a later management call does not replace dispatch. */
function firstToolCallId(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function takeChild(meta, order, id, patch) {
  if (id == null) return;
  const key = Number(id);
  if (!meta.has(key)) order.push(key);
  const prev = meta.get(key) || {};
  meta.set(key, {
    conversationId: id,
    mode: patch.mode || prev.mode || 'foreground',
    name: patch.name || prev.name || '',
    title: cleanTitle(patch.title) || prev.title || '',
    toolCallId: firstToolCallId(prev.toolCallId, patch.toolCallId),
  });
}

function toolChild(details, mode, toolCallId) {
  if (details?.conversationId == null || !mode) return null;
  return {
    conversationId: details.conversationId,
    mode,
    name: details.name,
    title: details.title,
    toolCallId: firstToolCallId(toolCallId),
  };
}

/** One task-graph read. `watchTaskGraph` replaces the removed `Harness.taskGraph`. */
export async function readTaskGraph(harness, context) {
  const watch = await harness.watchTaskGraph(context);
  try {
    return watch?.value || { tasks: {} };
  } finally {
    await watch?.stop?.();
  }
}

/** Read subagents from `task` tool details, `TasksDoc`, ownership, and child transcripts. */
export function createSubagentHost({
  store,
  harness,
  context,
  readTranscript,
  emit,
  watchConversation,
  cidFor,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!harness) throw new Error('harness is required');
  if (!context) throw new Error('context is required');
  if (typeof readTranscript !== 'function') throw new Error('readTranscript is required');
  const childWatches = new Map();
  const lastAgent = new Map();
  let closed = false;

  async function prepareChild(parentAgent) {
    const change = { tools: childTools(parentAgent), instructions: SUBAGENT_INSTRUCTIONS };
    if (parentAgent?.cwd) change.cwd = parentAgent.cwd;
    return { change };
  }

  /** Child conversation roster from parent `task` details, LiveDoc tools, `TasksDoc`, and the task graph. */
  async function collectChildren(conv, sharedGraph) {
    const meta = new Map();
    const order = [];
    if (!conv?.id || conv.harnessId == null) return { meta, order };
    const parent = await readTranscript(conv.harnessId);
    for (const entry of parent.entries || []) {
      const result = entry?.model?.[0];
      if (result?.toolName !== TASK_TOOL_NAME) continue;
      if (result?.details?.conversationId == null || result?.details?.action) continue;
      const mode = result.details.mode === 'background' ? 'background' : 'foreground';
      const found = toolChild(result.details, mode, result.toolCallId);
      if (found) takeChild(meta, order, found.conversationId, found);
    }
    const live = await harness.snapshot(LiveDoc, conv.harnessId, context);
    for (const slot of live?.tools || []) {
      if (slot?.name !== TASK_TOOL_NAME) continue;
      if (slot?.details?.conversationId == null || slot?.details?.action) continue;
      const mode = slot.details.mode === 'background' ? 'background' : 'foreground';
      const found = toolChild(slot.details, mode, slot.callId);
      if (found) takeChild(meta, order, found.conversationId, found);
    }
    const roster = await harness.snapshot(TasksDoc, conv.harnessId, context);
    for (const [id, entry] of Object.entries(roster?.tasks || {})) {
      if (entry?.conversationId != null) {
        takeChild(meta, order, entry.conversationId, {
          mode: 'background',
          name: id,
          title: entry.title,
        });
      }
    }
    const graph = sharedGraph ?? await readTaskGraph(harness, context);
    for (const node of Object.values(graph?.tasks || {})) {
      if (Number(node.conversationId) !== Number(conv.harnessId)) continue;
      for (const id of node.conversations || []) takeChild(meta, order, id, {});
    }
    return { meta, order };
  }

  async function subagentDigest(conv, sharedGraph) {
    const { meta, order } = await collectChildren(conv, sharedGraph);
    let total = 0;
    let live = 0;
    for (const key of order) {
      const entry = meta.get(key);
      if (!entry?.conversationId) continue;
      total += 1;
      const childLive = await harness.snapshot(LiveDoc, entry.conversationId, context);
      if (childLive?.run) live += 1;
    }
    return { total, live };
  }

  async function subagentDigests(convs) {
    const rows = Array.isArray(convs) ? convs : [];
    const graph = await readTaskGraph(harness, context);
    const out = new Map();
    for (const conv of rows) {
      if (!conv?.id) continue;
      out.set(conv.id, await subagentDigest(conv, graph));
    }
    return out;
  }

  /**
   * Recursive child roster for the main conversation's change list.
   * Ids stay `<cid>:sub:<harness conversation id>` on the main cid.
   */
  async function listDescendants(conv) {
    const seen = new Set();
    const out = [];
    if (!conv?.id || conv.harnessId == null) return out;
    seen.add(Number(conv.harnessId));
    async function walk(harnessId) {
      const { meta, order } = await collectChildren({ id: conv.id, harnessId });
      for (const key of order) {
        const entry = meta.get(key);
        if (!entry?.conversationId) continue;
        const childKey = Number(entry.conversationId);
        if (seen.has(childKey)) continue;
        seen.add(childKey);
        out.push({
          id: `${conv.id}:sub:${entry.conversationId}`,
          name: entry.name || String(entry.conversationId),
          harnessId: entry.conversationId,
        });
        await walk(entry.conversationId);
      }
    }
    await walk(conv.harnessId);
    return out;
  }

  async function listSubagents(conv) {
    const { meta, order } = await collectChildren(conv);
    const generations = order.length === 0 ? new Map() : await harness.commit(async (tx) => {
      const found = new Map();
      for (const key of order) {
        const id = meta.get(key)?.conversationId;
        const page = await tx.scanTasks({ conversationId: id, kind: 'pi.generation', order: 'descending' }, 1);
        found.set(key, page.items[0]);
      }
      return found;
    }, context);
    const out = [];
    for (const key of order) {
      const entry = meta.get(key);
      if (!entry?.conversationId) continue;
      const childLive = await harness.snapshot(LiveDoc, entry.conversationId, context);
      const transcript = await readTranscript(entry.conversationId);
      const stats = statsOf(transcript.messages);
      const generation = generations.get(key);
      const outcome = generation?.state?.outcome;
      const name = entry.name || String(entry.conversationId);
      const status = childStatus(Boolean(childLive?.run), childLive, generation, stats);
      const failureText = outcome?.error?.message
        || outcome?.reason
        || childLive?.runFailure?.detail
        || childLive?.runFailure?.reason
        || '';
      const lastText = stats.lastText || (status === 'failed' ? String(failureText) : '');
      const title = cleanTitle(entry.title);
      out.push({
        id: `${conv.id}:sub:${entry.conversationId}`,
        name,
        status,
        step: stats.step,
        totalSteps: stats.totalSteps,
        toolCalls: stats.toolCalls,
        lastText,
        mode: entry.mode === 'background' ? 'background' : 'foreground',
        harnessId: entry.conversationId,
        toolCallId: firstToolCallId(entry.toolCallId),
        ...(title ? { title } : {}),
        ...activityFields(transcript, status),
      });
    }
    return out;
  }

  async function emitAgent(cid, agent) {
    if (typeof emit !== 'function' || !agent) return;
    const data = agentEventData(agent);
    if (!data) return;
    data.mode = agent.mode === 'background' ? 'background' : 'foreground';
    const key = JSON.stringify(data);
    if (lastAgent.get(data.id) === key) return;
    lastAgent.set(data.id, key);
    await emit(cid, 'agent', data);
  }

  async function publish(parentCid, childId) {
    const conv = await store.getConversation(parentCid);
    if (!conv) return;
    const agents = await listSubagents(conv);
    const agent = agents.find((item) => item.harnessId === childId || item.id.endsWith(`:sub:${childId}`));
    if (agent) await emitAgent(parentCid, agent);
  }

  function forwardChildTool(parentCid, ev) {
    if (typeof emit !== 'function' || !ev?.event) return;
    if (ev.event === 'tool.delta') {
      void Promise.resolve(emit(parentCid, ev.event, ev.data)).catch((err) => {
        log.error('WEFT_KERNEL_SUBAGENT', '', err);
      });
      return;
    }
    if (ev.event !== 'tool.start' && ev.event !== 'tool.end') return;
    const name = ev.data?.tool?.name;
    if (!isCommandToolName(name)) return;
    void Promise.resolve(emit(parentCid, ev.event, ev.data)).catch((err) => {
      log.error('WEFT_KERNEL_SUBAGENT', '', err);
    });
  }

  async function attach(parentCid, childId) {
    if (closed || childId == null || childWatches.has(childId) || typeof watchConversation !== 'function') return;
    const watch = await watchConversation(childId);
    if (!watch) return;
    childWatches.set(childId, watch);
    const mapCtx = createMapContext();
    const projector = createViewProjector();
    projectViewUpdate(projector, watch.value, mapCtx);
    const run = () => publish(parentCid, childId).catch((err) => {
      log.error('WEFT_KERNEL_SUBAGENT', '', err);
    });
    await run();
    watch.start((call) => {
      if (call?.kind !== 'value') return Promise.resolve();
      run();
      try {
        const mapped = projectViewUpdate(projector, call.value, mapCtx);
        for (const ev of mapped.events) forwardChildTool(parentCid, ev);
      } catch (err) {
        log.error('WEFT_KERNEL_SUBAGENT', '', err);
      }
      return Promise.resolve();
    });
  }

  function onChild(parentHarnessId, childId) {
    const parentCid = typeof cidFor === 'function' ? cidFor(parentHarnessId) : null;
    if (!parentCid) return;
    setImmediate(() => {
      attach(parentCid, childId).catch((err) => {
        log.error('WEFT_KERNEL_SUBAGENT', '', err);
      });
    });
  }

  return {
    prepareChild,
    onChild,
    listSubagents,
    listDescendants,
    subagentDigest,
    subagentDigests,
    async seed(rows) {
      for (const row of rows || []) {
        if (!row?.harnessId) continue;
        const agents = await listSubagents(row);
        for (const agent of agents) {
          if (row.id) await attach(row.id, agent.harnessId);
        }
      }
    },
    async childMessages(cid, agentId) {
      const conv = await store.getConversation(cid);
      if (!conv) return { status: 404, body: { error: 'conversation not found' } };
      const agents = await listSubagents(conv);
      const agent = agents.find((item) => item.id === agentId);
      if (!agent) return { status: 404, body: { error: 'agent not found' } };
      const transcript = await readTranscript(agent.harnessId);
      return {
        status: 200,
        body: {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          mode: agent.mode === 'background' ? 'background' : 'foreground',
          messages: transcript.messages,
        },
      };
    },
    /** Stops watching the children of a deleted conversation. Their Pi data is left as it is. */
    async forget(conv) {
      if (!conv) return;
      let agents = [];
      try { agents = await listSubagents(conv); } catch { agents = []; }
      for (const agent of agents) {
        const watch = childWatches.get(agent.harnessId);
        childWatches.delete(agent.harnessId);
        lastAgent.delete(agent.id);
        try { await watch?.stop(); } catch { /* already stopped */ }
      }
    },
    async stopConversation(cid) {
      const conv = await store.getConversation(cid);
      if (!conv) return { status: 404, body: { error: 'conversation not found' } };
      if (conv.harnessId != null) {
        const conversation = await harness.conversation(conv.harnessId, context);
        if (conversation) await conversation.abort(context, { background: true });
      }
      if (typeof emit === 'function') await emit(cid, 'status', { status: 'stopped' });
      const fresh = await store.getConversation(cid);
      for (const agent of await listSubagents(fresh)) await emitAgent(cid, agent);
      return { status: 200, body: { status: 'stopped' } };
    },
    async close() {
      closed = true;
      for (const stream of childWatches.values()) {
        try { await stream.stop(); } catch { /* already stopped */ }
      }
      childWatches.clear();
    },
  };
}
