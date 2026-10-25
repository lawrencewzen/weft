/** Change list and structured Diff views for the conversation right pane. */

import { liveDiff, structuredDiff } from '../../core/diff.mjs';
import type { components } from '../contract.gen.ts';

export type Change = components['schemas']['Change'];
export type Diff = components['schemas']['Diff'];

export type KernelChange = {
  path?: unknown;
  added?: unknown;
  removed?: unknown;
  error?: unknown;
  toolCallId?: unknown;
};

export type KernelDiffBody = {
  path?: unknown;
  before?: unknown;
  after?: unknown;
  unified?: unknown;
  added?: unknown;
  removed?: unknown;
  error?: unknown;
};

/** Relative workspace paths always use `/`, including Windows input. */
export function posixPath(p: unknown): string {
  return String(p ?? '').replaceAll('\\', '/');
}

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function changeView(row: KernelChange): Change {
  const error = row.error == null || row.error === '' ? null : String(row.error);
  return {
    path: posixPath(row.path),
    added: asCount(row.added),
    removed: asCount(row.removed),
    error,
  };
}

export function changeViews(rows: KernelChange[] | null | undefined): Change[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(changeView);
}

export function findKernelChange(rows: KernelChange[] | null | undefined, filePath: string): KernelChange | null {
  const want = posixPath(filePath);
  if (!want) return null;
  for (const row of rows || []) {
    if (posixPath(row.path) === want) return row;
  }
  return null;
}

function tooLargeDiff(path: string, row: KernelChange | KernelDiffBody | null | undefined): Diff {
  return {
    path: posixPath(row?.path ?? path),
    added: asCount(row?.added),
    removed: asCount(row?.removed),
    hunks: [],
    tooLarge: true,
  };
}

function isTooLargeBody(body: KernelDiffBody | null | undefined): boolean {
  if (!body) return false;
  if (body.error == null) return false;
  return String(body.error).length > 0;
}

/** Build a v2 Diff from kernel liveDiff / oversized payload. */
export function diffView(body: KernelDiffBody | null | undefined, filePath: string): Diff {
  if (!body || isTooLargeBody(body)) return tooLargeDiff(filePath, body);
  const path = posixPath(body.path ?? filePath);
  const before = body.before == null ? '' : String(body.before);
  const after = body.after == null ? '' : String(body.after);
  const structured = structuredDiff(path, before, after) as {
    path: string;
    added: number;
    removed: number;
    hunks: Diff['hunks'];
  };
  return {
    path: structured.path,
    added: asCount(structured.added),
    removed: asCount(structured.removed),
    hunks: structured.hunks,
    tooLarge: false,
  };
}

export function liveDiffView(input: {
  path: string;
  before?: string;
  storedAfter?: string;
  diskText?: string | null;
}): Diff {
  const live = liveDiff({
    path: posixPath(input.path),
    before: input.before,
    storedAfter: input.storedAfter,
    diskText: input.diskText,
  }) as { path: string; before: string; after: string; added: number; removed: number };
  return diffView(live, live.path);
}
