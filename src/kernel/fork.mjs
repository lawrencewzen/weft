// Where a thread message can fork, using Pi Durable entries already committed.
// The host does not offer a fork tool. Conversation.fork does the copy.
import { parseUserMessageParts } from '../core/user-message-parts.mjs';
import { isAutoContinueText, isPromptUserMessage } from './continuation-text.mjs';
import { textOf } from './events.mjs';
import { USER_TO_SUBAGENT_KIND } from './ids.mjs';

export function forkTitle(title, lang) {
  const base = title == null ? '' : String(title);
  return lang === 'en' ? `${base} (fork)` : `${base}（分叉）`;
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
    return { ok: true, kind: 'assistant', at: target.id, prefill: null, empty: false };
  }
  if (isForkableUser(target)) {
    const earlier = list.slice(0, index).some(isVisibleEntry);
    return {
      ok: true,
      kind: 'user',
      at: earlier ? list[index - 1].id : null,
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
