import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relativeTime';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');

describe('formatRelativeTime', () => {
  it('formats seconds, minutes, hours, and calendar days', () => {
    expect(formatRelativeTime('zh', NOW - 5_000, NOW)).toBe('5秒前');
    expect(formatRelativeTime('zh', NOW - 120_000, NOW)).toBe('2分钟前');
    expect(formatRelativeTime('zh', NOW - 3_600_000 * 3, NOW)).toBe('3小时前');
    expect(formatRelativeTime('en', NOW - 5_000, NOW)).toBe('5s ago');
  });

  it('returns empty text for missing timestamps', () => {
    expect(formatRelativeTime('zh', 0, NOW)).toBe('');
    expect(formatRelativeTime('zh', null, NOW)).toBe('');
  });
});
