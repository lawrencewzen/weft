// Shared auto-continue prefix. Old transcripts still contain these messages.
import { isSubagentReportText } from './subagent-report.ts';

export const AUTO_CONTINUE_PREFIX = '[auto-continue]';

export type PromptUserMessage = {
  role?: unknown;
  kind?: unknown;
  text?: unknown;
};

export function isAutoContinueText(text: unknown): boolean {
  return String(text ?? '').startsWith(AUTO_CONTINUE_PREFIX);
}

export function isPromptUserMessage(message: PromptUserMessage | null | undefined): boolean {
  if (!message || message.role !== 'user') return false;
  if (message.kind === 'auto-continue' || message.kind === 'subagent-report') return false;
  if (isAutoContinueText(message.text)) return false;
  return !isSubagentReportText(message.text);
}
