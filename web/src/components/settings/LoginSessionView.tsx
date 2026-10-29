import { useState } from 'react';
import type { LoginSession } from '../../data/providerTypes';
import { t, type Lang } from '../../i18n';

type Props = {
  session: LoginSession | null;
  lang: Lang;
  onAnswer: (input: string) => Promise<void>;
  onCancel: () => Promise<void>;
};

export function LoginSessionView({ session, lang, onAnswer, onCancel }: Props) {
  const [answerVal, setAnswerVal] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!session) {
    return (
      <div className="oauth-box oauth">
        <span className="oauth-wait">
          <i className="oauth-dot pulse" />
          {t(lang, 'dlg_oauth_waiting')}
        </span>
      </div>
    );
  }

  const handleAnswerSubmit = async () => {
    if (!answerVal.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onAnswer(answerVal.trim());
      setAnswerVal('');
    } finally {
      setSubmitting(false);
    }
  };

  const authUrl = session.events?.find((e): e is { type: 'auth_url'; url: string; instructions?: string } => e.type === 'auth_url')?.url;
  const userCode = session.events?.find((e): e is { type: 'device_code'; userCode: string; verificationUri: string } => e.type === 'device_code')?.userCode;
  const prompt = session.prompt;

  return (
    <div className="oauth-box oauth">
      {authUrl && (
        <div className="oauth-url-section">
          <button
            type="button"
            className="btn pri"
            data-testid="next-oauth-open"
            onClick={() => window.open(authUrl, '_blank', 'noopener,noreferrer')}
          >
            {t(lang, 'dlg_oauth_btn_open')}
          </button>
          <div className="oauth-tip">{t(lang, 'dlg_oauth_opened_tip')}</div>
        </div>
      )}

      {userCode && (
        <div className="oauth-code-block">
          <div className="oauth-code-val">{userCode}</div>
          <div className="oauth-code-tip">{t(lang, 'dlg_oauth_code_tip')}</div>
        </div>
      )}

      {prompt && (
        <div className="oauth-prompt">
          <label className="lbl">{prompt.message}</label>
          {prompt.type === 'select' ? (
            <select
              className="inp"
              value={answerVal}
              onChange={(e) => setAnswerVal(e.target.value)}
            >
              <option value="">--</option>
              {prompt.options?.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={prompt.type === 'secret' ? 'password' : 'text'}
              className="inp"
              value={answerVal}
              placeholder={prompt.placeholder || ''}
              onChange={(e) => setAnswerVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAnswerSubmit();
              }}
            />
          )}
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn pri"
              disabled={submitting || !answerVal.trim()}
              onClick={() => void handleAnswerSubmit()}
            >
              {t(lang, 'dlg_verify_continue')}
            </button>
          </div>
        </div>
      )}

      {(session.state === 'pending' || session.state === 'prompt') && (
        <div className="oauth-wait">
          <i className="oauth-dot pulse" />
          <span>{t(lang, 'dlg_oauth_waiting')}</span>
        </div>
      )}

      {session.state === 'done' && (
        <div className="oauth-done">
          ✓ {t(lang, 'dlg_oauth_signed_in', { account: session.provider?.auth.account || '' })}
        </div>
      )}

      {session.state === 'error' && session.error && (
        <div className="err">{session.error}</div>
      )}

      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={() => void onCancel()}>
          {t(lang, 'dlg_cancel')}
        </button>
      </div>
    </div>
  );
}
