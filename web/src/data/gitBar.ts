import type { components } from '../../../src/v2/contract.gen';

export type GitStatus = components['schemas']['GitStatus'];

const MINUS = '\u2212';

export function gitDiffParts(git: GitStatus | null | undefined): { ins: string; del: string } | null {
  if (!git) return null;
  if (!git.insertions && !git.deletions) return null;
  return {
    ins: `+${git.insertions}`,
    del: `${MINUS}${git.deletions}`,
  };
}

export function gitAheadBehind(git: GitStatus | null | undefined): { ahead: string | null; behind: string | null } {
  if (!git) return { ahead: null, behind: null };
  return {
    ahead: git.ahead != null && git.ahead > 0 ? `\u2191${git.ahead}` : null,
    behind: git.behind != null && git.behind > 0 ? `\u2193${git.behind}` : null,
  };
}
