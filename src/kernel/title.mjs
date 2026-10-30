// One-shot conversation title after the first successful main-agent run.
// Uses pi-ai completeSimple on the conversation's current model. Not a scheduler.
import { contentText } from '@earendil-works/pi-ai';
import { clampThinkingLevel } from '@earendil-works/pi-ai/models';
import { isAutoContinueText, isPromptUserMessage } from './continuation.mjs';

export const TITLE_PROMPT_MARKER = 'Write a short conversation title.';
export const TITLE_PROMPT = `${TITLE_PROMPT_MARKER}
Rules:
- Use the same language as the user message.
- Chinese: about 15 characters or fewer. English: 6 words or fewer.
- Summarize the task; do not copy the original sentence.
- No quotation marks, periods, emoji, or prefixes such as "Title:" or "标题：".`;

export const TITLE_INPUT_MAX = 2000;
export const TITLE_MAX_TOKENS = 64;
export const TITLE_TIMEOUT_MS = 15_000;
export const TITLE_HARD_CAP = 32;
export const TITLE_CJK_CAP = 20;
export const TITLE_EN_WORDS = 6;

const CJK_RE = /[\u3400-\u9fff]/;
const WRAP_RE = /^[\s"'“”‘’「」『』《》]+|[\s"'“”‘’「」『』《》]+$/g;
const PREFIX_RE = /^(标题|Title)\s*[:：]\s*/i;
const TRAIL_PUNCT_RE = /[。．.!?！？;；,，、…]+$/u;

const inflight = new Set();

function clip(text, max = TITLE_INPUT_MAX) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max) : value;
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return '';
}

/** True when this pi-ai request is the host's title completion, not a harness turn. */
export function isTitleRequest(context) {
  const messages = context?.messages || [];
  if (messages.some((message) => message?.role === 'system')) return false;
  const users = messages.filter((message) => message?.role === 'user');
  if (users.length !== 1) return false;
  return messageText(users[0]).includes(TITLE_PROMPT_MARKER);
}

export function buildTitlePrompt(userText, assistantText) {
  return [
    TITLE_PROMPT,
    '',
    'User:',
    clip(userText),
    '',
    'Assistant:',
    clip(assistantText),
  ].join('\n');
}

export function sanitizeGeneratedTitle(raw) {
  let text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  for (let i = 0; i < 6; i += 1) {
    const next = text
      .replace(WRAP_RE, '')
      .replace(PREFIX_RE, '')
      .replace(TRAIL_PUNCT_RE, '')
      .trim();
    if (next === text) break;
    text = next;
  }
  if (!text || text.startsWith('Write a short conversation title')) return '';
  const words = text.split(' ').filter(Boolean);
  const asciiWords = words.length > 1 && words.every((word) => /^[\x00-\x7F]+$/.test(word));
  if (asciiWords && words.length > TITLE_EN_WORDS) {
    text = words.slice(0, TITLE_EN_WORDS).join(' ');
  }
  const cap = CJK_RE.test(text) ? TITLE_CJK_CAP : TITLE_HARD_CAP;
  if (text.length > cap) text = text.slice(0, cap).trim();
  return text;
}

export function firstTurnTexts(messages) {
  let userText = '';
  let assistantText = '';
  for (const message of messages || []) {
    if (!userText && isPromptUserMessage(message)) {
      userText = String(message.text || '').trim();
      continue;
    }
    if (userText && !assistantText && message?.role === 'assistant') {
      const text = String(message.text || '').trim();
      if (text) assistantText = text;
    }
    if (userText && assistantText) break;
  }
  return { userText, assistantText };
}

export function shouldGenerateTitle(conv, {
  status,
  isSubagent = false,
} = {}) {
  if (isSubagent) return false;
  if (status !== 'done') return false;
  if (!conv) return false;
  if (conv.titleSource === 'user') return false;
  if (conv.titleGeneratedAt != null) return false;
  return true;
}

export async function completeTitle({
  models,
  model,
  userText,
  assistantText,
  timeoutMs = TITLE_TIMEOUT_MS,
} = {}) {
  if (!models || typeof models.completeSimple !== 'function' || !model) return '';
  const prompt = buildTitlePrompt(userText, assistantText);
  const reasoning = clampThinkingLevel(model, 'off');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const message = await models.completeSimple(model, {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    }, {
      maxTokens: TITLE_MAX_TOKENS,
      reasoning,
      toolChoice: 'none',
      timeoutMs,
      maxRetries: 0,
      signal: ac.signal,
    });
    if (!message || message.stopReason === 'error' || message.stopReason === 'aborted') return '';
    return contentText(message.content || []);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * After a main-agent run ends with status `done`, try once to replace the
 * temporary auto title. Failures stay silent and keep the temp title.
 */
export async function maybeGenerateConversationTitle(cid, {
  store,
  models,
  resolveModel,
  readTranscript,
  onConversationMeta,
  status,
  isSubagent = false,
  now = Date.now,
} = {}) {
  if (!cid || !store || !models) return null;
  if (inflight.has(cid)) return null;
  const initial = await store.getConversation(cid);
  if (!shouldGenerateTitle(initial, { status, isSubagent })) return null;
  inflight.add(cid);
  try {
    const conv = await store.getConversation(cid);
    if (!shouldGenerateTitle(conv, { status, isSubagent })) return null;
    const transcript = conv.harnessId && typeof readTranscript === 'function'
      ? await readTranscript(conv.harnessId)
      : { messages: [] };
    const { userText, assistantText } = firstTurnTexts(transcript.messages || []);
    if (!userText || !assistantText) {
      console.debug(`WEFT_TITLE ${cid} missing first turn`);
      return null;
    }
    if (isAutoContinueText(userText)) return null;
    let model = null;
    try {
      model = typeof resolveModel === 'function' ? await resolveModel(conv) : null;
    } catch (err) {
      console.debug(`WEFT_TITLE ${cid} model ${err instanceof Error ? err.message : err}`);
      return null;
    }
    if (!model) {
      console.debug(`WEFT_TITLE ${cid} no model`);
      return null;
    }
    const raw = await completeTitle({ models, model, userText, assistantText });
    const title = sanitizeGeneratedTitle(raw);
    if (!title) {
      console.debug(`WEFT_TITLE ${cid} empty result`);
      return null;
    }
    const latest = await store.getConversation(cid);
    if (!shouldGenerateTitle(latest, { status: 'done', isSubagent })) return null;
    const next = await store.updateConversation(cid, {
      title,
      titleGeneratedAt: now(),
    });
    if (typeof onConversationMeta === 'function') {
      try {
        await onConversationMeta(cid);
      } catch (err) {
        console.debug(`WEFT_TITLE ${cid} notify ${err instanceof Error ? err.message : err}`);
      }
    }
    return next;
  } catch (err) {
    console.debug(`WEFT_TITLE ${cid} ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    inflight.delete(cid);
  }
}
