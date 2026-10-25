import type { Lang } from './data/lang';

const zh = {
  home_title: 'Weft（新版，开发中）',
  home_hint: '从旧版打开一个对话，或访问 /next/c/<对话 id>',
  no_workspaces: '先在旧版里添加工作区',
  missing_conversation: '对话不存在',
  unauthenticated: '请用 weft open 打开新版网页端',
  loading: '加载中…',
  empty_chat_hint: '发一条消息开始这个对话。',
  projects_label: '项目',
  new_conversation: '新对话',
  new_conversation_in: '在 {name} 中新建对话',
  default_conversation_title: '新对话',
  draft_label: '草稿',
  ws_no_conversations: '还没有对话',
  more_actions: '更多',
  collapse_sidebar: '收起侧栏',
  expand_sidebar: '展开侧栏',
  drag_resize: '拖动调整宽度，双击复位',
  copy_path: '复制路径',
  open_conversation: '打开对话',
  copy_conversation_id: '复制对话 ID',
  ctx_stop: '停止',
  agents_running_count: '{n} 个 Agent 运行中',
  running_count: '{n} 运行中',
  ws_remove: '移除工作区',
  ws_remove_title: '移除「{name}」？',
  ws_remove_message: '只从列表里移除，不会删除磁盘上的文件（{path}）。对话记录会保留，用同一路径重新添加时会回来。',
  ws_remove_busy: '这个工作区还有对话在运行或暂停，先停止再移除',
  ws_removed: '已移除「{name}」',
  btn_cancel: '取消',
  btn_confirm: '确认',
  err_copy: '复制失败',
  sec_ago: '{n}秒前',
  min_ago: '{n}分钟前',
  hour_ago: '{n}小时前',
  yesterday: '昨天',
  day_ago: '{n}天前',
  date_md: '{m}月{d}日',
  weekday_0: '周日',
  weekday_1: '周一',
  weekday_2: '周二',
  weekday_3: '周三',
  weekday_4: '周四',
  weekday_5: '周五',
  weekday_6: '周六',
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
  output_truncated: '输出达到长度上限被截断',
  copy_code: '复制',
  copied: '已复制',
  tool_show_all: '显示全部',
  tool_fail_count: '{n} 个失败',
  tool_group_older: '还有 {n} 个较早的调用',
  tool_group_older_one: '还有 {n} 个较早的调用',
  tool_sum_join: ' · ',
  pending_thinking: '思考中',
  status_idle: '就绪',
  status_running: '运行中',
  status_waiting: '等待中',
  status_failed: '失败',
  status_done: '完成',
  status_stopped: '已停止',
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
  subagent_open: '打开',
  subagent_open_title: '打开这个子 Agent',
  copy_output: '复制输出',
  subagent_back: '返回主对话',
  missing_subagent: '子 Agent 不存在',
  subagent_idle_for: '无动作 {time}',
  subagent_tree_expand: '展开子 Agent',
  subagent_tree_collapse: '折叠子 Agent',
  demo_model_badge: '演示模型',
  ctx_used_short: '已用 {used}%',
  ctx_left_short: '剩 {left}%',
  ctx_title: '上下文 {used} / {window} · 已用 {usedPct}% · 剩余 {leftPct}%',
} as const;

const en: Record<keyof typeof zh, string> = {
  home_title: 'Weft（新版，开发中）',
  home_hint: 'Open a conversation from the old UI, or visit /next/c/<conversation id>',
  no_workspaces: 'Add a workspace in the old UI first',
  missing_conversation: 'Conversation not found',
  unauthenticated: '请用 weft open 打开新版网页端',
  loading: 'Loading…',
  empty_chat_hint: 'Send a message to start this conversation.',
  projects_label: 'Projects',
  new_conversation: 'New chat',
  new_conversation_in: 'New chat in {name}',
  default_conversation_title: 'New chat',
  draft_label: 'Draft',
  ws_no_conversations: 'No chats yet',
  more_actions: 'More',
  collapse_sidebar: 'Collapse sidebar',
  expand_sidebar: 'Expand sidebar',
  drag_resize: 'Drag to resize, double-click to reset',
  copy_path: 'Copy path',
  open_conversation: 'Open chat',
  copy_conversation_id: 'Copy chat ID',
  ctx_stop: 'Stop',
  agents_running_count: '{n} agents running',
  running_count: '{n} running',
  ws_remove: 'Remove workspace',
  ws_remove_title: 'Remove “{name}”?',
  ws_remove_message: 'This only removes it from the list. Files on disk ({path}) are not deleted. Its chats are kept and come back if you add the same path again.',
  ws_remove_busy: 'A chat in this workspace is still running or paused. Stop it first.',
  ws_removed: 'Removed “{name}”',
  btn_cancel: 'Cancel',
  btn_confirm: 'Confirm',
  err_copy: 'Copy failed',
  sec_ago: '{n}s ago',
  min_ago: '{n}m ago',
  hour_ago: '{n}h ago',
  yesterday: 'Yesterday',
  day_ago: '{n}d ago',
  date_md: '{m}/{d}',
  weekday_0: 'Sun',
  weekday_1: 'Mon',
  weekday_2: 'Tue',
  weekday_3: 'Wed',
  weekday_4: 'Thu',
  weekday_5: 'Fri',
  weekday_6: 'Sat',
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
  output_truncated: 'Output was truncated at the length limit',
  copy_code: 'Copy',
  copied: 'Copied',
  tool_show_all: 'Show all',
  tool_fail_count: '{n} failed',
  tool_group_older: '{n} earlier calls',
  tool_group_older_one: '{n} earlier call',
  tool_sum_join: ' · ',
  pending_thinking: 'Thinking',
  status_idle: 'Idle',
  status_running: 'Running',
  status_waiting: 'Waiting',
  status_failed: 'Failed',
  status_done: 'Done',
  status_stopped: 'Stopped',
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
  subagent_open: 'Open',
  subagent_open_title: 'Open this sub-agent',
  copy_output: 'Copy output',
  subagent_back: 'Back to chat',
  missing_subagent: 'Sub-agent not found',
  subagent_idle_for: 'idle {time}',
  subagent_tree_expand: 'Expand sub-agents',
  subagent_tree_collapse: 'Collapse sub-agents',
  demo_model_badge: 'Demo model',
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
