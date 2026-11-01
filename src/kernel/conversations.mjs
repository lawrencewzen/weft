// HTTP facade over one Pi Durable Harness.
// Dialogue state lives in the Harness. This module records the conversation
// index, maps watchEvents onto the connected SSE clients, and reads diffs
// back out of tool-result entries.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, watchEvents } from '@earendil-works/pi-durable';
import { liveDiff } from '../core/diff.mjs';
import { redactAuthText } from '../core/redact.mjs';
import { resolveInWorkspace } from '../core/paths.mjs';
import { formatSSE } from '../core/sse.mjs';
import { presentContext } from '../core/usage.mjs';
import { createCredentialStore, createModelsStore } from '../core/provider-stores.mjs';
import { createProviderService } from '../core/provider-service.mjs';
import { configureThinkingLevel } from '../core/thinking-level.mjs';
import {
  createMapContext,
  mapHarnessBatch,
  mergeFileChanges,
  findUserMessageImage,
  findUserMessagePaste,
  messagesFromEntries,
  statusFromSubmission,
  writesFromEntries,
} from './events.mjs';
import { latestCallUsage } from './usage.mjs';
import { createScriptFloorExtension, installDemo } from './faux-script.mjs';
import { FAUX_MODEL, openKernel } from './index.mjs';
import { createKernelModels, explicitDemo } from './models.mjs';
import { installPluginReload } from './plugins.mjs';
import { createAgentHost, installAgentExtensions } from './agent-config.mjs';
import { maybeGenerateConversationTitle } from './title.mjs';
import { createSubagentControl } from './subagent-control.mjs';
import { createSubagentExtension, createSubagentHost } from './subagents.mjs';
import { createWorkspaceExtension, workspaceTools } from './tools.mjs';
import { installUsageExtension } from './usage.mjs';
import { installContinuationExtension } from './continuation.mjs';
import { createAntigravityCwdExtension } from './antigravity-cwd.mjs';
import { createWorkspaceEnv } from './workspace-env.mjs';

const DETAIL_CAP = 1024 * 1024;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Harness settings. `WEFT_RETRY_MAX` is the number of attempts including the
 * first; Pi Durable's `maxRetries` counts the attempts after that.
 */
export function kernelSettings(env = process.env) {
  const maxAttempts = positiveInt(env.WEFT_RETRY_MAX, 5);
  return {
    retry: {
      enabled: true,
      maxRetries: Math.max(0, maxAttempts - 1),
      baseDelayMs: positiveInt(env.WEFT_RETRY_BASE_MS, 200),
    },
    stream: {
      timeoutMs: positiveInt(env.WEFT_STREAM_TIMEOUT_MS, 120_000),
    },
  };
}

/**
 * Sends the app layer handed to the kernel, as `requestId -> submission -> entry`.
 * The kernel keeps the submission records (and the requestId on them), but it only looks
 * them up by requestId, so the ids it minted for us are kept here. Display-only, bounded,
 * per process: it exists to retract the optimistic message on screen, never to drive work.
 */
const SEND_LOOKUP_MS = 0;
const SEND_KEEP_MS = 5 * 60_000;
const SEND_KEEP_ROWS = 20;

function recentSendsFor(sends, cid, now = Date.now()) {
  let rows = sends.get(cid);
  if (!rows) return [];
  rows = rows.filter((row) => now - row.at <= SEND_KEEP_MS);
  if (rows.length) sends.set(cid, rows);
  else sends.delete(cid);
  return rows;
}

/** Map the v2 send `mode` onto Pi Durable `whenBusy`. Unknown values are steer. */
export function whenBusyForMode(mode) {
  return mode === 'queue' ? 'followUp' : 'steer';
}

function sendModeOf(mode) {
  return mode === 'queue' ? 'queue' : 'steer';
}

function rememberSend(sends, cid, requestId, submissionId, extra = {}, now = Date.now()) {
  const rows = recentSendsFor(sends, cid, now);
  const entryId = extra.entryId == null || extra.entryId === '' ? null : String(extra.entryId);
  rows.push({
    requestId,
    submissionId,
    entryId,
    dropped: extra.dropped === true,
    at: now,
    checkedAt: entryId ? now : 0,
    mode: sendModeOf(extra.mode),
    text: typeof extra.text === 'string' ? extra.text : '',
  });
  while (rows.length > SEND_KEEP_ROWS) rows.shift();
  sends.set(cid, rows);
}

