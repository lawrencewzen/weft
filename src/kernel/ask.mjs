// Ask-the-user questions. The plugin validates and returns immediately.
// The answer is the next user input, placed as a weft.ask-answer entry.
// Nothing here waits, polls, or schedules.

export const ASK_TOOL_NAME = 'ask_user_question';
/** Custom input entry. Must not start with `pi.`. */
export const ASK_ANSWER_KIND = 'weft.ask-answer';
export const ASK_WAITING_TEXT = '已向用户提问，等待回答，不要继续。';

const HEADER_MAX = 12;
const OTHER_MAX = 4000;
const QUESTIONS_MIN = 1;
const QUESTIONS_MAX = 4;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 4;
const OTHER_LABELS = new Set(['其他', 'other']);

function fail(error) {
  return { ok: false, error };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function headerLength(value) {
  return [...String(value)].length;
}

function isOtherLabel(label) {
  return OTHER_LABELS.has(label) || OTHER_LABELS.has(label.toLowerCase());
}

function validateQuestion(raw, index) {
  const where = `ask_user_question: questions[${index}]`;
  const q = asObject(raw);
  if (!q) return fail(`${where} must be an object`);
  if (typeof q.question !== 'string' || !q.question.trim()) {
    return fail(`${where}.question is required`);
  }
  if (typeof q.header !== 'string' || !q.header.trim()) {
    return fail(`${where}.header is required`);
  }
  const header = q.header.trim();
  if (headerLength(header) > HEADER_MAX) {
    return fail(`${where}.header must be at most ${HEADER_MAX} characters`);
  }
  if (typeof q.multiSelect !== 'boolean') {
    return fail(`${where}.multiSelect must be a boolean`);
  }
  if (!Array.isArray(q.options) || q.options.length < OPTIONS_MIN || q.options.length > OPTIONS_MAX) {
    return fail(`${where}.options must contain ${OPTIONS_MIN} to ${OPTIONS_MAX} items`);
  }
  const options = [];
  const labels = new Set();
  for (let i = 0; i < q.options.length; i += 1) {
    const opt = asObject(q.options[i]);
    if (!opt) return fail(`${where}.options[${i}] must be an object`);
    if (typeof opt.label !== 'string' || !opt.label.trim()) {
      return fail(`${where}.options[${i}].label is required`);
    }
    if (typeof opt.description !== 'string' || !opt.description.trim()) {
      return fail(`${where}.options[${i}].description is required`);
    }
    const label = opt.label.trim();
    if (isOtherLabel(label)) {
      return fail(`${where}.options[${i}].label must not be Other; the UI adds it`);
    }
    if (labels.has(label)) return fail(`${where}.options[${i}].label is duplicated`);
    labels.add(label);
    options.push({ label, description: opt.description.trim() });
  }
  return {
    ok: true,
    question: {
      question: q.question.trim(),
      header,
      multiSelect: q.multiSelect,
      options,
    },
  };
}

/** Strict check of a model tool call. Invalid input is an error the model can retry. */
export function validateAskArgs(args) {
  const body = asObject(args);
  if (!body) return fail('ask_user_question: questions is required');
  const questions = body.questions;
  if (!Array.isArray(questions) || questions.length < QUESTIONS_MIN || questions.length > QUESTIONS_MAX) {
    return fail(`ask_user_question: questions must contain ${QUESTIONS_MIN} to ${QUESTIONS_MAX} items`);
  }
  const normalized = [];
  for (let i = 0; i < questions.length; i += 1) {
    const checked = validateQuestion(questions[i], i);
    if (!checked.ok) return checked;
    normalized.push(checked.question);
  }
  return { ok: true, questions: normalized };
}

function questionsOf(value) {
  const checked = validateAskArgs({ questions: value });
  return checked.ok ? checked.questions : null;
}

function httpFail(status, error, code) {
  return { ok: false, status, error, code };
}

function selectionOf(raw, questions) {
  const item = asObject(raw);
  if (!item) return httpFail(400, 'invalid answer', 'E_BAD_REQUEST');
  const questionIndex = item.questionIndex;
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= questions.length) {
    return httpFail(400, 'questionIndex is out of range', 'E_BAD_REQUEST');
  }
  if (!Array.isArray(item.selected) || item.selected.some((label) => typeof label !== 'string')) {
    return httpFail(400, 'selected must be an array of strings', 'E_BAD_REQUEST');
  }
  const question = questions[questionIndex];
  const allowed = new Set(question.options.map((opt) => opt.label));
  const selected = [];
  for (const label of item.selected) {
    const trimmed = label.trim();
    if (!trimmed || !allowed.has(trimmed)) {
      return httpFail(400, 'selected label is not an option', 'E_BAD_REQUEST');
    }
    if (!selected.includes(trimmed)) selected.push(trimmed);
  }
  let other = '';
  if (item.other != null) {
    if (typeof item.other !== 'string') return httpFail(400, 'other must be a string', 'E_BAD_REQUEST');
    other = item.other.trim();
    if (other.length > OTHER_MAX) return httpFail(400, 'other is too long', 'E_BAD_REQUEST');
  }
  if (!question.multiSelect && selected.length > 1) {
    return httpFail(400, 'this question allows one selection', 'E_BAD_REQUEST');
  }
  if (!question.multiSelect && selected.length > 0 && other) {
    return httpFail(400, 'use either a selection or Other', 'E_BAD_REQUEST');
  }
  const answer = { questionIndex, selected };
  if (other) answer.other = other;
  return { ok: true, answer };
}

