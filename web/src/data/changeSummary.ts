import type { Change } from './store';

export const CHANGE_SUMMARY_COLLAPSE_THRESHOLD = 6;
export const CHANGE_SUMMARY_COLLAPSED_COUNT = 5;

export type SplitChangePath = {
  displayPath: string;
  name: string;
  dir: string;
  outside: boolean;
};

/**
 * Split a file path into filename and directory, abbreviating home directory
 * for outside-workspace paths (~/...) and flagging outside workspace status.
 */
export function splitChangePath(filePath: string): SplitChangePath {
  const norm = String(filePath ?? '').replaceAll('\\', '/');
  const isOutside = norm.startsWith('/') || norm.startsWith('~') || /^[A-Za-z]:\//.test(norm);
  let display = norm;
  if (isOutside) {
    display = display
      .replace(/^\/Users\/[^/]+/, '~')
      .replace(/^[A-Za-z]:\/Users\/[^/]+/i, '~');
  }
  const lastSlash = display.lastIndexOf('/');
  const name = lastSlash >= 0 ? display.slice(lastSlash + 1) : display;
  const dir = lastSlash >= 0 ? display.slice(0, lastSlash + 1) : '';
  return {
    displayPath: display,
    name,
    dir,
    outside: isOutside,
  };
}

/**
 * Sort changes descending by total changes (added + removed),
 * breaking ties alphabetically by path.
 */
export function sortChanges(changes: readonly Change[]): Change[] {
  return [...changes].sort((a, b) => {
    const diff = (b.added + b.removed) - (a.added + a.removed);
    if (diff !== 0) return diff;
    return a.path.localeCompare(b.path);
  });
}

/**
 * Whether the list of changes exceeds the collapse threshold (> 6 files).
 */
export function isChangeSummaryCollapsible(count: number): boolean {
  return count > CHANGE_SUMMARY_COLLAPSE_THRESHOLD;
}

/**
 * Determine which changes to display based on collapsible state and whether expanded.
 * When collapsible and not expanded, shows the first 5 changes.
 */
export function getShownChanges(
  sorted: readonly Change[],
  expanded: boolean,
  limit: number = CHANGE_SUMMARY_COLLAPSED_COUNT,
): Change[] {
  if (!isChangeSummaryCollapsible(sorted.length) || expanded) {
    return [...sorted];
  }
  return sorted.slice(0, limit);
}

/**
 * Number of files hidden when collapsed.
 */
export function remainingHiddenCount(
  totalCount: number,
  limit: number = CHANGE_SUMMARY_COLLAPSED_COUNT,
): number {
  return Math.max(0, totalCount - limit);
}
