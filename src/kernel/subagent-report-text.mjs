// Shared background-subagent report text. Kernel, browser, and tests all match this.
// Stored as a user input so the main agent reads it; the UI must not draw a user bubble.

export function formatSubagentReport({ name, kind, body } = {}) {
  const label = name == null ? '' : String(name);
  if (kind === 'failed') return `[subagent ${label} failed: ${body}]`;
  return `[subagent ${label} answered, no reply needed] ${body ?? ''}`;
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
