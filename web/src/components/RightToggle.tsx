import { t } from '../i18n';
import { useRightPane } from '../data/rightPaneContext';
import type { Lang } from '../data/lang';

export function LeftOpenButton({ lang, onOpen }: { lang: Lang; onOpen?: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn top-left-open"
      data-testid="next-left-open"
      title={t(lang, 'expand_sidebar')}
      aria-label={t(lang, 'expand_sidebar')}
      onClick={onOpen}
    >
      <span className="ico-panel ico-panel-left" aria-hidden="true" />
    </button>
  );
}

export function RightToggle({ lang }: { lang: Lang }) {
  const { open, setOpen, hasChanges } = useRightPane();
  return (
    <button
      type="button"
      className="icon-btn top-right-open"
      data-testid="next-right-toggle"
      title={t(lang, 'expand_panel')}
      aria-label={t(lang, 'expand_panel')}
      aria-pressed={open}
      onClick={() => setOpen(!open)}
    >
      <span className="ico-panel ico-panel-right" aria-hidden="true" />
      <span
        className={`top-right-dot${hasChanges ? ' is-on' : ''}`}
        data-testid="next-right-dot"
      />
    </button>
  );
}
