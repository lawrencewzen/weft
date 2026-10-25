// Shared auto-continue prefix. Ported from public/continuation.js — do not import from public/.
import { isSubagentReportText } from './subagent-report.ts';

export const AUTO_CONTINUE_PREFIX = '[auto-continue]';

export const CONTINUE_TEXT = `${AUTO_CONTINUE_PREFIX} 上一条回复因输出长度上限被截断，请从断点处直接接着写，不重复已写内容，不加开场白（若断在代码块里，接着写代码块内容）。`;

/** User-facing continue button sends this as a real user message. */
export const MANUAL_CONTINUE_TEXT = '继续';

/** Consecutive auto-continues in one run, counted from the last real user message. */
export const MAX_AUTO_CONTINUES = 8;

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
