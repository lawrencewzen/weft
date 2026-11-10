// HTTP facade over one Pi Durable Harness.
// Dialogue state lives in the Harness. This module records the conversation
// index, maps Conversation.watch onto the connected SSE clients, and reads diffs
// back out of tool-result entries.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { ConversationBusy, ConversationTranscript, createRegistry } from '@earendil-works/pi-durable';
import { liveDiff } from '../core/diff.mjs';
import { redactAuthText } from '../core/redact.mjs';
import { resolveInWorkspace } from '../core/paths.mjs';
import { formatSSE } from '../core/sse.mjs';
import { presentContext } from '../core/usage.mjs';
import { createCredentialStore, createModelsStore } from '../core/provider-stores.mjs';
import { createProviderService } from '../core/provider-service.mjs';
import { configureThinkingLevel } from '../core/thinking-level.mjs';
import { buildAskSubmission } from './ask.mjs';
import {
  createMapContext,
  createViewProjector,
  mergeFileChanges,
  findUserMessageImage,
  findUserMessagePaste,
  messagesFromEntries,
  projectViewUpdate,
  statusFromSubmission,
  writesFromEntries,
} from './events.mjs';
import { createScriptFloorExtension, installDemo } from './faux-script.mjs';
import { FAUX_MODEL, openKernel } from './index.mjs';
import { createKernelModels, explicitDemo } from './models.mjs';
import { installPluginReload } from './plugins.mjs';
import { createAgentHost, installAgentExtensions } from './agent-config.mjs';
import { maybeGenerateConversationTitle } from './title.mjs';
import { createSubagentControl } from './subagent-control.mjs';
import { createSubagentExtension, createSubagentHost, readTaskGraph } from './subagents.mjs';
import { createWorkspaceExtension, workspaceTools } from './tools.mjs';
import {
  CHANGE_CACHE_MS,
  WorkspaceSnapshot,
  appendOutsideChanges,
  captureWorktree,
  decorateGitChanges,
  gitPrefix,
  indexFileFor,
  isOutsideWorkspacePath,
  listWorktreeChanges,
  readTreeBlob,
} from './workspace-snapshot.mjs';
import { decodeWorkspaceBytes } from './workspace-text.mjs';
import { activeContextUsage, installUsageExtension } from './usage.mjs';
import { createAntigravityCwdExtension } from './antigravity-cwd.mjs';
import { createWorkspaceEnv } from './workspace-env.mjs';
import { createCompactionControl } from './compaction-settings.mjs';
import { readTriggerPercent } from '../core/settings.mjs';
import {
  describeForkPoint,
  forkError,
  forkPrefillJson,
  forkTitle,
  prefillFromStored,
} from './fork.mjs';

const DETAIL_CAP = 1024 * 1024;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Harness settings. `WEFT_RETRY_MAX` is the number of attempts including the
 * first; Pi Durable's `maxRetries` counts the attempts after that.
 *
 * Backoff is Pi Durable's `retryDelayMs`: `min(baseDelayMs * 2^(attempt-1), maxAgentDelayMs)`
 * with no jitter. `attempt` is the failed attempt, starting at 1. `maxAgentDelayMs` is left
 * unset so the merged policy keeps Pi Durable's 60000 cap. The defaults (base 2000, 9 retries)
 * sleep 2000+4000+8000+16000+32000+60000*4 = 302000 ms.
 */
