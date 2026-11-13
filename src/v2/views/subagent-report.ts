// Shared background-subagent report text. Kernel, browser, and tests all match this.
// Stored as a user input so the main agent reads it; the UI must not draw a user bubble.

export type SubagentReportKind = 'answered' | 'failed' | 'stopped';

export type SubagentReport = {
  name: string;
  kind: SubagentReportKind;
  body: string;
};

export function formatSubagentReport({
  name,
  kind,
  body,
}: { name?: unknown; kind?: unknown; body?: unknown } = {}): string {
  const label = name == null ? '' : String(name);
  if (kind === 'stopped') return `[task ${label} stopped]`;
  if (kind === 'failed') return `[task ${label} failed: ${body ?? ''}]`;
  const text = body == null ? '' : String(body);
  return text ? `[task ${label} completed, no reply needed] ${text}` : `[task ${label} completed, no reply needed]`;
}

const ANSWERED = /^\[task (.+?) completed, no reply needed\](?: ([\s\S]*))?$/;
const FAILED = /^\[task (.+?) failed: ([\s\S]*)\]$/;
const STOPPED = /^\[task (.+?) stopped\]$/;

export function parseSubagentReport(text: unknown): SubagentReport | null {
  const raw = String(text ?? '');
  const answered = raw.match(ANSWERED);
  if (answered) {
    return { name: answered[1], kind: 'answered', body: answered[2] ?? '' };
  }
  const failed = raw.match(FAILED);
  if (failed) {
    return { name: failed[1], kind: 'failed', body: failed[2] ?? '' };
  }
  const stopped = raw.match(STOPPED);
  if (stopped) {
    return { name: stopped[1], kind: 'stopped', body: '' };
  }
  return null;
}

export function isSubagentReportText(text: unknown): boolean {
  return parseSubagentReport(text) != null;
}
