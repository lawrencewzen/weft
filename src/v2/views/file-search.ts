/** Workspace file search view. Listing is cached in the core module; ranking is pure. */

import { listWorkspaceFiles } from '../../core/workspace-file-search.mjs';
import type { components } from '../contract.gen.ts';
import { posixPath } from './changes.ts';
import { rankFileMatches } from './file-search-match.ts';

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
  return {
    entries: rankFileMatches(listed.files, q, opts.limit).map((entry) => ({
      path: posixPath(entry.path),
      score: entry.score,
    })),
    truncated: Boolean(listed.truncated),
  };
}
