import { t } from '../i18n';
import type { Lang } from './lang';
import type { Available } from './providerTypes';

/**
 * 格式化 token 数值：
 * - null / undefined -> unknownText（调用方传入 i18n 文案）
 * - >= 1M: 1M, 1.05M 等 (去除末尾多余的 0 和点)
 * - >= 1000: Math.round(n / 1000) + 'K' (例如 262K, 128K)
 * - 其他: String(n)
 */
export function formatTokenNum(n: number | null | undefined, unknownText = ''): string {
  if (n == null) return unknownText;
  if (!Number.isFinite(n) || n < 0) return unknownText;
  if (n >= 1_000_000) {
    if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
    const formatted = (n / 1_000_000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return `${formatted}M`;
  }
  if (n >= 1000) {
    return `${Math.round(n / 1000)}K`;
  }
  return String(Math.round(n));
}

/**
 * 解析用户输入的上下文 / 最大输出：
 * - 空字符串 / null / undefined -> null (表示清除覆盖，恢复默认)
 * - 支持 128k / 128K -> 128000 (或 128 * 1000)
 * - 支持 1m / 1M -> 1000000
 * - 支持纯数字 131072
 * - 支持包含逗号、下划线、空格
 * - 若输入非法或非正数 -> undefined
 */
export function parseContextInput(raw: string | number | null | undefined): number | null | undefined {
  if (raw == null) return null;
  const str = String(raw).trim().replace(/[,_\s]/g, '');
  if (!str) return null;

  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(str);
  if (!match) return undefined;

  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;

  const unit = match[2]?.toLowerCase();
  let result: number;
  if (unit === 'm') {
    result = Math.round(num * 1_000_000);
  } else if (unit === 'k') {
    result = Math.round(num * 1_000);
  } else {
    result = Math.round(num);
  }

  if (result < 1000 || result > 100_000_000) return undefined;
  return result;
}

/**
 * 新接入的内置或自定义 Provider 默认启用规则：
 * 模型 ≤ 6 个时全部启用，否则都不启用。
 */
export function defaultEnabledRule(modelCount: number): boolean {
  return modelCount <= 6;
}

/**
 * Available Provider 列表排序规则：
 * popular 优先，其余按 name 排序。
 */
export function sortAvailableProviders(providers: readonly Available[]): Available[] {
  return [...providers].sort((a, b) => {
    if (a.popular !== b.popular) return a.popular ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

export { formatTokenNum as formatNumber };

export function formatTimeAgo(ts: number | null | undefined, lang: Lang): string {
  if (!ts) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return t(lang, 'just_now');
  const mins = Math.floor(sec / 60);
  if (mins < 60) return t(lang, 'time_min_ago', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t(lang, 'time_hour_ago', { n: hours });
  const days = Math.floor(hours / 24);
  return t(lang, 'time_day_ago', { n: days });
}
