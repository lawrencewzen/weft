export const STICK_PX = 80;

/**
 * Computes the target scrollTop to scroll the thread container to the bottom.
 * If the scrollable distance is within bottom padding (padBottom + 1),
 * target is 0 so short threads stay pinned to the top.
 */
export function computeScrollTarget(
  scrollHeight: number,
  clientHeight: number,
  padBottom = 0,
): number {
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  return maxScroll <= padBottom + 1 ? 0 : maxScroll;
}

/**
 * Returns true if the current scroll position is close enough to the bottom
 * (distance strictly less than stickPx) to consider it sticking to the bottom.
 */
export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  stickPx: number = STICK_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < stickPx;
}

/**
 * Determines whether the thread should auto-scroll to the bottom based on content height growth:
 * only when stick is true and content height has strictly increased.
 */
export function shouldFollowScroll(
  currentHeight: number,
  lastHeight: number,
  stick: boolean,
): boolean {
  return stick && currentHeight > lastHeight;
}