/**
 * Open the Harness for the conversation HTTP routes.
 * `harness.resume()` continues unfinished work. Status is the last submission
 * reacquired with `harness.submission(id)`, not a host-side scan.
 */
export async function openConversationKernel({
  dataDir,
  store,
  demo,
  describeAgents,
  extensions,
  getSettings,
  credentials,
  modelsStore,
  providerService,
  extraProviders = [],
  onConversationMeta,
  env = process.env,
} = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  if (!store) throw new Error('store is required');
  const faux = demo === true || explicitDemo(env);
  const credStore = credentials || createCredentialStore(store);
  const modelCache = modelsStore || createModelsStore(store);
  const models = createModels({ credentials: credStore, modelsStore: modelCache });
  if (faux) installDemo(models, env);
  const providers = providerService || createProviderService({
    store,
    credentials: credStore,
    modelsStore: modelCache,
    env,
    extraProviders,
  });
  const modelRoutes = createKernelModels({ models, getSettings, env, extraProviders });
  const routes = faux ? null : modelRoutes;
  const registry = createRegistry();
  const agentBridge = {};
  const subagentApi = {};
  const watches = new Map();
  const tails = new Map();
  const listeners = new Map();
  const sends = new Map();
  const allListeners = new Set();
  const settings = kernelSettings(env);
  let agentHost;

  async function conversationIdFor(harnessId) {
    const wanted = Number(harnessId);
    for (const [cid, watch] of watches) {
      if (Number(watch.harnessId) === wanted) return cid;
    }
    const rows = await store.listKernelConversations();
    return rows.find((row) => Number(row.harnessId) === wanted)?.id ?? null;
  }

  registry.install(createWorkspaceExtension());
  installAgentExtensions(registry, agentBridge);
  installUsageExtension(registry);
  installContinuationExtension(registry);
  installPluginReload(registry, agentBridge);
  const subagentExtension = createSubagentExtension({
    prepareChild: (parent) => subagentApi.prepareChild(parent),
    onChild: (parentId, childId) => subagentApi.onChild?.(parentId, childId),
  });
  agentBridge.extraTools = () => [
    ...(agentBridge.skillTool ? [agentBridge.skillTool] : []),
    ...(subagentExtension.tools || []),
  ];
  registry.install(subagentExtension);
  if (String(env.WEFT_FAUX_SCRIPT || '').trim()) registry.install(createScriptFloorExtension());
  const antigravityCwd = { harness: null, context: null };
  registry.install(createAntigravityCwdExtension(antigravityCwd));
  const kernel = await openKernel({
    dataDir,
    models,
    registry,
    settings,
    env: async ({ cwd }) => (cwd ? createWorkspaceEnv({ cwd }) : undefined), // main Agent and sub-agents; bash env allow-list lives here
  });
  const { harness, context } = kernel;
  antigravityCwd.harness = harness;
  antigravityCwd.context = context;

  function enqueue(cid, fn) {
    const prev = tails.get(cid) || Promise.resolve();
    const run = prev.then(fn, fn);
    tails.set(cid, run.then(() => {}, () => {}));
    return run;
  }

  function push(cid, ev) {
    for (const fn of listeners.get(cid) || []) {
      try { fn(ev); } catch { /* a detached response must not stop the watch */ }
    }
    for (const fn of allListeners) {
      try { fn(cid, ev); } catch { /* a detached response must not stop the watch */ }
    }
  }

  async function emitAgent(cid, status, messages) {
    if (!agentHost) return;
    try {
      await agentHost.emitAgent(cid, status, messages);
    } catch (err) {
      console.error(`WEFT_KERNEL_AGENT ${redactAuthText(err instanceof Error ? err.message : err)}`);
    }
  }

  async function readView(harnessId) {
    const conversation = await harness.conversation(harnessId, context);
    if (!conversation) return null;
    const view = await conversation.viewState(context);
    try {
      return view.value;
    } finally {
      view.dispose();
    }
  }

  async function submissionView(conv) {
    // One pointer in the app index. Status is that submission's record.
    // A conversation with no pointer has not been sent a message yet.
    if (!conv?.lastSubmissionId) return { status: 'idle' };
    const handle = await harness.submission(conv.lastSubmissionId, context);
    if (!handle) {
      console.error(`WEFT_SUBMISSION_MISSING conversation=${conv.id} submission=${conv.lastSubmissionId}`);
      return {
        status: 'failed',
        llmError: { code: 'E_SUBMISSION_MISSING', message: '找不到这次运行的记录' },
      };
    }
    return statusFromSubmission(await handle.status(context));
  }

  /**
   * Which entry did each recently sent message become? Ask the kernel's submission record
   * (it carries requestId → entry) until it names one, then remember it: an entry never
   * moves. A record that ends without an entry was withdrawn before it landed.
   */
  async function sendsView(conv) {
    const rows = recentSendsFor(sends, conv.id);
    if (!rows?.length) return [];
    const now = Date.now();
    const out = [];
    for (const row of rows) {
      if (!row.entryId && !row.dropped && now - row.checkedAt >= SEND_LOOKUP_MS) {
        row.checkedAt = now;
        const handle = await harness.submission(row.submissionId, context);
        if (handle) {
          const record = await handle.status(context);
          const entry = record?.entry == null ? '' : String(record.entry);
          if (entry) row.entryId = entry;
          else row.dropped = record?.status === 'done' || record?.status === 'unanswered';
        }
      }
      out.push({
        requestId: row.requestId,
        entryId: row.entryId || null,
        dropped: row.dropped === true,
        mode: sendModeOf(row.mode),
        text: typeof row.text === 'string' ? row.text : '',
      });
    }
    return out;
  }

  function restoreLastSubmission(cid, conv, rows, withdrawnSubmissionId) {
    if (Number(conv?.lastSubmissionId) !== Number(withdrawnSubmissionId)) {
      return Promise.resolve();
    }
    const remaining = rows.filter((row) => (
      !row.dropped && Number(row.submissionId) !== Number(withdrawnSubmissionId)
    ));
    const prev = remaining[remaining.length - 1];
    return store.updateConversation(cid, {
      lastSubmissionId: prev ? prev.submissionId : conv.lastSubmissionId,
    });
  }

  async function readTranscript(harnessId) {
    const view = await readView(harnessId);
    if (!view) return { messages: [], usage: null, entries: [] };
    const mapped = messagesFromEntries(view.entries);
    return { ...mapped, entries: view.entries || [] };
  }

  async function resolveTitleModel(conv) {
    if (faux) return models.getModel(FAUX_MODEL.provider, FAUX_MODEL.modelId) || null;
    if (!routes) return null;
    const ref = await routes.modelFor(conv);
    if (!ref) return null;
    return models.getModel(ref.provider, ref.modelId) || null;
  }

  async function deliver(cid, ev) {
    push(cid, ev);
    if (ev.event === 'status') {
      const conv = await store.getConversation(cid);
      const messages = conv?.harnessId ? (await readTranscript(conv.harnessId)).messages : [];
      await emitAgent(cid, ev.data.status, messages);
      if (ev.data?.status === 'done') {
        void maybeGenerateConversationTitle(cid, {
          store,
          models,
          resolveModel: resolveTitleModel,
          readTranscript,
          onConversationMeta,
          status: 'done',
        });
      }
    }
  }

  async function conversationWindow(conv) {
    if (!conv) return null;
    return providers.contextWindowFor(conv);
  }

  async function applyBatch(cid, batch, mapCtx) {
    const conv = await store.getConversation(cid);
    mapCtx.contextWindow = await conversationWindow(conv);
    const mapped = mapHarnessBatch(batch, mapCtx);
    for (const ev of mapped.events) await deliver(cid, ev);
    if (mapped.refresh) {
      const conv = await store.getConversation(cid);
      const status = (await submissionView(conv)).status;
      await deliver(cid, { event: 'status', data: { status } });
    }
  }

  async function attach(row) {
    if (!row?.harnessId || watches.has(row.id)) return;
    const stream = await watchEvents(harness, row.harnessId, context);
    const mapCtx = createMapContext({ retry: settings.retry });
    watches.set(row.id, { stream, mapCtx, harnessId: row.harnessId });
    stream.start((batch) => enqueue(row.id, async () => {
      try {
        await applyBatch(row.id, batch, mapCtx);
      } catch (err) {
        console.error(`WEFT_KERNEL_EVENT ${redactAuthText(err instanceof Error ? (err.stack || err.message) : err)}`);
      }
    }));
  }

  async function applyModel(conversation, conv) {
    const model = await routes.modelFor(conv);
    const change = { model: model ?? null };
    if (model) {
      const catalog = models.getModel(model.provider, model.modelId);
      const thinkingLevel = configureThinkingLevel(catalog, conv?.thinkingLevel);
      change.thinkingLevel = thinkingLevel ?? null;
    }
    await conversation.configure(change, context);
  }

  async function resolveModel(conv) {
    if (!routes || !conv?.harnessId) return;
    const conversation = await harness.conversation(conv.harnessId, context);
    if (!conversation) return;
    await applyModel(conversation, conv);
  }

  async function statusOf(conv) {
    return (await submissionView(conv)).status;
  }

  agentHost = createAgentHost({
    store,
    harness,
    context,
    registry,
    extensions,
    bridge: agentBridge,
    readTranscript,
    emit: (cid, event, data) => deliver(cid, { event, data }),
    describeAgents,
    resolveModel,
    statusOf,
    providerService: providers,
  });

  function cidFor(harnessId) {
    const wanted = Number(harnessId);
    for (const [cid, watch] of watches) {
      if (Number(watch.harnessId) === wanted) return cid;
    }
    return null;
  }

  const subagents = createSubagentHost({
    store,
    harness,
    context,
    readTranscript,
    emit: (cid, event, data) => deliver(cid, { event, data }),
    watchEvents,
    cidFor,
  });
  subagentApi.prepareChild = subagents.prepareChild;
  subagentApi.onChild = subagents.onChild;
  const control = createSubagentControl({
    store,
    harness,
    context,
    listSubagents: (conv) => subagents.listSubagents(conv),
    emit: (cid, event, data) => deliver(cid, { event, data }),
  });

  const stored = await store.listKernelConversations();
  await agentHost.seed(stored);
  await subagents.seed(stored);
  for (const row of stored) await attach(row);
  await modelRoutes.warm();
  harness.resume();

  async function conversationFor(conv) {
    if (!conv?.harnessId) return null;
    return harness.conversation(conv.harnessId, context);
  }

  async function workspacePathFor(cid) {
    const conv = await store.getConversation(cid);
    return conv?.workspacePath || '';
  }

  async function readWorkspaceText(workspacePath, filePath) {
    let abs;
    try {
      abs = await resolveInWorkspace(workspacePath, filePath);
    } catch (err) {
      if (err?.code === 'E_SANDBOX' && (path.isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(filePath))) {
        abs = filePath;
      } else {
        throw err;
      }
    }
    try {
      const info = await stat(abs);
      if (info.size > DETAIL_CAP) {
        const err = new Error('文件过大');
        err.code = 'E_TOO_LARGE';
        throw err;
      }
      return { missing: false, text: await readFile(abs, 'utf8') };
    } catch (err) {
      if (err.code === 'ENOENT') return { missing: true, text: '' };
      if (abs === filePath) {
        return { missing: false, text: undefined };
      }
      throw err;
    }
  }

  function storedSnapshotDiffers(baseline) {
    const stored = liveDiff({
      path: baseline.path,
      before: baseline.before ?? '',
      storedAfter: baseline.after ?? '',
      diskText: undefined,
    });
    return stored.added !== 0 || stored.removed !== 0;
  }

  async function diskText(workspacePath, filePath, baseline) {
    let read;
    try {
      read = await readWorkspaceText(workspacePath, filePath);
    } catch (err) {
      if (err?.code === 'E_TOO_LARGE') throw err;
      if (baseline) return undefined;
      throw err;
    }
    if (read.text === undefined) return undefined;
    if (!read.missing || !baseline || !storedSnapshotDiffers(baseline)) return read.text;
    // Windows (and AV) can briefly report ENOENT after write/edit returns.
    // Retry only for a missing file whose tool snapshot still has a diff; an
    // existing empty file is a real revert and must stay +0 −0.
    const retries = process.platform === 'win32' ? 8 : 3;
    const delayMs = process.platform === 'win32' ? 25 : 10;
    for (let i = 0; i < retries; i++) {
      await sleep(delayMs);
      try {
        read = await readWorkspaceText(workspacePath, filePath);
      } catch {
        return undefined;
      }
      if (!read.missing) return read.text;
    }
    return read.text;
  }

  async function agentCwd(harnessId) {
    if (harnessId == null) return '';
    try {
      const handle = await harness.conversation(harnessId, context);
      if (!handle) return '';
      const agent = await handle.agent(context);
      return typeof agent?.cwd === 'string' ? agent.cwd : '';
    } catch {
      return '';
    }
  }

  /**
   * Baselines for the conversation plus descendant sub-agents (recursive).
   * Same path: earliest write/edit is `before`; last write/edit sets `by`.
   * A child in a different cwd (worktree) is skipped unless its files still
   * sit under this conversation's workspace — see rebaseChangePath.
   */
  async function baselinesFor(cid) {
    const conv = await store.getConversation(cid);
    if (!conv?.harnessId) return [];
    const workspacePath = conv.workspacePath || (await agentCwd(conv.harnessId)) || '';
    const sources = [];
    const mainTranscript = await readTranscript(conv.harnessId);
    sources.push({
      writer: { kind: 'main' },
      workspacePath: (await agentCwd(conv.harnessId)) || workspacePath,
      writes: writesFromEntries(mainTranscript.entries),
    });
    const descendants = await subagents.listDescendants(conv);
    for (const agent of descendants) {
      const childCwd = await agentCwd(agent.harnessId);
      const transcript = await readTranscript(agent.harnessId);
      sources.push({
        writer: {
          kind: 'subagent',
          agentId: agent.id,
          name: agent.name,
        },
        workspacePath: childCwd || workspacePath,
        writes: writesFromEntries(transcript.entries),
      });
    }
    return mergeFileChanges(sources, { workspacePath });
  }

  async function createConversation(fields) {
    const conv = await store.createConversation({ ...fields });
    const created = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: {
        ...(faux ? { model: FAUX_MODEL } : {}),
        ...(fields.workspacePath ? { cwd: fields.workspacePath } : {}),
        tools: workspaceTools(),
      },
    }, context);
    const next = await store.updateConversation(conv.id, { harnessId: created.id });
    if (agentHost) await agentHost.afterCreate(next);
    await attach(next);
    return next;
  }

  return {
    harness,
    context,
    async hasActiveWork() {
      const graph = await harness.taskGraph(context);
      try {
        return Object.keys(graph.value?.tasks || {}).length > 0;
      } finally {
        graph.dispose();
      }
    },
    async close() {
      for (const watch of watches.values()) {
        try { await watch.stream.stop(); } catch { /* already stopped */ }
      }
      watches.clear();
      await subagents.close();
      await kernel.close();
    },
    async reloadPlugins() {
      if (agentHost?.reloadPlugins) await agentHost.reloadPlugins();
    },
    createConversation,
    listSubagents(conv) {
      return subagents.listSubagents(conv).then((agents) => agents.map((agent) => {
        const { harnessId, ...rest } = agent;
        return {
          ...rest,
          mode: agent.mode === 'background' ? 'background' : 'foreground',
        };
      }));
    },
    subagentDigests(convs) {
      return subagents.subagentDigests(convs);
    },
    childMessages(cid, agentId) {
      return subagents.childMessages(cid, agentId);
    },
    sendToAgent(cid, agentId, text) {
      return control.sendToAgent(cid, agentId, text);
    },
    stopAgent(cid, agentId) {
      return control.stopAgent(cid, agentId);
    },
    stopConversation(cid) {
      return subagents.stopConversation(cid);
    },
    async changes(cid) {
      const workspacePath = await workspacePathFor(cid);
      const rows = [];
      for (const baseline of await baselinesFor(cid)) {
        if (baseline.oversized) {
          rows.push({
            path: baseline.path,
            added: baseline.added ?? 0,
            removed: baseline.removed ?? 0,
            toolCallId: baseline.toolCallId,
            by: baseline.by ?? null,
            error: '文件过大',
          });
          continue;
        }
        let disk;
        try {
          disk = await diskText(workspacePath, baseline.path, baseline);
        } catch (err) {
          if (err.code === 'E_TOO_LARGE') {
            rows.push({
              path: baseline.path,
              added: baseline.added ?? 0,
              removed: baseline.removed ?? 0,
              toolCallId: baseline.toolCallId,
              by: baseline.by ?? null,
              error: '文件过大',
            });
            continue;
          }
          throw err;
        }
        const diff = liveDiff({
          path: baseline.path,
          before: baseline.before ?? '',
          storedAfter: baseline.after ?? '',
          diskText: disk,
        });
        rows.push({
          path: baseline.path,
          added: diff.added,
          removed: diff.removed,
          toolCallId: baseline.toolCallId,
          by: baseline.by ?? null,
        });
      }
      return rows;
    },
    async diff(cid, filePath) {
      const want = String(filePath ?? '').replaceAll('\\', '/');
      const baseline = (await baselinesFor(cid)).find((row) => String(row.path ?? '').replaceAll('\\', '/') === want);
      if (!baseline) return { status: 404, body: { error: 'no diff' } };
      if (baseline.oversized) return { status: 200, body: { path: baseline.path, error: '文件过大' } };
      const workspacePath = await workspacePathFor(cid);
      try {
        const disk = await diskText(workspacePath, baseline.path, baseline);
        return {
          status: 200,
          body: liveDiff({
            path: baseline.path,
            before: baseline.before ?? '',
            storedAfter: baseline.after ?? '',
            diskText: disk,
          }),
        };
      } catch (err) {
        if (err.code === 'E_TOO_LARGE') return { status: 200, body: { path: baseline.path, error: '文件过大' } };
        throw err;
      }
    },
    async getMessageImage(cid, messageId, index) {
      const conv = await store.getConversation(cid);
      if (!conv?.harnessId) return null;
      const view = await readView(conv.harnessId);
      if (!view) return null;
      return findUserMessageImage(view.entries, messageId, index);
    },
    async getMessagePaste(cid, messageId, index) {
      const conv = await store.getConversation(cid);
      if (!conv?.harnessId) return null;
      const view = await readView(conv.harnessId);
      if (!view) return null;
      return findUserMessagePaste(view.entries, messageId, index);
    },
    async present(conv, { includeMessages = false } = {}) {
      if (!conv?.harnessId) {
        return { ...conv, status: 'idle', messages: includeMessages ? [] : undefined, sends: [] };
      }
      const view = await submissionView(conv);
      const status = view.status;
      let usage = null;
      let messages;
      if (includeMessages) {
        const transcript = await readTranscript(conv.harnessId);
        usage = presentContext(transcript.usage).usage;
        messages = transcript.messages;
      } else {
        // Newest assistant that reported tokens, not blindly the last message.
        // viewState is still required: a fixed-size descending scan can miss an
        // older reported call and would change the old list API.
        const harnessView = await readView(conv.harnessId);
        usage = presentContext(latestCallUsage(harnessView?.entries)).usage;
      }
      const out = { ...conv, status, usage, sends: await sendsView(conv) };
      if (view.llmError) out.llmError = view.llmError;
      if (includeMessages) out.messages = messages;
      return out;
    },
    async postMessage(conv, text, options = {}) {
      const conversation = await conversationFor(conv);
      if (!conversation) return { status: 404, body: { error: 'conversation not found' } };
      const prepared = agentHost ? await agentHost.prepareSend(conv, text) : null;
      const current = prepared?.conversation || conv;
      if (routes) {
        await applyModel(conversation, current);
      }
      const given = typeof options.requestId === 'string' ? options.requestId.trim() : '';
      const requestId = given || prepared?.requestId || randomUUID();
      const content = options.content !== undefined ? options.content : text;
      const mode = sendModeOf(options.mode);
      const submission = await conversation.submit({
        type: 'input',
        content,
        requestId,
        whenBusy: whenBusyForMode(mode),
      }, context);
      let entryId = null;
      try {
        const record = await submission.status(context);
        if (record?.entry != null && record.entry !== '') entryId = String(record.entry);
      } catch {
        entryId = null;
      }
      rememberSend(sends, current.id, requestId, submission.id, {
        mode,
        text: typeof text === 'string' ? text : '',
        entryId,
      });
      await store.updateConversation(current.id, { lastSubmissionId: submission.id });
      return { status: 202, body: { runId: String(submission.id), status: 'running' } };
    },
    async withdrawMessage(cid, requestId) {
      const id = typeof cid === 'string' ? cid.trim() : '';
      const rid = typeof requestId === 'string' ? requestId.trim() : '';
      if (!id || !rid) return { status: 404, body: { error: 'not found' } };
      const conv = await store.getConversation(id);
      if (!conv) return { status: 404, body: { error: 'not found' } };
      const rows = recentSendsFor(sends, id);
      const row = rows.find((item) => item.requestId === rid);
      if (!row) return { status: 404, body: { error: 'not found' } };
      if (!row.entryId && !row.dropped) {
        const handle = await harness.submission(row.submissionId, context);
        if (handle) {
          const record = await handle.status(context);
          const entry = record?.entry == null ? '' : String(record.entry);
          if (entry) row.entryId = entry;
          else if (record?.status === 'done' || record?.status === 'unanswered') row.dropped = true;
        }
      }
      if (row.entryId) {
        return { status: 409, body: { error: 'already landed', code: 'E_ALREADY_LANDED' } };
      }
      if (row.dropped) return { status: 404, body: { error: 'not found' } };
      const result = await harness.abortSubmission(
        row.submissionId,
        context,
        conv.harnessId == null ? undefined : conv.harnessId,
      );
      if (result === 'not_found') return { status: 404, body: { error: 'not found' } };
      if (result === 'already_placed' || result === 'settled') {
        const handle = await harness.submission(row.submissionId, context);
        if (handle) {
          const record = await handle.status(context);
          const entry = record?.entry == null ? '' : String(record.entry);
          if (entry) row.entryId = entry;
        }
        if (row.entryId) {
          return { status: 409, body: { error: 'already landed', code: 'E_ALREADY_LANDED' } };
        }
        row.dropped = true;
        return { status: 409, body: { error: 'already landed', code: 'E_ALREADY_LANDED' } };
      }
      row.dropped = true;
      await restoreLastSubmission(id, conv, rows, row.submissionId);
      return { status: 200, body: { ok: true } };
    },
    async patchConversation(cid, body) {
      const conv = await store.getConversation(cid);
      if (!conv) return { status: 404, body: { error: 'conversation not found' } };
      return agentHost.patchConversation(cid, body);
    },
    statusOf,
    subscribe(cid, fn) {
      let set = listeners.get(cid);
      if (!set) {
        set = new Set();
        listeners.set(cid, set);
      }
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(cid);
      };
    },
    subscribeAll(fn) {
      allListeners.add(fn);
      return () => {
        allListeners.delete(fn);
      };
    },
    async streamEvents(req, res, cid, { headers }) {
      const conv = await store.getConversation(cid);
      res.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(':\n\n');
      const status = (await submissionView(conv)).status;
      res.write(formatSSE({ event: 'status', data: { status } }));
      const unsub = this.subscribe(cid, (ev) => {
        res.write(formatSSE({ event: ev.event, data: ev.data }));
      });
      const ping = setInterval(() => {
        try { res.write(':\n\n'); } catch { /* ignore */ }
      }, 15000);
      ping.unref?.();
      req.on('close', () => {
        clearInterval(ping);
        unsub();
      });
      return conv;
    },
  };
}
