import { t } from '../i18n';
import { useLeftPanel } from '../data/leftPanelContext';
import { useRightChanges, useRightLayout } from '../data/rightPaneContext';
import type { Lang } from '../data/lang';

export function PanelToggleIcon({ side }: { side: 'left' | 'right' }) {
  return <span className={`ico-panel ico-panel-${side}`} aria-hidden="true" />;
}

export function SideToggles({ lang }: { lang: Lang }) {
  const { leftOpen, toggleLeft } = useLeftPanel();
  const { open, toggleRight } = useRightLayout();
  const { hasChanges } = useRightChanges();

  return (
    <>
      <button
        type="button"
        className="icon-btn side-toggle side-toggle-left"
        data-testid={leftOpen ? 'next-left-collapse' : 'next-left-open'}
        title={leftOpen ? t(lang, 'collapse_sidebar') : t(lang, 'expand_sidebar')}
        aria-label={leftOpen ? t(lang, 'collapse_sidebar') : t(lang, 'expand_sidebar')}
        aria-expanded={leftOpen}
        onClick={toggleLeft}
      >
        <PanelToggleIcon side="left" />
      </button>
      <button
        type="button"
        className="icon-btn side-toggle side-toggle-right"
        data-testid={open ? 'next-right-collapse' : 'next-right-toggle'}
        title={open ? t(lang, 'collapse_panel') : t(lang, 'expand_panel')}
        aria-label={open ? t(lang, 'collapse_panel') : t(lang, 'expand_panel')}
        aria-expanded={open}
        onClick={toggleRight}
      >
        <PanelToggleIcon side="right" />
        <span
          className={`top-right-dot${hasChanges ? ' is-on' : ''}`}
          data-testid="next-right-dot"
        />
      </button>
    </>
  );
}

/** @deprecated Replaced by shell-level SideToggles. */
export function LeftOpenButton() {
  return null;
}

/** @deprecated Replaced by shell-level SideToggles. Renders spacer slot in header. */
export function RightToggle() {
  return <div className="top-right" aria-hidden="true" />;
}
