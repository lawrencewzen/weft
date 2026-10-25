import type { Lang } from '../data/lang';
import { t } from '../i18n';

export type ConfirmOpts = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
};

type Props = {
  lang: Lang;
  opts: ConfirmOpts;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ lang, opts, onCancel, onConfirm }: Props) {
  return (
    <div className="modal-overlay" data-testid="next-confirm-overlay">
      <div
        className={`modal-dialog confirm-dialog${opts.danger ? ' is-danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        data-testid="next-confirm"
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
          <button type="button" className="btn" data-testid="next-confirm-cancel" onClick={onCancel}>
            {t(lang, 'btn_cancel')}
          </button>
          <button
            type="button"
            className={`btn ${opts.danger ? 'danger' : 'p'}`}
            data-testid="next-confirm-ok"
            onClick={onConfirm}
          >
            {opts.confirmLabel || t(lang, 'btn_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
