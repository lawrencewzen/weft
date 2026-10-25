import type { Lang } from './data/lang';

const zh = {
  home_title: 'Weft（新版，开发中）',
  home_hint: '从旧版打开一个对话，或访问 /next/c/<对话 id>',
  missing_conversation: '对话不存在',
  unauthenticated: '请用 weft open 打开新版网页端',
  loading: '加载中…',
  empty_chat_hint: '发一条消息开始这个对话。',
  composer_placeholder: '继续对话，Enter 发送，Shift+Enter 换行',
  composer_placeholder_running: '补充说明，Agent 会在下一步读到',
  btn_send: '发送',
  send_title: '发送指令 (Cmd+Enter)',
  btn_stop: '终止',
  btn_stop_title: '终止这次运行',
  btn_continue: '继续',
  btn_retry: '重试',
  send_failed: '发送失败',
  locked_no_workspace: '这条对话没有工作区，不能发送。',
  output_truncated: '输出被截断',
  copy_code: '复制',
  copied: '已复制',
  tool_show_all: '显示全部',
  tool_fail_count: '{n} 个失败',
  tool_group_older: '显示更早的 {n} 个',
  tool_group_older_one: '显示更早的 {n} 个',
  tool_act_read: '读取',
  tool_act_write: '写入',
  tool_act_edit: '编辑',
  tool_act_ls: '列出',
  tool_act_grep: '搜索',
  tool_act_bash: '执行',
  tool_act_other: '调用',
  tool_status_failed: '失败',
  tool_status_interrupted: '已中断',
  subagent_report_answered: '子 Agent「{name}」已交回结果',
  subagent_report_failed: '子 Agent「{name}」失败',
  ctx_used_short: '已用 {used}%',
  ctx_left_short: '剩 {left}%',
  ctx_title: '上下文 {used} / {window} · 已用 {usedPct}% · 剩余 {leftPct}%',
} as const;

const en: Record<keyof typeof zh, string> = {
  home_title: 'Weft（新版，开发中）',
  home_hint: 'Open a conversation from the old UI, or visit /next/c/<conversation id>',
  missing_conversation: 'Conversation not found',
  unauthenticated: '请用 weft open 打开新版网页端',
  loading: 'Loading…',
  empty_chat_hint: 'Send a message to start this conversation.',
  composer_placeholder: 'Continue the chat. Enter to send, Shift+Enter for a new line',
  composer_placeholder_running: 'Add a note. The agent reads it on its next step',
  btn_send: 'Send',
  send_title: 'Send (Cmd+Enter)',
  btn_stop: 'Stop',
  btn_stop_title: 'Stop this run',
  btn_continue: 'Continue',
  btn_retry: 'Retry',
  send_failed: 'Send failed',
  locked_no_workspace: 'This conversation has no workspace, so it cannot send.',
  output_truncated: 'Output was truncated',
  copy_code: 'Copy',
  copied: 'Copied',
  tool_show_all: 'Show all',
  tool_fail_count: '{n} failed',
  tool_group_older: '{n} earlier',
  tool_group_older_one: '{n} earlier',
  tool_act_read: 'Read',
  tool_act_write: 'Write',
  tool_act_edit: 'Edit',
  tool_act_ls: 'List',
  tool_act_grep: 'Search',
  tool_act_bash: 'Run',
  tool_act_other: 'Call',
  tool_status_failed: 'Failed',
  tool_status_interrupted: 'Interrupted',
  subagent_report_answered: 'Sub-agent “{name}” handed back a result',
  subagent_report_failed: 'Sub-agent “{name}” failed',
  ctx_used_short: 'Used {used}%',
  ctx_left_short: 'Left {left}%',
  ctx_title: 'Context {used} / {window} · Used {usedPct}% · Left {leftPct}%',
};

const DICT: Record<Lang, Record<keyof typeof zh, string>> = { zh, en };

export type I18nKey = keyof typeof zh;

export function t(lang: Lang, key: I18nKey, params?: Record<string, string | number>): string {
  let out = DICT[lang]?.[key] || zh[key] || key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      out = out.replaceAll(`{${name}}`, String(value));
    }
  }
  return out;
}

export function toolActionLabel(lang: Lang, kind: string): string {
  if (kind === 'read') return t(lang, 'tool_act_read');
  if (kind === 'write') return t(lang, 'tool_act_write');
  if (kind === 'edit') return t(lang, 'tool_act_edit');
  if (kind === 'ls') return t(lang, 'tool_act_ls');
  if (kind === 'grep') return t(lang, 'tool_act_grep');
  if (kind === 'bash') return t(lang, 'tool_act_bash');
  return t(lang, 'tool_act_other');
}

export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatTokenCount(n: number): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '0';
  if (v < 1000) return String(Math.round(v));
  if (v >= 1e6) {
    const scaled = v / 1e6;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1).replace(/\.0$/, '')}M`;
  }
  const scaled = v / 1e3;
  return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1).replace(/\.0$/, '')}k`;
}
