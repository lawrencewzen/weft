import { describe, expect, it } from 'vitest';
import {
  computeScrollTarget,
  isNearBottom,
  shouldFollowScroll,
  STICK_PX,
} from './threadScroll';

describe('threadScroll helpers', () => {
  it('exports STICK_PX = 80', () => {
    expect(STICK_PX).toBe(80);
  });

  describe('computeScrollTarget', () => {
    it('returns 0 when total scrollable distance is within bottom padding + 1', () => {
      // scrollHeight <= clientHeight
      expect(computeScrollTarget(500, 600, 96)).toBe(0);
      expect(computeScrollTarget(600, 600, 96)).toBe(0);

      // maxScroll (50) <= padBottom (96) + 1
      expect(computeScrollTarget(650, 600, 96)).toBe(0);
      expect(computeScrollTarget(697, 600, 96)).toBe(0);
    });

    it('returns maxScroll when content overflows beyond padding', () => {
      // maxScroll is 98 > 97
      expect(computeScrollTarget(698, 600, 96)).toBe(98);
      // larger overflow
      expect(computeScrollTarget(1500, 600, 96)).toBe(900);
    });

    it('handles zero padBottom', () => {
      expect(computeScrollTarget(500, 600, 0)).toBe(0);
      expect(computeScrollTarget(601, 600, 0)).toBe(0); // maxScroll is 1 <= 0 + 1 -> 0
      expect(computeScrollTarget(602, 600, 0)).toBe(2); // maxScroll is 2 > 1 -> 2
    });

    it('handles subpixel / floating point values', () => {
      expect(computeScrollTarget(1200.5, 600, 96)).toBe(600.5);
    });
  });

  describe('isNearBottom', () => {
    it('returns true when scroll position is at the very bottom', () => {
      // distance = 1000 - 400 - 600 = 0 < 80
      expect(isNearBottom(1000, 400, 600)).toBe(true);
    });

    it('returns true when distance from bottom is less than STICK_PX', () => {
      // distance = 1000 - 321 - 600 = 79 < 80
      expect(isNearBottom(1000, 321, 600)).toBe(true);
      // distance = 1000 - 350 - 600 = 50 < 80
      expect(isNearBottom(1000, 350, 600)).toBe(true);
    });

    it('returns false when distance from bottom is equal to or greater than STICK_PX', () => {
      // distance = 1000 - 320 - 600 = 80 == 80
      expect(isNearBottom(1000, 320, 600)).toBe(false);
      // distance = 1000 - 100 - 600 = 300 > 80
      expect(isNearBottom(1000, 100, 600)).toBe(false);
      // at the very top: distance = 1000 - 0 - 600 = 400 > 80
      expect(isNearBottom(1000, 0, 600)).toBe(false);
    });

    it('returns true on overscroll / momentum rebound (negative distance)', () => {
      // distance = 1000 - 410 - 600 = -10 < 80
      expect(isNearBottom(1000, 410, 600)).toBe(true);
    });

    it('respects custom stickPx threshold', () => {
      expect(isNearBottom(1000, 350, 600, 40)).toBe(false); // distance 50 >= 40
      expect(isNearBottom(1000, 370, 600, 40)).toBe(true); // distance 30 < 40
    });
  });

  describe('shouldFollowScroll', () => {
    it('returns true when stick is true and content height has grown', () => {
      expect(shouldFollowScroll(1200, 1000, true)).toBe(true);
      expect(shouldFollowScroll(1001, 1000, true)).toBe(true);
    });

    it('returns false when stick is false even if content height has grown', () => {
      expect(shouldFollowScroll(1200, 1000, false)).toBe(false);
      expect(shouldFollowScroll(2000, 500, false)).toBe(false);
    });

    it('returns false when content height did not increase', () => {
      expect(shouldFollowScroll(1000, 1000, true)).toBe(false);
      expect(shouldFollowScroll(900, 1000, true)).toBe(false);
      expect(shouldFollowScroll(900, 1000, false)).toBe(false);
    });
  });
});
