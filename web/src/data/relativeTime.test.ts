import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relativeTime';

// 2026-10-29T12:00:00.000Z (Thursday)
const NOW = Date.parse('2026-10-29T12:00:00.000Z');

describe('formatRelativeTime', () => {
  it('formats "just now" for events under one minute ago', () => {
    expect(formatRelativeTime('zh', NOW - 5_000, NOW)).toBe('刚刚');
    expect(formatRelativeTime('zh', NOW - 59_000, NOW)).toBe('刚刚');
    expect(formatRelativeTime('en', NOW - 5_000, NOW)).toBe('Just now');
  });

  it('formats minutes for events under one hour ago', () => {
    expect(formatRelativeTime('zh', NOW - 120_000, NOW)).toBe('2 分钟');
    expect(formatRelativeTime('zh', NOW - 52 * 60_000, NOW)).toBe('52 分钟');
    expect(formatRelativeTime('en', NOW - 120_000, NOW)).toBe('2m');
    expect(formatRelativeTime('en', NOW - 52 * 60_000, NOW)).toBe('52m');
  });

  it('formats hours for events today that are one hour or older', () => {
    expect(formatRelativeTime('zh', NOW - 3 * 3600_000, NOW)).toBe('3 小时');
    expect(formatRelativeTime('en', NOW - 3 * 3600_000, NOW)).toBe('3h');
  });

  it('formats yesterday for events exactly 1 calendar day ago', () => {
    // 24 hours ago: 2026-10-28 12:00 (Wednesday)
    expect(formatRelativeTime('zh', NOW - 24 * 3600_000, NOW)).toBe('昨天');
    expect(formatRelativeTime('en', NOW - 24 * 3600_000, NOW)).toBe('Yesterday');
  });

  it('formats weekday for events 2-6 days ago', () => {
    // 3 days ago: 2026-10-26 (Monday)
    expect(formatRelativeTime('zh', NOW - 3 * 24 * 3600_000, NOW)).toBe('周一');
    expect(formatRelativeTime('en', NOW - 3 * 24 * 3600_000, NOW)).toBe('Mon');

    // 4 days ago: 2026-10-25 (Sunday)
    expect(formatRelativeTime('zh', NOW - 4 * 24 * 3600_000, NOW)).toBe('周日');
    expect(formatRelativeTime('en', NOW - 4 * 24 * 3600_000, NOW)).toBe('Sun');
  });

  it('formats M月D日 for events 7 or more days ago', () => {
    // 14 days ago: 2026-10-15
    expect(formatRelativeTime('zh', NOW - 14 * 24 * 3600_000, NOW)).toBe('10月15日');
    expect(formatRelativeTime('en', NOW - 14 * 24 * 3600_000, NOW)).toBe('10/15');
  });

  it('returns empty text for missing or invalid timestamps', () => {
    expect(formatRelativeTime('zh', 0, NOW)).toBe('');
    expect(formatRelativeTime('zh', null, NOW)).toBe('');
    expect(formatRelativeTime('zh', undefined, NOW)).toBe('');
    expect(formatRelativeTime('zh', -100, NOW)).toBe('');
    expect(formatRelativeTime('zh', 'invalid', NOW)).toBe('');
  });
});
