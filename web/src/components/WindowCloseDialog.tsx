import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import { t } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';

type Props = {
  lang: Lang;
  isConfirmQuit?: boolean;
  onCancel: () => void;
  onAction: (action: 'tray' | 'quit', remember: boolean) => void;
};

const TRAY_ICON = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="window-close-card-icon"
  >
    <path d="M3 11.5v3a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-3" />
    <path d="M9 2.5v8m-3.5-3.5L9 10.5l3.5-3.5" />
  </svg>
);

const QUIT_ICON = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="window-close-card-icon"
  >
    <path d="M9 2.5v6" />
    <path d="M5.1 4.5A6.5 6.5 0 1 0 12.9 4.5" />
  </svg>
);

export function WindowCloseDialog({ lang, isConfirmQuit, onCancel, onAction }: Props) {
  const [remember, setRemember] = useState(false);
  const trayCardRef = useRef<HTMLButtonElement>(null);
  const quitCardRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isConfirmQuit) {
      trayCardRef.current?.focus();
    }
  }, [isConfirmQuit]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  if (isConfirmQuit) {
    return (
      <ConfirmDialog
        lang={lang}
        opts={{
          title: t(lang, 'window_close_confirm_quit_title'),
          message: t(lang, 'window_close_quit_note'),
          confirmLabel: t(lang, 'btn_quit'),
          defaultFocus: 'confirm',
          testId: 'confirm-quit-dialog',
          confirmTestId: 'confirm-quit-ok',
          cancelTestId: 'confirm-quit-cancel',
        }}
        onCancel={onCancel}
        onConfirm={() => onAction('quit', false)}
      />
    );
  }

  const handleCardKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (document.activeElement === trayCardRef.current) {
        quitCardRef.current?.focus();
      } else {
        trayCardRef.current?.focus();
      }
    }
  };

  const handleOverlayClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  return (
    <div
      className="modal-overlay"
      data-testid="window-close-overlay"
      onClick={handleOverlayClick}
    >
      <div
        className="modal-dialog confirm-dialog window-close-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="window-close-title"
        data-testid="window-close-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="window-close-title">
          {t(lang, 'window_close_dialog_title')}
          <button
            type="button"
            className="confirm-close"
            onClick={onCancel}
            aria-label={t(lang, 'btn_cancel')}
            data-testid="window-close-cancel"
          >
            ×
          </button>
        </h3>

        <div className="window-close-cards" role="group">
          <button
            type="button"
            ref={trayCardRef}
            className="window-close-card"
            data-testid="window-close-tray"
            data-action="tray"
            onClick={() => onAction('tray', remember)}
            onKeyDown={handleCardKeyDown}
          >
            <div className="window-close-card-head">
              {TRAY_ICON}
              <span className="window-close-card-title">{t(lang, 'window_close_tray')}</span>
            </div>
            <p className="window-close-card-desc">{t(lang, 'window_close_tray_desc')}</p>
          </button>

          <button
            type="button"
            ref={quitCardRef}
            className="window-close-card"
            data-testid="window-close-quit"
            data-action="quit"
            onClick={() => onAction('quit', remember)}
            onKeyDown={handleCardKeyDown}
          >
            <div className="window-close-card-head">
              {QUIT_ICON}
              <span className="window-close-card-title">{t(lang, 'window_close_quit')}</span>
            </div>
            <p className="window-close-card-desc">{t(lang, 'window_close_quit_desc')}</p>
          </button>
        </div>

        <div className="window-close-footer">
          <label className="window-close-remember" data-testid="window-close-remember">
            <input
              type="checkbox"
              data-testid="window-close-remember-check"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span className="window-close-remember-text">{t(lang, 'window_close_remember')}</span>
          </label>
          <span className="window-close-settings-hint" data-testid="window-close-settings-hint">
            {t(lang, 'window_close_settings_hint')}
          </span>
        </div>
      </div>
    </div>
  );
}
