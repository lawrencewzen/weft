/** Conversation thread: messages → ThreadItem list + ToolCall rows. No DOM. */

import { phrase, type Lang } from '../phrases/index.ts';
import type { components } from '../contract.gen.ts';
import type { Change } from './changes.ts';
import { isPromptUserMessage } from './continuation.ts';
import { parseSubagentReport } from './subagent-report.ts';
import { extractPathRefs, type ExtractPathRefsOptions } from './path-refs.ts';
import { toThreadUserImages } from './message-images.ts';
import {
  toolCallView,
  toolGroupKey,
  toolGroupSummaryView,
  type ToolLike,
} from './tools.ts';

export type ThreadItem = components['schemas']['ThreadItem'];
export type ToolCall = components['schemas']['ToolCall'];
export type PathRef = components['schemas']['PathRef'];

export type ThreadMessage = {
  id?: unknown;
  role?: unknown;
  kind?: unknown;
  text?: unknown;
  model?: unknown;
  stopReason?: unknown;
  streaming?: unknown;
  tool?: ToolLike;
  images?: Array<{
    index?: unknown;
    mediaType?: unknown;
    mimeType?: unknown;
    name?: unknown;
    bytes?: unknown;
    data?: unknown;
  }>;
  pastes?: Array<{
    lines?: unknown;
    chars?: unknown;
    preview?: unknown;
  }>;
  files?: Array<{
    path?: unknown;
    name?: unknown;
    bytes?: unknown;
  }>;
  /** Harness entry id when this message can be forked. Null when it cannot. */
  entryId?: unknown;
};

export type ThreadSubagent = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
};

export type TurnChangeRecord = {
  id: string;
  anchorId: string;
  changes: Change[];
};

export type BuildThreadOptions = {
  lang?: Lang;
  workspacePath?: string;
  conversationId?: string;
  subagents?: ThreadSubagent[];
  running?: boolean;
  exists?: ExtractPathRefsOptions['exists'];
  /** Stored per-turn file lists. Missing records (old conversations) insert nothing. */
  turnChanges?: readonly TurnChangeRecord[] | null;
};

export type ThreadView = {
  items: ThreadItem[];
  tools: ToolCall[];
};

function messageId(message: ThreadMessage | null | undefined): string {
  return String(message?.id ?? '');
}

function messageText(message: ThreadMessage | null | undefined): string {
  return String(message?.text ?? '');
}

/** Real harness entry id, or null while streaming or for a live placeholder. */
export function forkEntryId(message: ThreadMessage | null | undefined): string | null {
  if (!message || message.streaming === true) return null;
  const raw = message.entryId !== undefined ? message.entryId : message.id;
  if (raw == null) return null;
  const id = String(raw).trim();
  if (!id || id === 'live' || id.startsWith('live-') || id.startsWith('live:')) return null;
  return id;
}

function asNonNegInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function toThreadUserPastes(
  pastes: ThreadMessage['pastes'] | null | undefined,
): components['schemas']['ThreadUserPaste'][] {
  if (!Array.isArray(pastes) || !pastes.length) return [];
  const out: components['schemas']['ThreadUserPaste'][] = [];
  for (const row of pastes) {
    if (!row || typeof row !== 'object') continue;
    const lines = asNonNegInt(row.lines);
    const chars = asNonNegInt(row.chars);
    if (lines == null || chars == null) continue;
    out.push({
      lines,
      chars,
      preview: typeof row.preview === 'string' ? row.preview : '',
    });
  }
  return out;
}

function toThreadUserFiles(
  files: ThreadMessage['files'] | null | undefined,
): components['schemas']['ThreadUserFile'][] {
  if (!Array.isArray(files) || !files.length) return [];
  const out: components['schemas']['ThreadUserFile'][] = [];
  for (const row of files) {
    if (!row || typeof row !== 'object') continue;
    const filePath = typeof row.path === 'string' ? row.path.trim() : '';
    if (!filePath) continue;
    const bytes = asNonNegInt(row.bytes) ?? 0;
    const name = typeof row.name === 'string' && row.name.trim()
      ? row.name.trim()
      : filePath.replaceAll('\\', '/').split('/').filter(Boolean).pop() || filePath;
    out.push({ path: filePath.replaceAll('\\', '/'), name, bytes });
  }
  return out;
}

/** Last non-empty, non-correction assistant. */
export function lastVisibleAssistant(messages: ThreadMessage[] | null | undefined): ThreadMessage | null {
  const msgs = messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role === 'assistant' && m.kind !== 'correction' && String(m.text || '').trim()) return m;
  }
  return null;
}

function isRealSubagent(agent: ThreadSubagent | null | undefined): boolean {
  return String(agent?.id || '').includes(':sub:');
}

/** Find a real subagent (`:sub:` in id) by exact name. */
export function findAgentForReport(
  name: unknown,
  subagents: ThreadSubagent[] | null | undefined,
): ThreadSubagent | null {
  const key = String(name || '');
  if (!key) return null;
  return (subagents || []).find((agent) => (
    isRealSubagent(agent) && String(agent.name || '') === key
  )) || null;
}

async function pathRefsFor(
  text: unknown,
  opts: { workspacePath: string; exists?: ExtractPathRefsOptions['exists'] },
): Promise<PathRef[]> {
  return extractPathRefs(text, { workspacePath: opts.workspacePath, exists: opts.exists });
}

/**
 * Messages → thread items. Rules:
 * consecutive tools form one group; empty assistants are skipped (and do not split a group);
 * subagent reports are not user bubbles. Legacy auto-continue user messages are omitted.
 */
