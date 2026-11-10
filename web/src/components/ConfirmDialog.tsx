import { useEffect, useRef } from 'react';
import type { Lang } from '../data/lang';
import { t } from '../i18n';

export type ConfirmOpts = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  defaultFocus?: 'confirm' | 'cancel';
  testId?: string;
  confirmTestId?: string;
  cancelTestId?: string;
};

type Props = {
  lang: Lang;
  opts: ConfirmOpts;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ lang, opts, onCancel, onConfirm }: Props) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (opts.defaultFocus === 'confirm') {
      confirmBtnRef.current?.focus();
    } else if (opts.defaultFocus === 'cancel') {
      cancelBtnRef.current?.focus();
    }
  }, [opts.defaultFocus]);

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

  return (
    <div
      className="modal-overlay"
      data-testid={opts.testId ? `${opts.testId}-overlay` : 'next-confirm-overlay'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className={`modal-dialog confirm-dialog${opts.danger ? ' is-danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        data-testid={opts.testId || 'next-confirm'}
        data-danger={opts.danger ? 'true' : 'false'}
      >
        <h3>
          {opts.title}
          <button type="button" className="confirm-close" onClick={onCancel} aria-label={t(lang, 'btn_cancel')}>
            ×
          </button>
        </h3>
        <p className="confirm-message" data-testid="next-confirm-message">{opts.message}</p>
        <div className="modal-actions">
          <button
            type="button"
            ref={cancelBtnRef}
            className="btn"
            data-testid={opts.cancelTestId || 'next-confirm-cancel'}
            onClick={onCancel}
          >
            {t(lang, 'btn_cancel')}
          </button>
          <button
            type="button"
            ref={confirmBtnRef}
            className={`btn ${opts.danger ? 'danger' : 'p'}`}
            data-testid={opts.confirmTestId || 'next-confirm-ok'}
            onClick={onConfirm}
          >
            {opts.confirmLabel || t(lang, 'btn_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
