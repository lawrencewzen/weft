import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import { t } from '../i18n';

type Props = {
  lang: Lang;
  isConfirmQuit: boolean;
  onCancel: () => void;
  onAction: (action: 'tray' | 'quit', remember: boolean) => void;
};

export function WindowCloseDialog({ lang, isConfirmQuit, onCancel, onAction }: Props) {
  const [remember, setRemember] = useState(false);
  const trayBtnRef = useRef<HTMLButtonElement>(null);
  const quitBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isConfirmQuit) {
      quitBtnRef.current?.focus();
    } else {
      trayBtnRef.current?.focus();
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

        <p className="confirm-message window-close-note" data-testid="window-close-note">
          {t(lang, 'window_close_quit_note')}
        </p>

        <div className="modal-actions window-close-actions">
          {!isConfirmQuit ? (
            <label className="ns-chk window-close-remember">
              <input
                type="checkbox"
                data-testid="window-close-remember"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>{t(lang, 'window_close_remember')}</span>
            </label>
          ) : null}

          <div className="window-close-btns">
            {isConfirmQuit ? (
              <>
                <button
                  type="button"
                  className="btn"
                  data-testid="window-close-tray"
                  onClick={() => onAction('tray', remember)}
                >
                  {t(lang, 'window_close_tray')}
                </button>
                <button
                  type="button"
                  ref={quitBtnRef}
                  className="btn p"
                  data-testid="window-close-quit"
                  onClick={() => onAction('quit', remember)}
                >
                  {t(lang, 'window_close_quit')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn"
                  data-testid="window-close-quit"
                  onClick={() => onAction('quit', remember)}
                >
                  {t(lang, 'window_close_quit')}
                </button>
                <button
                  type="button"
                  ref={trayBtnRef}
                  className="btn p"
                  data-testid="window-close-tray"
                  onClick={() => onAction('tray', remember)}
                >
                  {t(lang, 'window_close_tray')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
