import type { Lang } from '../data/lang';
import type { Subagent, ThreadItem, ToolCall } from '../data/store';
import { formatMmSs, stripActionMarks } from '../data/subagentTime';
import { t, toolActionLabel } from '../i18n';
import { statusIconFor, type StatusIconType } from './StatusIcon';

export interface StepItem {
  verb: string;
  desc: string;
}

export function isSubagentLive(status: Subagent['status'] | string): boolean {
  return status === 'running' || status === 'stuck' || status === 'waiting' || status === 'queued';
}

export function isSubagentEnded(status: Subagent['status'] | string): boolean {
  return status === 'done' || status === 'stopped' || status === 'failed';
}

export function hasUnendedAgents(agents: readonly Subagent[]): boolean {
  return agents.some((a) => isSubagentLive(a.status));
}

export function isAllEndedAgents(agents: readonly Subagent[]): boolean {
  return agents.length > 0 && agents.every((a) => isSubagentEnded(a.status));
}

export function countByIconStatus(agents: readonly Subagent[]): Array<{ status: StatusIconType; count: number }> {
  const counts = new Map<StatusIconType, number>();
  for (const agent of agents) {
    const icon = statusIconFor(agent.status, 'subagent') ?? 'running';
    counts.set(icon, (counts.get(icon) || 0) + 1);
  }
  const order: StatusIconType[] = ['running', 'stuck', 'queued', 'done', 'failed', 'stopped'];
  const res: Array<{ status: StatusIconType; count: number }> = [];
  for (const st of order) {
    const count = counts.get(st) || 0;
    if (count > 0) res.push({ status: st, count });
  }
  return res;
}

export function stripMarkdownInline(text: string): string {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.slice(3, -3).trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatAgentsHeadline(agents: readonly Subagent[], lang: Lang): string {
  if (!agents.length) return '';
  const r = agents.filter((a) => a.status === 'running').length;
  const k = agents.filter((a) => a.status === 'stuck').length;
  const q = agents.filter((a) => a.status === 'waiting' || (a.status as string) === 'queued').length;

  if (r > 0 || k > 0 || q > 0) {
    const parts: string[] = [];
    if (r > 0) parts.push(t(lang, 'agents_strip_running', { count: r }));
    if (k > 0) parts.push(t(lang, 'agents_strip_stuck', { count: k }));
    if (q > 0) parts.push(t(lang, 'agents_strip_queued', { count: q }));
    return parts.join(' · ');
  }

  const d = agents.filter((a) => a.status === 'done' || a.status === 'stopped').length;
  const f = agents.filter((a) => a.status === 'failed').length;
  const parts: string[] = [];
  if (d > 0) parts.push(t(lang, 'agents_strip_done', { count: d }));
  if (f > 0) parts.push(t(lang, 'agents_strip_failed', { count: f }));
  return parts.join(' · ');
}

export function formatAgentDoing(
  agent: Subagent,
  options: {
    lang: Lang;
    resText?: string;
  },
): string {
  const { lang, resText } = options;
  if (agent.status === 'done') {
    if (resText) {
      const firstLine = resText.trim().split('\n')[0].trim();
      if (firstLine) return stripMarkdownInline(firstLine);
    }
    return t(lang, 'status_done');
  }
  if (agent.status === 'waiting' || (agent.status as string) === 'queued') {
    return t(lang, 'status_queued');
  }
  if (agent.status === 'failed') {
    return t(lang, 'agents_strip_failed_doing');
  }
  return stripMarkdownInline(stripActionMarks(agent.currentAction || '')) || t(lang, 'status_running');
}

export function formatAgentElapsed(agent: Subagent, now: number): string {
  if (isSubagentEnded(agent.status)) return '';
  if (agent.status === 'waiting' || (agent.status as string) === 'queued') return '';
  if (!agent.startedAt || agent.startedAt <= 0) return '';
  return formatMmSs(now - agent.startedAt);
}

export function extractSubagentSteps(
  items: readonly ThreadItem[],
  toolsById: Record<string, ToolCall>,
  lang: Lang,
): StepItem[] {
  const toolList: ToolCall[] = [];
  for (const item of items) {
    if (item.kind === 'tool_group') {
      for (const id of item.toolIds) {
        const tool = toolsById[id];
        if (tool) toolList.push(tool);
      }
    }
  }
  const lastTools = toolList.slice(-3);
  return lastTools.map((tool) => {
    const verb = toolActionLabel(lang, tool.kind);
    const desc = (tool.path || tool.heading?.detail || tool.heading?.title || '').trim();
    return { verb, desc };
  });
}
