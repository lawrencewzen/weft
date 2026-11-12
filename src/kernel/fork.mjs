// Where a thread message can fork, using Pi Durable entries already committed.
// The host does not offer a fork tool. Conversation.fork does the copy.
import { parseUserMessageParts } from '../core/user-message-parts.mjs';
import { isAutoContinueText, isPromptUserMessage } from './continuation-text.mjs';
import { textOf } from './events.mjs';
import { USER_TO_SUBAGENT_KIND } from './ids.mjs';

const DEFAULT_TITLE = 'New conversation';
const FORK_SUFFIX = /(?:\s*\(fork(?:\s+(\d+))?\)|\s*（分叉）)\s*$/;

/**
 * Title of a fork: "<base> (fork)", numbered "(fork N)" from the second one.
 * Trailing suffixes are stripped first, so a fork of a fork does not stack them.
 * The source's own suffix sets the count: none -> (fork); (fork) -> (fork 2);
 * (fork N) -> (fork N+1). Each legacy "（分叉）" counts as one, so
 * "X（分叉）（分叉）" is the 2nd and its fork is "X (fork 3)".
 * An empty title falls back to the store's default title.
 * `lang` is accepted for callers but the suffix is the same in every language.
 */
export function forkTitle(title, _lang) {
  let base = title == null ? '' : String(title).trim();
  let count = 0;
  for (;;) {
    const match = FORK_SUFFIX.exec(base);
    if (!match) break;
    count += match[1] ? Number(match[1]) : 1;
    base = base.slice(0, match.index).trimEnd();
  }
  if (!base) base = DEFAULT_TITLE;
  const next = count + 1;
  return next === 1 ? `${base} (fork)` : `${base} (fork ${next})`;
}

export function forkError(code, lang) {
  const en = lang === 'en';
  if (code === 'E_ENTRY_NOT_FOUND') {
    return {
      status: 400,
      body: { error: en ? 'Entry not found' : '指定的消息不存在', code },
    };
  }
  return {
    status: 400,
    body: { error: en ? 'entryId is required' : '需要 entryId', code: 'E_BAD_REQUEST' },
  };
}

function userBody(entry) {
  return parseUserMessageParts(entry?.model?.[0]?.content).text;
}

function assistantBody(entry) {
  return textOf(entry?.model?.[0]?.content);
}

/** An entry the thread actually shows. Auto-continue leftovers do not count. */
function isVisibleEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.kind === 'pi.assistant') return Boolean(assistantBody(entry).trim());
  if (entry.kind === 'pi.tool-result' || entry.kind === 'pi.compaction') return true;
  if (entry.kind === USER_TO_SUBAGENT_KIND) return true;
  if (entry.kind === 'pi.user') return !isAutoContinueText(userBody(entry));
  return false;
}

function isForkableAssistant(entry) {
  return entry?.kind === 'pi.assistant' && Boolean(assistantBody(entry).trim());
}

function isForkableUser(entry) {
  if (entry?.kind !== 'pi.user') return false;
  return isPromptUserMessage({ role: 'user', text: userBody(entry) });
}

function isToolCallEntry(entry) {
  return entry?.kind === 'pi.assistant' && Array.isArray(entry.model?.[0]?.content);
}

/**
 * Move a cut forward so it does not split a tool call from its result.
 * A tool result is committed after the assistant entry that made the call, and
 * other entries can land in between (a subagent report, another call's result).
 * Cutting at the assistant entry would keep the call and drop the result. The
 * fork then has a call that never finishes, and the thread puts it at the very
 * end of the conversation. So the cut grows to the last result of any call kept.
 * If that would pull in a message the person can see, the cut stays where it was.
 */
export function settleToolResults(entries, cutIndex) {
  const list = Array.isArray(entries) ? entries : [];
  if (cutIndex < 0) return cutIndex;
  const calls = new Set();
  for (let i = 0; i <= cutIndex; i += 1) {
    if (!isToolCallEntry(list[i])) continue;
    for (const block of list[i].model[0].content) {
      if (block?.type === 'toolCall' && block.id != null) calls.add(String(block.id));
    }
  }
  if (!calls.size) return cutIndex;
  const done = new Set();
  for (let i = 0; i <= cutIndex; i += 1) {
    const id = list[i]?.kind === 'pi.tool-result' ? list[i].model?.[0]?.toolCallId : null;
    if (id != null) done.add(String(id));
  }
  let last = cutIndex;
  for (let i = cutIndex + 1; i < list.length; i += 1) {
    const entry = list[i];
    const id = entry?.kind === 'pi.tool-result' ? entry.model?.[0]?.toolCallId : null;
    if (id != null && calls.has(String(id)) && !done.has(String(id))) last = i;
  }
  if (last === cutIndex) return cutIndex;
  for (let i = cutIndex + 1; i <= last; i += 1) {
    if (isForkableAssistant(list[i]) || isForkableUser(list[i])) return cutIndex;
  }
  return last;
}

/**
 * Decide the fork cut for one harness entry id.
 * Assistant: include that entry (`at` is the entry). Prefill is null.
 * User: include only entries before it. The first message has no earlier
 * visible entry, so the caller creates an empty conversation and still
 * returns this message as prefill.
 */
export function describeForkPoint(entries, entryId) {
  const want = String(entryId ?? '').trim();
  if (!want) return { ok: false, code: 'E_BAD_REQUEST' };
  const list = Array.isArray(entries) ? entries : [];
  const index = list.findIndex((entry) => entry && String(entry.id) === want);
  if (index < 0) return { ok: false, code: 'E_ENTRY_NOT_FOUND' };
  const target = list[index];
  if (isForkableAssistant(target)) {
    const cut = settleToolResults(list, index);
    return { ok: true, kind: 'assistant', at: list[cut].id, prefill: null, empty: false };
  }
  if (isForkableUser(target)) {
    const earlier = list.slice(0, index).some(isVisibleEntry);
    const cut = earlier ? settleToolResults(list, index - 1) : -1;
    return {
      ok: true,
      kind: 'user',
      at: earlier ? list[cut].id : null,
      prefill: { text: userBody(target) },
      empty: !earlier,
    };
  }
  return { ok: false, code: 'E_ENTRY_NOT_FOUND' };
}

export function forkPrefillJson(prefill) {
  if (prefill == null) return null;
  return JSON.stringify(prefill.text == null ? '' : String(prefill.text));
}

export function prefillFromStored(json) {
  if (json == null) return null;
  let text = '';
  try {
    const parsed = JSON.parse(String(json));
    text = parsed == null ? '' : String(parsed);
  } catch {
    text = String(json);
  }
  return { text };
}