/**
 * Check a submitted answer against the questions already stored for this call.
 * `skipped: true` with an empty answers list skips every question.
 */
export function validateAskAnswer(questions, body) {
  const list = Array.isArray(questions) ? questions : null;
  if (!list?.length) return httpFail(400, 'question is not ready', 'E_BAD_REQUEST');
  const raw = asObject(body);
  if (!raw) return httpFail(400, 'invalid answer', 'E_BAD_REQUEST');
  const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId.trim() : '';
  if (!toolCallId) return httpFail(400, 'toolCallId is required', 'E_BAD_REQUEST');
  if (raw.skipped != null && typeof raw.skipped !== 'boolean') {
    return httpFail(400, 'skipped must be a boolean', 'E_BAD_REQUEST');
  }
  if (!Array.isArray(raw.answers)) return httpFail(400, 'answers must be an array', 'E_BAD_REQUEST');
  const skipped = raw.skipped === true;
  const answers = [];
  const seen = new Set();
  for (const item of raw.answers) {
    const checked = selectionOf(item, list);
    if (!checked.ok) return checked;
    if (seen.has(checked.answer.questionIndex)) {
      return httpFail(400, 'duplicate questionIndex', 'E_BAD_REQUEST');
    }
    seen.add(checked.answer.questionIndex);
    const empty = checked.answer.selected.length === 0 && !checked.answer.other;
    if (empty && !skipped) return httpFail(400, 'each answer needs a selection or Other', 'E_BAD_REQUEST');
    if (!empty) answers.push(checked.answer);
  }
  if (!skipped) {
    for (let i = 0; i < list.length; i += 1) {
      if (!seen.has(i)) return httpFail(400, 'every question needs an answer', 'E_BAD_REQUEST');
    }
  }
  answers.sort((a, b) => a.questionIndex - b.questionIndex);
  return { ok: true, toolCallId, answers, skipped };
}

function answerLine(question, item, skippedAll) {
  if (skippedAll || !item) return '回答：用户跳过';
  const parts = [];
  if (item.selected.length) parts.push(item.selected.join('、'));
  if (item.other) parts.push(`其他：${item.other}`);
  if (!parts.length) return '回答：用户跳过';
  return `回答：${parts.join('；')}`;
}

/** Text the model reads. Each question is paired with the selection, Other text, or 用户跳过. */
export function formatAskContent(questions, answer) {
  const skippedAll = answer.skipped === true && answer.answers.length === 0;
  const lines = [skippedAll ? '用户跳过了提问，没有作答。' : '用户回答了提问：'];
  questions.forEach((question, index) => {
    const item = answer.answers.find((row) => row.questionIndex === index);
    lines.push(`${index + 1}. ${question.question}`);
    lines.push(answerLine(question, item, skippedAll));
  });
  return lines.join('\n');
}

function answerData(entry) {
  if (entry?.kind !== ASK_ANSWER_KIND) return null;
  const data = asObject(entry.data);
  if (!data || data.toolCallId == null) return null;
  const toolCallId = String(data.toolCallId);
  if (!toolCallId) return null;
  const answers = [];
  if (Array.isArray(data.answers)) {
    for (const item of data.answers) {
      const row = asObject(item);
      if (!row || !Number.isInteger(row.questionIndex) || row.questionIndex < 0) continue;
      const selected = Array.isArray(row.selected)
        ? row.selected.filter((label) => typeof label === 'string' && label)
        : [];
      const next = { questionIndex: row.questionIndex, selected };
      if (typeof row.other === 'string' && row.other) next.other = row.other;
      answers.push(next);
    }
  }
  return {
    toolCallId,
    answer: { answers, skipped: data.skipped === true },
  };
}

