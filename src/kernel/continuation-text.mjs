// Shared auto-continue prefix. The kernel and the v2 views match this.
// New runs do not append these messages. Old transcripts still contain them.
import { isSubagentReportText } from './subagent-report-text.mjs';

export const AUTO_CONTINUE_PREFIX = '[auto-continue]';

export function isAutoContinueText(text) {
  return String(text ?? '').startsWith(AUTO_CONTINUE_PREFIX);
}

export function isPromptUserMessage(message) {
  if (!message || message.role !== 'user') return false;
  if (message.kind === 'auto-continue' || message.kind === 'subagent-report') return false;
  if (isAutoContinueText(message.text)) return false;
  return !isSubagentReportText(message.text);
}
