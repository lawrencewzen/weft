/**
 * Case-insensitive subsequence scoring for workspace file search.
 * Pure: no filesystem, no timers. Higher scores sort first.
 *
 * A match whose characters all sit in the filename outranks any match that
 * has to use a directory. Within that, a hit at the start of the filename
 * outranks a later hit, and adjacent characters outrank gaps. Equal scores
 * are ordered by shorter path, then by code-unit order.
 */

export const FILE_SEARCH_DEFAULT_LIMIT = 50;
export const FILE_SEARCH_MAX_LIMIT = 200;

/** Large enough that every filename-only match beats every directory match. */
const FILENAME_TIER = 1_000_000_000;
/** Each filename character in a mixed match beats any run of directory characters. */
const FILE_CHAR = 1_000;
const BASE = 1;
const PREFIX = 16;
const SEGMENT = 4;
const CONSEC = 8;
const NEG = -1e15;
/** Above this, alignment switches to a linear scan so a huge query cannot stall the process. */
const MAX_DP_CELLS = 80_000;

export type FileMatch = { path: string; score: number };

export function parseFileSearchLimit(
  raw: unknown,
  fallback = FILE_SEARCH_DEFAULT_LIMIT,
  max = FILE_SEARCH_MAX_LIMIT,
): number {
  if (raw == null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return fallback;
  const t = Math.trunc(n);
  if (t < 1) return fallback;
  return t > max ? max : t;
}

function isSep(ch: string): boolean {
  return ch === '/' || ch === '-' || ch === '_' || ch === '.' || ch === ' ';
}

function bonuses(folded: string, mode: 'name' | 'path', fileStart: number): { base: number[]; consec: number[] } {
  const n = folded.length;
  const base = new Array<number>(n);
  const consec = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const inFile = mode === 'name' || i >= fileStart;
    let score = BASE;
    if (mode === 'path' && inFile) score += FILE_CHAR;
    const atNameStart = mode === 'name' ? i === 0 : i === fileStart;
    if (atNameStart) score += PREFIX;
    else if (i > 0 && isSep(folded[i - 1])) score += SEGMENT;
    else if (mode === 'path' && i === 0) score += SEGMENT;
    base[i] = score;
    consec[i] = CONSEC;
  }
  return { base, consec };
}

function isSubsequence(text: string, query: string): boolean {
  let j = 0;
  for (let i = 0; i < text.length && j < query.length; i += 1) {
    if (text[i] === query[j]) j += 1;
  }
  return j === query.length;
}

function greedyScore(
  folded: string,
  query: string,
  table: { base: number[]; consec: number[] },
): number | null {
  let prev = -1;
  let score = 0;
  let j = 0;
  for (let i = 0; i < folded.length && j < query.length; i += 1) {
    if (folded[i] !== query[j]) continue;
    score += table.base[i] + (prev === i - 1 ? table.consec[i] : 0);
    prev = i;
    j += 1;
  }
  return j === query.length ? score : null;
}

function alignScore(
  folded: string,
  query: string,
  mode: 'name' | 'path',
  fileStart: number,
): number | null {
  const n = folded.length;
  const m = query.length;
  if (m === 0 || m > n) return null;
  const table = bonuses(folded, mode, fileStart);
  if (m * n > MAX_DP_CELLS) return greedyScore(folded, query, table);

  let prev = new Array<number>(n);
  const q0 = query[0];
  let any = false;
  for (let i = 0; i < n; i += 1) {
    if (folded[i] === q0) {
      prev[i] = table.base[i];
      any = true;
    } else {
      prev[i] = NEG;
    }
  }
  if (!any) return null;

  for (let j = 1; j < m; j += 1) {
    const qch = query[j];
    const row = new Array<number>(n);
    let bestGap = NEG;
    let rowAny = false;
    for (let i = 0; i < n; i += 1) {
      if (i >= 2 && prev[i - 2] > bestGap) bestGap = prev[i - 2];
      if (folded[i] !== qch) {
        row[i] = NEG;
        continue;
      }
      let best = NEG;
      if (bestGap > NEG) best = bestGap + table.base[i];
      if (i > 0 && prev[i - 1] > NEG) {
        const adjacent = prev[i - 1] + table.base[i] + table.consec[i];
        if (adjacent > best) best = adjacent;
      }
      row[i] = best;
      if (best > NEG) rowAny = true;
    }
    if (!rowAny) return null;
    prev = row;
  }

  let best = NEG;
  for (let i = 0; i < n; i += 1) {
    if (prev[i] > best) best = prev[i];
  }
  return best > NEG ? best : null;
}

/** Null when `query` is empty or not a case-insensitive subsequence of `filePath`. */
export function scorePath(filePath: string, query: string): number | null {
  if (typeof filePath !== 'string' || typeof query !== 'string' || query.length === 0) return null;
  const foldedPath = filePath.toLowerCase();
  const foldedQuery = query.toLowerCase();
  if (foldedQuery.length === 0 || foldedQuery.length > foldedPath.length) return null;
  const fileStart = foldedPath.lastIndexOf('/') + 1;
  const name = foldedPath.slice(fileStart);
  if (name.length >= foldedQuery.length && isSubsequence(name, foldedQuery)) {
    const score = alignScore(name, foldedQuery, 'name', 0);
    return score == null ? null : FILENAME_TIER + score;
  }
  if (!isSubsequence(foldedPath, foldedQuery)) return null;
  return alignScore(foldedPath, foldedQuery, 'path', fileStart);
}

export function rankAllFileMatches(paths: readonly string[], query: string): FileMatch[] {
  const q = typeof query === 'string' ? query : '';
  if (q === '') return [];
  const hits: FileMatch[] = [];
  for (const filePath of paths) {
    if (typeof filePath !== 'string' || filePath === '') continue;
    const score = scorePath(filePath, q);
    if (score == null) continue;
    hits.push({ path: filePath, score });
  }
  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  return hits;
}

export function rankFileMatches(paths: readonly string[], query: string, limit?: unknown): FileMatch[] {
  const hits = rankAllFileMatches(paths, query);
  const cap = parseFileSearchLimit(limit);
  return hits.length <= cap ? hits : hits.slice(0, cap);
}
