import { describe, expect, it } from 'vitest';
import { gitAheadBehind, gitDiffParts, type GitStatus } from './gitBar';

function git(partial: Partial<GitStatus>): GitStatus {
  return {
    branch: 'main',
    detached: false,
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    ahead: null,
    behind: null,
    ...partial,
  };
}

describe('gitBar', () => {
  it('omits +/- when there are no line changes', () => {
    expect(gitDiffParts(null)).toBeNull();
    expect(gitDiffParts(git({ changedFiles: 2 }))).toBeNull();
  });

  it('formats insertions and deletions with a unicode minus', () => {
    expect(gitDiffParts(git({ insertions: 12, deletions: 3 }))).toEqual({
      ins: '+12',
      del: '\u22123',
    });
    expect(gitDiffParts(git({ insertions: 4, deletions: 0 }))).toEqual({
      ins: '+4',
      del: '\u22120',
    });
  });

  it('shows ahead/behind only when the count is positive', () => {
    expect(gitAheadBehind(null)).toEqual({ ahead: null, behind: null });
    expect(gitAheadBehind(git({ ahead: 0, behind: 0 }))).toEqual({ ahead: null, behind: null });
    expect(gitAheadBehind(git({ ahead: 2, behind: 1 }))).toEqual({
      ahead: '\u21912',
      behind: '\u21931',
    });
  });
});
