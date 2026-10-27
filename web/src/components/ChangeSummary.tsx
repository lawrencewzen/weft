import type { Lang } from '../data/lang';
import { useRightPane } from '../data/rightPaneContext';
import type { Change } from '../data/store';
import { t } from '../i18n';

type Props = {
  changes: Change[];
  lang: Lang;
};

export function ChangeSummary({ changes, lang }: Props) {
  const { openChangeDiff, setOpen } = useRightPane();
  if (!changes.length) return null;

  function openDiff(path: string) {
    if (!path) return;
    setOpen(true);
    openChangeDiff(path);
  }

  return (
    <div
      className="change-summary"
      data-testid="next-change-summary"
      title={t(lang, 'tab_diff_title')}
    >
      {changes.map((change) => (
        <button
          key={change.path}
          type="button"
          className="change-summary-row"
          data-testid="next-change-summary-row"
          data-path={change.path}
          onClick={() => openDiff(change.path)}
        >
          <span className="change-summary-path">{change.path}</span>
          <span className="change-summary-add">+{change.added}</span>
          <span className="change-summary-del">−{change.removed}</span>
        </button>
      ))}
    </div>
  );
}
