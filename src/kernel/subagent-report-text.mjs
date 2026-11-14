// Shared background-task report text. Kernel, browser, and tests all match this.
// Stored as a user input so the main agent reads it; the UI must not draw a user bubble.

export function formatSubagentReport({ name, kind, body } = {}) {
  const label = name == null ? '' : String(name);
  if (kind === 'stopped') return `[task ${label} stopped]`;
  if (kind === 'failed') return `[task ${label} failed: ${body ?? ''}]`;
  const text = body == null ? '' : String(body);
  return text
    ? `[task ${label} completed, no reply needed] ${text}`
    : `[task ${label} completed, no reply needed]`;
}

const COMPLETED = /^\[task (.+?) completed, no reply needed\](?: ([\s\S]*))?$/;
const FAILED = /^\[task (.+?) failed: ([\s\S]*)\]$/;
const STOPPED = /^\[task (.+?) stopped\]$/;

export function parseSubagentReport(text) {
  const raw = String(text ?? '');
  const completed = raw.match(COMPLETED);
  if (completed) {
    return { name: completed[1], kind: 'answered', body: completed[2] ?? '' };
  }
  const failed = raw.match(FAILED);
  if (failed) {
    return { name: failed[1], kind: 'failed', body: failed[2] };
  }
  const stopped = raw.match(STOPPED);
  if (stopped) {
    return { name: stopped[1], kind: 'stopped', body: '' };
  }
  return null;
}

export function isSubagentReportText(text) {
  return parseSubagentReport(text) != null;
}