export async function buildThread(
  messages: ThreadMessage[] | null | undefined,
  {
    lang = 'zh',
    workspacePath = '',
    conversationId = '',
    subagents = [],
    running = false,
    exists,
    turnChanges,
  }: BuildThreadOptions = {},
): Promise<ThreadView> {
  const msgs = Array.isArray(messages) ? messages : [];
  const truncatedMsg = lastVisibleAssistant(msgs);
  const items: ThreadItem[] = [];
  const tools: ToolCall[] = [];
  const pending: ToolLike[] = [];

  const flushTools = (live: boolean) => {
    if (!pending.length) return;
    const group = pending.slice();
    pending.length = 0;
    const groupId = toolGroupKey(group);
    const toolIds: string[] = [];
    for (const raw of group) {
      const view = toolCallView(raw, group, { lang, workspacePath });
      tools.push(view);
      toolIds.push(view.id);
    }
    items.push({
      kind: 'tool_group',
      id: groupId,
      toolIds,
      summary: toolGroupSummaryView(group, lang),
      live,
    });
  };

  for (const m of msgs) {
    if (m?.role === 'tool') {
      if (m.tool) pending.push(m.tool);
      else flushTools(false);
      continue;
    }
    if (m?.role === 'assistant' && m.kind !== 'correction' && !String(m.text || '').trim()) continue;
    flushTools(false);

    if (m?.kind === 'correction') {
      items.push({
        kind: 'system_note',
        id: messageId(m),
        noteKind: 'correction',
        text: messageText(m),
      });
      continue;
    }

    if (m?.role === 'note' && m.kind === 'compaction') {
      const detail = String(m.text || '').trim();
      const note: components['schemas']['ThreadItemSystemNote'] = {
        kind: 'system_note',
        id: messageId(m),
        noteKind: 'compaction',
        text: phrase(lang, 'compaction_note'),
      };
      if (detail) note.detail = detail;
      items.push(note);
      continue;
    }

    if (m?.role === 'note' && m.kind === 'handoff') {
      const detail = String(m.text || '').trim();
      const note: components['schemas']['ThreadItemSystemNote'] = {
        kind: 'system_note',
        id: messageId(m),
        noteKind: 'handoff',
        text: phrase(lang, 'handoff_new_context'),
      };
      if (detail) note.detail = detail;
      items.push(note);
      continue;
    }

    if (m?.role === 'note') {
      const note = String(m.text || '').trim();
      if (!note) continue;
      items.push({
        kind: 'system_note',
        id: messageId(m),
        noteKind: 'note',
        text: note,
      });
      continue;
    }

    if (m?.role === 'user') {
      const parsed = parseSubagentReport(m.text);
      const report = parsed || (m.kind === 'subagent-report'
        ? { name: '', kind: 'answered' as const, body: String(m.text || '') }
        : null);
      if (report) {
        const agent = findAgentForReport(report.name, subagents);
        items.push({
          kind: 'subagent_report',
          id: messageId(m),
          subagentId: agent?.id == null || String(agent.id) === '' ? null : String(agent.id),
          name: report.name,
          reportKind: report.kind === 'failed' ? 'failed' : 'answered',
          body: report.body,
        });
        continue;
      }
      if (!isPromptUserMessage(m)) continue;
      const userItem: components['schemas']['ThreadItemUser'] = {
        kind: 'user',
        id: messageId(m),
        text: messageText(m),
        pathRefs: await pathRefsFor(m.text, { workspacePath, exists }),
        entryId: forkEntryId(m),
      };
      const images = toThreadUserImages(m.images, conversationId, messageId(m));
      if (images.length) userItem.images = images;
      const pastes = toThreadUserPastes(m.pastes);
      if (pastes.length) userItem.pastes = pastes;
      const files = toThreadUserFiles(m.files);
      if (files.length) userItem.files = files;
      items.push(userItem);
      continue;
    }

    if (!String(m?.text || '').trim()) continue;
    const streaming = m.streaming === true;
    const assistant: components['schemas']['ThreadItemAssistant'] = {
      kind: 'assistant',
      id: messageId(m),
      text: messageText(m),
      pathRefs: await pathRefsFor(m.text, { workspacePath, exists }),
      streaming,
      truncated: !streaming && m === truncatedMsg && m?.stopReason === 'length',
      entryId: forkEntryId(m),
    };
    const model = typeof m?.model === 'string' && m.model ? m.model : '';
    if (model) assistant.model = model;
    items.push(assistant);
  }

  flushTools(Boolean(running));
  return { items: insertTurnChanges(items, turnChanges), tools };
}

/** Place each stored card immediately after that turn's last assistant reply. */
function insertTurnChanges(
  items: ThreadItem[],
  records: readonly TurnChangeRecord[] | null | undefined,
): ThreadItem[] {
  if (!records?.length) return items;
  const byAnchor = new Map<string, TurnChangeRecord>();
  for (const record of records) {
    if (!record?.anchorId || !record.id || !record.changes?.length) continue;
    if (!byAnchor.has(record.anchorId)) byAnchor.set(record.anchorId, record);
  }
  if (!byAnchor.size) return items;
  const out: ThreadItem[] = [];
  const used = new Set<string>();
  for (const item of items) {
    out.push(item);
    if (item.kind !== 'assistant') continue;
    const record = byAnchor.get(item.id);
    if (!record || used.has(record.id)) continue;
    used.add(record.id);
    out.push({
      kind: 'turn_changes',
      id: record.id,
      changes: record.changes,
    });
  }
  return out;
}
