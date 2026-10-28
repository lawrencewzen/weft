import { describe, expect, it } from 'vitest';
import { formatComposerGitTitle, gitAheadBehind, gitDiffParts, type GitStatus } from './gitBar';

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

  describe('formatComposerGitTitle', () => {
    it('returns empty string when no branch', () => {
      expect(formatComposerGitTitle('zh', null)).toBe('');
      expect(formatComposerGitTitle('zh', git({ branch: '' }))).toBe('');
    });

    it('formats full title with branch, uncommitted diff and ahead in zh', () => {
      const status = git({
        branch: 'agent/fix-login-timeout',
        insertions: 28,
        deletions: 9,
        ahead: 3,
      });
      expect(formatComposerGitTitle('zh', status)).toBe(
        '分支 agent/fix-login-timeout · 未提交 +28 \u22129 · 领先远端 3 个提交',
      );
    });

    it('formats title without diff or ahead when neither exists', () => {
      const status = git({
        branch: 'main',
        insertions: 0,
        deletions: 0,
        ahead: 0,
      });
      expect(formatComposerGitTitle('zh', status)).toBe('分支 main');
    });

    it('formats title with diff only when no ahead', () => {
      const status = git({
        branch: 'main',
        insertions: 42,
        deletions: 7,
        ahead: null,
      });
      expect(formatComposerGitTitle('zh', status)).toBe('分支 main · 未提交 +42 \u22127');
    });

    it('formats title with ahead only when no diff', () => {
      const status = git({
        branch: 'main',
        insertions: 0,
        deletions: 0,
        ahead: 2,
      });
      expect(formatComposerGitTitle('zh', status)).toBe('分支 main · 领先远端 2 个提交');
    });

    it('formats full title in en', () => {
      const status = git({
        branch: 'agent/fix-login-timeout',
        insertions: 28,
        deletions: 9,
        ahead: 3,
      });
      expect(formatComposerGitTitle('en', status)).toBe(
        'Branch agent/fix-login-timeout · Uncommitted +28 \u22129 · 3 commits ahead',
      );
    });
  });
});
