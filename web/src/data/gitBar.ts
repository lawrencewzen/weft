import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import type { Lang } from './lang';

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

export function formatComposerGitTitle(lang: Lang, git: GitStatus | null | undefined): string {
  if (!git?.branch) return '';
  const parts: string[] = [t(lang, 'git_chip_branch', { branch: git.branch })];
  const totalDiff = (git.insertions || 0) + (git.deletions || 0);
  if (totalDiff > 0) {
    parts.push(
      t(lang, 'git_chip_diff', {
        ins: git.insertions || 0,
        del: git.deletions || 0,
      }),
    );
  }
  if (git.ahead != null && git.ahead > 0) {
    parts.push(t(lang, 'git_chip_ahead', { n: git.ahead }));
  }
  return parts.join(' · ');
}