export function kernelSettings(env = process.env) {
  const maxAttempts = positiveInt(env.WEFT_RETRY_MAX, 10);
  return {
    retry: {
      enabled: true,
      maxRetries: Math.max(0, maxAttempts - 1),
      baseDelayMs: positiveInt(env.WEFT_RETRY_BASE_MS, 2000),
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
  const compaction = createCompactionControl(models);
  const modelRoutes = createKernelModels({
    models,
    getSettings,
    env,
    extraProviders,
    onSynced(stored) {
      compaction.setPercent(readTriggerPercent(stored));
    },
  });
  const routes = faux ? null : modelRoutes;
  const registry = createRegistry();
  const agentBridge = {};
  const subagentApi = {};
  const watches = new Map();
  // One official ConversationTranscript per harness conversation. The watch window
  // merges into it; loadEarlier/fillGap run only for a hole that is still open.
  const histories = new Map();
  const historyLocks = new Map();
  const tails = new Map();
  const listeners = new Map();
  const sends = new Map();
  const forkInflight = new Map();
  const changeCache = new Map();
  const changeGen = new Map();
  const changeInflight = new Map();
  const snapshotLocks = new Map();
  const allListeners = new Set();
  const baseSettings = kernelSettings(env);
  const retryMaxAttempts = baseSettings.retry.maxRetries + 1;
  if (typeof getSettings === 'function') {
    try {
      compaction.setPercent(readTriggerPercent(await getSettings()));
    } catch {
      compaction.setPercent(readTriggerPercent(null));
    }
  }
  const settings = () => ({ ...baseSettings, compaction: compaction.current() });
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
  installAgentExtensions(registry, agentBridge, { dataDir });
  installUsageExtension(registry);
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
    env: async ({ cwd }) => (cwd ? createWorkspaceEnv({ cwd, dataDir }) : undefined), // main Agent and sub-agents; bash env allow-list lives here
  });
  const { harness, context } = kernel;
  antigravityCwd.harness = harness;
  antigravityCwd.context = context;

  function invalidateChangeCache(cid) {
    changeGen.set(cid, (changeGen.get(cid) || 0) + 1);
    changeCache.delete(cid);
  }

  function withSnapshotLock(cid, fn) {
    const prev = snapshotLocks.get(cid) || Promise.resolve();
    const run = prev.then(fn, fn);
    snapshotLocks.set(cid, run.then(() => {}, () => {}));
    return run;
  }

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
    // Active transcript the model sees: compaction head plus the entries it keeps.
    return conversation.context(context);
  }

  async function watchConversation(harnessId) {
    const conversation = await harness.conversation(harnessId, context);
    if (!conversation) return null;
    return conversation.watch(context);
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

  function withHistory(key, fn) {
    const prev = historyLocks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    historyLocks.set(key, run.then(() => {}, () => {}));
    return run;
  }

  function historySlot(conversation) {
    const key = Number(conversation.id);
    const existing = histories.get(key);
    if (existing) return existing;
    // Official loader: one range page and no cursor. ConversationTranscript turns
    // the previous page's bound into the next maxEntryId or gap.
    const transcript = new ConversationTranscript((query, limit, ctx) => (
      conversation.entries(query, limit, undefined, ctx)
    ));
    const slot = { key, transcript, view: null };
    histories.set(key, slot);
    return slot;
  }

  function historyEntryList(view) {
    const entries = [];
    for (const item of view?.items || []) {
      if (item?.kind === 'entry') entries.push(item.entry);
    }
    return entries;
  }

  function historyHasHole(view) {
    return (view?.items || []).some((item) => item?.kind === 'earlier' || item?.kind === 'gap');
  }

  async function syncHistoryWindow(slot, conversation) {
    const watch = await conversation.watch(context);
    try {
      slot.view = slot.transcript.merge(watch.value);
    } finally {
      await watch.stop();
    }
  }

  async function advanceHistory(slot) {
    const items = slot.view?.items || [];
    const earlier = items.find((item) => item?.kind === 'earlier');
    if (earlier) {
      slot.view = await slot.transcript.loadEarlier(context);
      return;
    }
    const gap = items.find((item) => item?.kind === 'gap');
    if (gap) slot.view = await slot.transcript.fillGap(gap, context);
  }

  /**
   * Entries the user can still see. `entryId` stops at the official page that
   * contains it. Otherwise only an open earlier marker or gap is paged, one
   * ConversationTranscript page at a time. A transcript that already reaches
   * that point does not call entries() again. A page that adds nothing throws
   * instead of dropping the rest of the history.
   */
  async function readHistory(harnessId, entryId) {
    const conversation = await harness.conversation(harnessId, context);
    if (!conversation) return [];
    const slot = historySlot(conversation);
    const want = entryId == null || entryId === '' ? null : String(entryId);
    return withHistory(slot.key, async () => {
      await syncHistoryWindow(slot, conversation);
      let spins = 0;
      while (slot.view && historyHasHole(slot.view)) {
        if (want && historyEntryList(slot.view).some((entry) => String(entry.id) === want)) break;
        const before = slot.view.items;
        await advanceHistory(slot);
        if (!slot.view || slot.view.items === before) {
          throw new Error('transcript page made no progress');
        }
        if (++spins > 100000) throw new Error('transcript page did not converge');
      }
      return historyEntryList(slot.view);
    });
  }

  async function readTranscript(harnessId) {
    const entries = await readHistory(harnessId);
    const mapped = messagesFromEntries(entries);
    // `usage` here is the newest reported call in the stored history. The context
    // chip must not use it: a call from before the compaction head is not the
    // context the model sees. present() reads that from readView().
    return { ...mapped, entries };
  }

  async function resolveTitleModel(conv) {
    if (faux) return models.getModel(FAUX_MODEL.provider, FAUX_MODEL.modelId) || null;
    if (!routes) return null;
    const ref = await routes.modelFor(conv);
    if (!ref) return null;
    return models.getModel(ref.provider, ref.modelId) || null;
  }

  async function deliver(cid, ev) {
    if (ev?.event === 'tool.end') invalidateChangeCache(cid);
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

  async function applyView(cid, view, mapCtx, projector) {
    const conv = await store.getConversation(cid);
    mapCtx.contextWindow = await conversationWindow(conv);
    const mapped = projectViewUpdate(projector, view, mapCtx);
    for (const ev of mapped.events) await deliver(cid, ev);
    if (mapped.refresh || mapped.runEnded) {
      const current = await store.getConversation(cid);
      const status = await submissionView(current);
      if (mapped.runEnded && status.status === 'failed' && status.llmError) {
        await deliver(cid, { event: 'error', data: status.llmError });
      }
      await deliver(cid, { event: 'status', data: { status: status.status } });
    }
  }

  async function attach(row) {
    if (!row?.harnessId || watches.has(row.id)) return;
    const conversation = await harness.conversation(row.harnessId, context);
    if (!conversation) return;
    const slot = historySlot(conversation);
    const watch = await conversation.watch(context);
    const mapCtx = createMapContext({ retry: baseSettings.retry });
    const projector = createViewProjector();
    watches.set(row.id, { stream: watch, mapCtx, projector, harnessId: row.harnessId });
    await withHistory(slot.key, () => {
      slot.view = slot.transcript.merge(watch.value);
    });
    await applyView(row.id, watch.value, mapCtx, projector);
    watch.start((call) => enqueue(row.id, async () => {
      if (call?.kind !== 'value') return;
      try {
        await withHistory(slot.key, () => {
          slot.view = slot.transcript.merge(call.value);
        });
        await applyView(row.id, call.value, mapCtx, projector);
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
    watchConversation,
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
      return { missing: false, text: decodeWorkspaceBytes(await readFile(abs)) };
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

  async function readSnapshot(harnessId) {
    if (harnessId == null) return null;
    try {
      const snap = await harness.snapshot(WorkspaceSnapshot, harnessId, context);
      if (!snap || (snap.mode !== 'git' && snap.mode !== 'fallback')) return null;
      return { mode: snap.mode, tree: typeof snap.tree === 'string' ? snap.tree : '' };
    } catch {
      return null;
    }
  }

  /**
   * First send captures the worktree. Later sends reuse the stored tree id.
   * Failure is recorded as fallback so a missing git does not run on every refresh.
   */
  async function ensureWorkspaceSnapshot(conv) {
    if (!conv?.id || conv.harnessId == null) return { mode: 'fallback', tree: '' };
    return withSnapshotLock(conv.id, async () => {
      const existing = await readSnapshot(conv.harnessId);
      if (existing) return existing;
      // A conversation that already has a user message started before snapshots
      // existed. Photographing it now would hide those edits. Model configuration
      // and other non-user entries do not count: applyModel can write them
      // before the first send.
      const transcript = await readTranscript(conv.harnessId);
      const started = (transcript.entries || []).some((entry) => entry?.kind === 'pi.user');
      let stored = { mode: 'fallback', tree: '' };
      if (!started) {
        const workspacePath = conv.workspacePath || '';
        const captured = workspacePath
          ? await captureWorktree({
            cwd: workspacePath,
            indexFile: indexFileFor(dataDir, conv.id, workspacePath),
            env,
          })
          : { mode: 'fallback', tree: '' };
        if (captured.mode === 'git' && captured.tree) stored = { mode: 'git', tree: captured.tree };
      }
      try {
        await harness.commit(async (tx) => {
          const state = await tx.doc(WorkspaceSnapshot, conv.harnessId);
          if (state.mode === 'git' || state.mode === 'fallback') return;
          state.mode = stored.mode;
          state.tree = stored.tree;
        }, context);
      } catch (err) {
        console.error(`WEFT_CHANGE_SNAPSHOT ${redactAuthText(err instanceof Error ? err.message : err)}`);
        return { mode: 'fallback', tree: '' };
      }
      return stored;
    });
  }

  async function rowsFromBaselines(workspacePath, baselines) {
    const rows = [];
    for (const baseline of baselines) {
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
  }

  async function computeChanges(cid) {
    const conv = await store.getConversation(cid);
    const baselines = await baselinesFor(cid);
    const workspacePath = conv?.workspacePath || await workspacePathFor(cid);
    const snap = conv?.harnessId != null ? await readSnapshot(conv.harnessId) : null;
    if (!snap || snap.mode !== 'git' || !snap.tree) {
      return { cache: false, rows: await rowsFromBaselines(workspacePath, baselines) };
    }
    try {
      const entries = await listWorktreeChanges({
        cwd: workspacePath,
        indexFile: indexFileFor(dataDir, cid, workspacePath),
        baseTree: snap.tree,
        env,
      });
      const gitRows = decorateGitChanges(entries, baselines);
      const outside = await rowsFromBaselines(
        workspacePath,
        baselines.filter((row) => isOutsideWorkspacePath(row.path)),
      );
      return { cache: true, rows: appendOutsideChanges(gitRows, outside) };
    } catch (err) {
      console.error(`WEFT_CHANGE_DIFF ${redactAuthText(err instanceof Error ? err.message : err)}`);
      return { cache: false, rows: await rowsFromBaselines(workspacePath, baselines) };
    }
  }

  async function changes(cid) {
    const gen = changeGen.get(cid) || 0;
    const hit = changeCache.get(cid);
    if (hit && hit.gen === gen && Date.now() - hit.at < CHANGE_CACHE_MS) return hit.rows;
    const pending = changeInflight.get(cid);
    if (pending && pending.gen === gen) return pending.promise;
    const promise = computeChanges(cid).then((result) => {
      if (result.cache && (changeGen.get(cid) || 0) === gen) {
        changeCache.set(cid, { at: Date.now(), gen, rows: result.rows });
      }
      return result.rows;
    }).finally(() => {
      if (changeInflight.get(cid)?.promise === promise) changeInflight.delete(cid);
    });
    changeInflight.set(cid, { gen, promise });
    return promise;
  }

  async function legacyDiff(workspacePath, baseline) {
    if (baseline.oversized || baseline.error) {
      return {
        status: 200,
        body: {
          path: baseline.path,
          added: baseline.added ?? 0,
          removed: baseline.removed ?? 0,
          error: '文件过大',
        },
      };
    }
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
  }

  async function gitDiff(cid, row) {
    if (row.error) {
      return {
        status: 200,
        body: {
          path: row.path,
          added: row.added ?? 0,
          removed: row.removed ?? 0,
          error: row.error,
        },
      };
    }
    const conv = await store.getConversation(cid);
    const snap = conv?.harnessId != null ? await readSnapshot(conv.harnessId) : null;
    const workspacePath = await workspacePathFor(cid);
    if (!snap || snap.mode !== 'git' || !snap.tree) return legacyDiff(workspacePath, row);
    const prefix = await gitPrefix(workspacePath, env);
    let before = '';
    if (row.status !== 'added') {
      const blob = await readTreeBlob({
        cwd: workspacePath,
        tree: snap.tree,
        prefix,
        rel: row.status === 'renamed' ? (row.oldPath || row.path) : row.path,
        env,
      });
      if (blob.tooLarge || blob.binary) {
        return {
          status: 200,
          body: { path: row.path, added: row.added ?? 0, removed: row.removed ?? 0, error: '文件过大' },
        };
      }
      before = blob.text || '';
    }
    let disk = '';
    if (row.status !== 'deleted') {
      let read;
      try {
        read = await readWorkspaceText(workspacePath, row.path);
      } catch (err) {
        if (err?.code === 'E_TOO_LARGE') {
          return {
            status: 200,
            body: { path: row.path, added: row.added ?? 0, removed: row.removed ?? 0, error: '文件过大' },
          };
        }
        throw err;
      }
      disk = read.missing || read.text == null ? '' : read.text;
    }
    return {
      status: 200,
      body: liveDiff({
        path: row.path,
        before,
        storedAfter: before,
        diskText: disk,
      }),
    };
  }

  async function diff(cid, filePath) {
    const want = String(filePath ?? '').replaceAll('\\', '/');
    const rows = await changes(cid);
    const row = rows.find((item) => {
      const current = String(item.path ?? '').replaceAll('\\', '/');
      const previous = item.oldPath ? String(item.oldPath).replaceAll('\\', '/') : '';
      return current === want || previous === want;
    });
    if (!row) return { status: 404, body: { error: 'no diff' } };
    if (row.status) return gitDiff(cid, row);
    const baseline = (await baselinesFor(cid)).find((item) => String(item.path ?? '').replaceAll('\\', '/') === want);
    if (!baseline) return { status: 404, body: { error: 'no diff' } };
    return legacyDiff(await workspacePathFor(cid), baseline);
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

  async function adoptConversation(fields) {
    const conv = await store.createConversation(fields);
    if (agentHost) await agentHost.afterCreate(conv);
    await attach(conv);
    return conv;
  }

  function forkResponse(row, prefill) {
    const stored = prefill !== undefined ? prefill : prefillFromStored(row?.forkPrefillJson);
    return {
      status: 201,
      body: {
        conversationId: String(row?.id ?? ''),
        prefill: stored,
      },
    };
  }

  /**
   * Fork one Weft conversation at a harness entry. Assistant cuts include that
   * entry. User cuts stop before it and return its text as prefill; the first
   * message becomes an empty conversation in the same workspace. Pi Durable
   * Conversation.fork copies history and the agent as of that entry. No fork
   * tool is registered for the model.
   */
  async function forkConversation(cid, { entryId, requestId, lang } = {}) {
    const id = typeof cid === 'string' ? cid.trim() : '';
    const given = typeof requestId === 'string' ? requestId.trim() : '';
    const key = given ? `${id}\0${given}` : '';
    if (key) {
      const pending = forkInflight.get(key);
      if (pending) return pending;
    }
    const run = forkConversationOnce(id, { entryId, requestId: given, lang });
    if (!key) return run;
    forkInflight.set(key, run);
    run.finally(() => {
      if (forkInflight.get(key) === run) forkInflight.delete(key);
    });
    return run;
  }

  async function forkConversationOnce(id, { entryId, requestId, lang } = {}) {
    const conv = id ? await store.getConversation(id) : null;
    if (!conv?.harnessId) return { status: 404, body: { error: 'not found' } };
    const language = lang === 'en' ? 'en' : 'zh';
    if (requestId && typeof store.findFork === 'function') {
      const prior = await store.findFork(conv.id, requestId);
      if (prior) return forkResponse(prior);
    }
    const point = describeForkPoint((await readTranscript(conv.harnessId)).entries, entryId);
    if (!point.ok) return forkError(point.code, language);
    const shared = {
      workspaceId: conv.workspaceId,
      workspacePath: conv.workspacePath,
      title: forkTitle(conv.title, language),
      titleSource: 'user',
      modelSourceId: conv.modelSourceId,
      modelId: conv.modelId,
      thinkingLevel: conv.thinkingLevel,
      forkedFromId: conv.id,
      forkedFromTitle: conv.title == null ? '' : String(conv.title),
      forkRequestId: requestId || null,
      forkPrefillJson: forkPrefillJson(point.prefill),
    };
    let created;
    if (point.empty) {
      created = await createConversation(shared);
    } else {
      const conversation = await conversationFor(conv);
      if (!conversation) return { status: 404, body: { error: 'not found' } };
      const forked = await conversation.fork(point.at, { ownership: { kind: 'ownerless' } }, context);
      created = await adoptConversation({ ...shared, harnessId: forked.id });
    }
    return forkResponse(created, point.prefill);
  }

  return {
    harness,
    context,
    async hasActiveWork() {
      const graph = await readTaskGraph(harness, context);
      return Object.keys(graph?.tasks || {}).length > 0;
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
    forkConversation,
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
    changes,
    diff,
    async getMessageImage(cid, messageId, index) {
      const conv = await store.getConversation(cid);
      if (!conv?.harnessId) return null;
      const entries = await readHistory(conv.harnessId, messageId);
      return findUserMessageImage(entries, messageId, index);
    },
    async getMessagePaste(cid, messageId, index) {
      const conv = await store.getConversation(cid);
      if (!conv?.harnessId) return null;
      const entries = await readHistory(conv.harnessId, messageId);
      return findUserMessagePaste(entries, messageId, index);
    },
    liveStateFor(cid) {
      const watch = watches.get(cid);
      const docs = watch?.stream?.value?.docs;
      const live = docs && typeof docs === 'object' ? docs['pi.live'] : null;
      return live && typeof live === 'object' ? live : null;
    },
    async present(conv, { includeMessages = false } = {}) {
      if (!conv?.harnessId) {
        return { ...conv, status: 'idle', messages: includeMessages ? [] : undefined, sends: [], live: null, retryMaxAttempts };
      }
      const view = await submissionView(conv);
      const status = view.status;
      let messages;
      // Context percent follows the active transcript. A call from before the
      // compaction or reset head measured the prefix that head replaced.
      // With no later call, estimate the messages the model will see.
      const harnessView = await readView(conv.harnessId);
      const usage = presentContext(activeContextUsage(harnessView)).usage;
      if (includeMessages) {
        messages = (await readTranscript(conv.harnessId)).messages;
      }
      const out = { ...conv, status, usage, sends: await sendsView(conv), live: this.liveStateFor(conv.id), retryMaxAttempts };
      if (view.llmError) out.llmError = view.llmError;
      if (includeMessages) out.messages = messages;
      return out;
    },
    /**
     * Official Conversation.compact. It always admits a task and returns its id.
     * Nothing to compact completes with an empty result (no summary, no failure).
     * A busy conversation still accepts it; the summary is placed at the next
     * boundary. A second call admits another task. Official placement keeps the
     * furthest cut and may settle a nearer summary as stale. This does not add a lock.
     */
    async compact(cid, instructions) {
      const conv = await store.getConversation(cid);
      if (!conv) return { status: 404, body: { error: 'conversation not found', code: 'E_NOT_FOUND' } };
      const conversation = await conversationFor(conv);
      if (!conversation) return { status: 404, body: { error: 'conversation not found', code: 'E_NOT_FOUND' } };
      try {
        await modelRoutes.warm();
      } catch (err) {
        const message = redactAuthText(err instanceof Error ? err.message : err);
        return { status: 500, body: { error: message || 'settings refresh failed', code: 'E_INTERNAL' } };
      }
      try {
        const taskId = await conversation.compact(instructions, context);
        return { status: 202, body: { taskId: String(taskId) } };
      } catch (err) {
        if (err?.name === 'ConversationBusy') {
          return { status: 409, body: { error: 'busy', code: 'E_BUSY' } };
        }
        const message = redactAuthText(err instanceof Error ? err.message : err);
        return { status: 500, body: { error: message || 'compact failed', code: 'E_INTERNAL' } };
      }
    },
    async noteSettings(stored) {
      compaction.setPercent(readTriggerPercent(stored));
      await modelRoutes.warm();
    },
    async postMessage(conv, text, options = {}) {
      try {
        await modelRoutes.warm();
      } catch (err) {
        console.error(`WEFT_COMPACTION_SETTINGS ${redactAuthText(err instanceof Error ? err.message : err)}`);
      }
      const conversation = await conversationFor(conv);
      if (!conversation) return { status: 404, body: { error: 'conversation not found' } };
      const prepared = agentHost ? await agentHost.prepareSend(conv, text) : null;
      const current = prepared?.conversation || conv;
      if (routes) {
        await applyModel(conversation, current);
      }
      try {
        await ensureWorkspaceSnapshot(current);
      } catch (err) {
        console.error(`WEFT_CHANGE_SNAPSHOT ${redactAuthText(err instanceof Error ? err.message : err)}`);
      }
      const given = typeof options.requestId === 'string' ? options.requestId.trim() : '';
      const requestId = given || prepared?.requestId || randomUUID();
      if (options.continue) {
        try {
          const submission = await conversation.submit({ type: 'continue', requestId }, context);
          await store.updateConversation(current.id, { lastSubmissionId: submission.id });
          return { status: 202, body: { runId: String(submission.id), status: 'running' } };
        } catch (err) {
          if (err instanceof ConversationBusy || err?.name === 'ConversationBusy') {
            return { status: 409, body: { error: 'conversation is busy', code: 'ConversationBusy' } };
          }
          throw err;
        }
      }
      let content = options.content !== undefined ? options.content : text;
      let entry;
      const mode = sendModeOf(options.mode);
      if (options.answer) {
        const prior = recentSendsFor(sends, current.id).find((row) => row.requestId === requestId && !row.dropped);
        if (prior) return { status: 202, body: { runId: String(prior.submissionId), status: 'running' } };
        const transcript = current.harnessId ? await readTranscript(current.harnessId) : { entries: [] };
        const decided = buildAskSubmission(transcript.entries, options.answer);
        if (!decided.ok) return { status: decided.status, body: { error: decided.error, code: decided.code } };
        content = decided.content;
        entry = decided.entry;
      }
      const submission = await conversation.submit({
        type: 'input',
        content,
        requestId,
        whenBusy: whenBusyForMode(mode),
        ...(entry ? { entry } : {}),
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
        text: options.answer && typeof content === 'string'
          ? content
          : (typeof text === 'string' ? text : ''),
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
