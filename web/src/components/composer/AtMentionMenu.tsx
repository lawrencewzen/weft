import { useRef } from 'react';
import { splitFilePath } from '../../data/attachments';
import type { Lang } from '../../data/lang';
import { t } from '../../i18n';

const AT_MENU_FILE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

export type AtMentionMenuProps = {
  lang: Lang;
  treeError: boolean;
  treeLoading: boolean;
  matchedFiles: string[];
  atActiveIndex: number;
  onPick: (file: string) => void;
};

export function AtMentionMenu({
  lang,
  treeError,
  treeLoading,
  matchedFiles,
  atActiveIndex,
  onPick,
}: AtMentionMenuProps) {
  const atMenuRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={atMenuRef}
      className="composer-at-menu"
      data-testid="next-composer-at-menu"
      role="listbox"
      aria-label={t(lang, 'composer_at_header')}
    >
      <div className="composer-at-header">{t(lang, 'composer_at_header')}</div>
      <div className="composer-at-list">
        {treeError ? (
          <div className="composer-at-empty" data-testid="next-composer-at-empty">
            {t(lang, 'composer_at_unavailable')}
          </div>
        ) : treeLoading ? (
          <div className="composer-at-empty" data-testid="next-composer-at-empty">
            {t(lang, 'loading')}
          </div>
        ) : matchedFiles.length === 0 ? (
          <div className="composer-at-empty" data-testid="next-composer-at-empty">
            {t(lang, 'composer_at_empty')}
          </div>
        ) : (
          matchedFiles.map((file, idx) => {
            const { name, dir } = splitFilePath(file);
            const isActive = idx === atActiveIndex;
            return (
              <button
                key={file}
                type="button"
                className={`composer-at-item${isActive ? ' is-active' : ''}`}
                data-testid="next-composer-at-item"
                data-active={isActive ? 'true' : 'false'}
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(file);
                }}
              >
                <span className="composer-at-icon">{AT_MENU_FILE_ICON}</span>
                <span className="composer-at-name">{name}</span>
                {dir ? <span className="composer-at-dir">{dir}</span> : null}
              </button>
            );
          })
        )}
      </div>
      <div className="composer-at-footer">{t(lang, 'composer_at_footer')}</div>
    </div>
  );
}
