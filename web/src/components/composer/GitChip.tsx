import { formatComposerGitTitle } from '../../data/gitBar';
import type { Lang } from '../../data/lang';
import { isChatWorkspace } from '../../data/store';
import { useWorkspaces } from '../../data/useWorkspaces';

const GIT_BRANCH_ICON = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="4" cy="3.5" r="1.6" />
    <circle cx="4" cy="12.5" r="1.6" />
    <circle cx="12" cy="5" r="1.6" />
    <path d="M4 5v6M12 6.6c0 3-4 2.2-8 4.4" />
  </svg>
);

export type GitChipProps = {
  lang: Lang;
  workspaceId?: string | null;
};

export function GitChip({ lang, workspaceId = null }: GitChipProps) {
  const { workspaces } = useWorkspaces();
  const currentWorkspace = workspaces.find((ws) => ws.id === workspaceId) || null;
  const git = currentWorkspace?.git ?? null;
  const totalDiff = (git?.insertions || 0) + (git?.deletions || 0);
  const hasDiff = totalDiff > 0;

  if (isChatWorkspace(currentWorkspace) || !git?.branch) return null;

  return (
    <button
      type="button"
      className="composer-git-chip"
      data-testid="next-composer-git"
      title={formatComposerGitTitle(lang, git)}
    >
      {GIT_BRANCH_ICON}
      <span className="composer-git-branch" data-testid="next-composer-git-branch">
        {git.branch}
      </span>
      {hasDiff ? (
        <>
          <span className="composer-git-ins" data-testid="next-composer-git-ins">
            +{git.insertions || 0}
          </span>
          <span className="composer-git-del" data-testid="next-composer-git-del">
            {"−" + (git.deletions || 0)}
          </span>
        </>
      ) : null}
      {git.ahead != null && git.ahead > 0 ? (
        <span className="composer-git-ahead" data-testid="next-composer-git-ahead">
          {"↑" + git.ahead}
        </span>
      ) : null}
    </button>
  );
}
