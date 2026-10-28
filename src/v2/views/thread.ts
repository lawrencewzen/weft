/** Conversation thread: messages → ThreadItem list + ToolCall rows. No DOM. */

import { phrase, type Lang } from '../phrases/index.ts';
import type { components } from '../contract.gen.ts';
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
};

export type ThreadSubagent = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
};

export type BuildThreadOptions = {
  lang?: Lang;
  workspacePath?: string;
  conversationId?: string;
  subagents?: ThreadSubagent[];
  running?: boolean;
  exists?: ExtractPathRefsOptions['exists'];
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

/** Last non-empty, non-correction assistant. Same walk as public/app.js lastVisibleAssistant. */
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

/** Same lookup as public/app.js findAgentForReport. */
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
 * Messages → thread items. Rules match public/app.js threadBlocksHtml:
 * consecutive tools form one group; empty assistants are skipped (and do not split a group);
 * subagent reports and auto-continues are not user bubbles.
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
      if (!isPromptUserMessage(m)) {
        items.push({
          kind: 'system_note',
          id: messageId(m),
          noteKind: 'auto_continue',
          text: phrase(lang, 'auto_continue_note'),
        });
        continue;
      }
      const userItem: components['schemas']['ThreadItemUser'] = {
        kind: 'user',
        id: messageId(m),
        text: messageText(m),
        pathRefs: await pathRefsFor(m.text, { workspacePath, exists }),
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
    const assistant: components['schemas']['ThreadItemAssistant'] = {
      kind: 'assistant',
      id: messageId(m),
      text: messageText(m),
      pathRefs: await pathRefsFor(m.text, { workspacePath, exists }),
      streaming: false,
      truncated: m === truncatedMsg && m?.stopReason === 'length',
    };
    const model = typeof m?.model === 'string' && m.model ? m.model : '';
    if (model) assistant.model = model;
    items.push(assistant);
  }

  flushTools(Boolean(running));
  return { items, tools };
}
