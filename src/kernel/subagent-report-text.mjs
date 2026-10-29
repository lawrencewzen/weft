// Shared background-subagent report text. Kernel, browser, and tests all match this.
// Stored as a user input so the main agent reads it; the UI must not draw a user bubble.

export function formatSubagentReport({ name, kind, body } = {}) {
  const label = name == null ? '' : String(name);
  if (kind === 'failed') return `[subagent ${label} failed: ${body}]`;
  return `[subagent ${label} answered, no reply needed] ${body ?? ''}`;
}

const STATUS_LINE = /^\s*STATUS:\s*(done|incomplete)\s*$/i;

/**
 * Read an optional first-line STATUS marker on a child's last message.
 * Missing or unknown markers are treated as complete, and the text is unchanged.
 * A known marker is stripped so the parent report and chip lastText stay clean.
 */
export function parseSubagentOutcome(text) {
  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start += 1;
  if (start >= lines.length) {
    return { complete: true, marked: false, body: raw };
  }
  const match = lines[start].match(STATUS_LINE);
  if (!match) {
    return { complete: true, marked: false, body: raw };
  }
  const complete = match[1].toLowerCase() === 'done';
  let from = start + 1;
  while (from < lines.length && lines[from].trim() === '') from += 1;
  return {
    complete,
    marked: true,
    body: lines.slice(from).join('\n'),
  };
}

const ANSWERED = /^\[subagent (.+?) answered, no reply needed\](?: ([\s\S]*))?$/;
const FAILED = /^\[subagent (.+?) failed: (.*)\]$/s;

export function parseSubagentReport(text) {
  const raw = String(text ?? '');
  const answered = raw.match(ANSWERED);
  if (answered) {
    return { name: answered[1], kind: 'answered', body: answered[2] ?? '' };
  }
  const failed = raw.match(FAILED);
  if (failed) {
    return { name: failed[1], kind: 'failed', body: failed[2] ?? '' };
  }
  return null;
}

export function isSubagentReportText(text) {
  return parseSubagentReport(text) != null;
}
