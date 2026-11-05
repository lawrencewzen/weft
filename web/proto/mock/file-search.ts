import { rankFileMatches } from '../../../src/v2/views/file-search-match';
import type { MockRepo } from './repo';
import type { FileSearchResult } from './types';

/** Same matcher as the server, over the prototype's seed file tree. The seed never hits the 200000 cap. */
export function searchRepoFiles(repo: MockRepo, query: string, limit: string | null): FileSearchResult {
  if (!query) return { entries: [], truncated: false };
  return {
    entries: rankFileMatches([...repo.files.keys()], query, limit),
    truncated: false,
  };
}