/**
 * Structured ask state for each ask_user_question call in a transcript.
 * `answer` is null while the user has not sent anything after the question.
 * A later ordinary user message (pi.user), with no weft.ask-answer for this
 * call, is `{ answers: [], skipped: true }`.
 */
export function askByToolCall(entries) {
  const rows = new Map();
  const answers = new Map();
  const userAt = [];
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    if (entry?.kind === 'pi.user') userAt.push(index);
    const stored = answerData(entry);
    if (stored) answers.set(stored.toolCallId, stored.answer);
    if (entry?.kind === 'pi.assistant') {
      const content = entry.model?.[0]?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type !== 'toolCall' || block.name !== ASK_TOOL_NAME || !block.id) continue;
        const id = String(block.id);
        const row = rows.get(id) || { at: index, questions: null, failed: false, seenResult: false };
        row.at = Math.max(row.at, index);
        const parsed = questionsOf(block.arguments?.questions);
        if (parsed && !row.questions) row.questions = parsed;
        rows.set(id, row);
      }
      return;
    }
    if (entry?.kind !== 'pi.tool-result') return;
    const result = entry.model?.[0];
    if (!result?.toolCallId) return;
    const id = String(result.toolCallId);
    const row = rows.get(id);
    const named = result.toolName === ASK_TOOL_NAME;
    if (!row && !named) return;
    const next = row || { at: index, questions: null, failed: false, seenResult: false };
    next.seenResult = true;
    next.at = index;
    if (result.isError) next.failed = true;
    const parsed = questionsOf(result.details?.questions);
    if (parsed) next.questions = parsed;
    rows.set(id, next);
  });
  const out = new Map();
  for (const [id, row] of rows) {
    if (!row.questions || row.failed) continue;
    const recorded = answers.get(id);
    let answer = null;
    if (recorded) answer = recorded;
    else if (userAt.some((at) => at > row.at)) answer = { answers: [], skipped: true };
    out.set(id, { questions: row.questions, answer });
  }
  return out;
}

/**
 * Resolve one answer submission against the transcript.
 * A second answer for the same toolCallId is 409. An unknown call is 400.
 */
export function buildAskSubmission(entries, body) {
  const raw = asObject(body);
  const toolCallId = raw && typeof raw.toolCallId === 'string' ? raw.toolCallId.trim() : '';
  if (!toolCallId) return httpFail(400, 'toolCallId is required', 'E_BAD_REQUEST');
  let questions = null;
  let found = false;
  let failed = false;
  let answered = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind === 'pi.assistant') {
      const content = entry.model?.[0]?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== 'toolCall' || String(block.id) !== toolCallId) continue;
        if (block.name !== ASK_TOOL_NAME) continue;
        found = true;
        const parsed = questionsOf(block.arguments?.questions);
        if (parsed && !questions) questions = parsed;
      }
    }
    if (entry?.kind === 'pi.tool-result') {
      const result = entry.model?.[0];
      if (!result || String(result.toolCallId) !== toolCallId) continue;
      if (result.toolName === ASK_TOOL_NAME) found = true;
      if (result.isError) failed = true;
      const parsed = questionsOf(result.details?.questions);
      if (parsed) questions = parsed;
    }
    if (answerData(entry)?.toolCallId === toolCallId) answered = true;
  }
  if (!found) return httpFail(400, 'toolCallId is not a question in this conversation', 'E_BAD_REQUEST');
  if (failed || !questions) return httpFail(400, 'question is not ready', 'E_BAD_REQUEST');
  if (answered) return httpFail(409, 'already answered', 'E_ASK_ANSWERED');
  const checked = validateAskAnswer(questions, body);
  if (!checked.ok) return checked;
  const answer = { answers: checked.answers, skipped: checked.skipped };
  return {
    ok: true,
    content: formatAskContent(questions, answer),
    entry: {
      kind: ASK_ANSWER_KIND,
      data: {
        toolCallId,
        answers: checked.answers,
        skipped: checked.skipped,
      },
    },
  };
}
