/** Workspace file search view. The file list is cached; only ranked hits are stat'ed, until `limit`. */

import { isListedWorkspaceFile, listWorkspaceFiles } from '../../core/workspace-file-search.mjs';
import type { components } from '../contract.gen.ts';
import { posixPath } from './changes.ts';
import { parseFileSearchLimit, rankAllFileMatches } from './file-search-match.ts';

export type FileSearchResult = components['schemas']['FileSearchResult'];

type FileList = { files: string[]; truncated: boolean };

export type FileSearchListOpts = {
  limit?: unknown;
  state?: unknown;
  now?: () => number;
  ttlMs?: number;
  maxFiles?: number;
  gitTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  runGit?: (
    root: string,
    opts: { maxFiles: number; timeoutMs: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ ok: boolean; files?: string[]; truncated?: boolean }>;
};

export async function searchWorkspaceFiles(
  root: string,
  query: string | null,
  opts: FileSearchListOpts = {},
): Promise<FileSearchResult> {
  const q = typeof query === 'string' ? query : '';
  if (q === '') return { entries: [], truncated: false };
  const listed = await listWorkspaceFiles(root, opts) as FileList;
  const cap = parseFileSearchLimit(opts.limit);
  const ranked = rankAllFileMatches(listed.files, q);
  const entries: FileSearchResult['entries'] = [];
  for (const hit of ranked) {
    if (entries.length >= cap) break;
    if (!(await isListedWorkspaceFile(root, hit.path))) continue;
    entries.push({ path: posixPath(hit.path), score: hit.score });
  }
  return { entries, truncated: Boolean(listed.truncated) };
}
