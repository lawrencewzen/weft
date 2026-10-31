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
      <div className="mp-oauth">
        <p>
          <span className="mp-spin" />
          {' '}
          {t(lang, 'dlg_oauth_waiting')}
        </p>
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
  const deviceEvent = session.events?.find(
    (e): e is { type: 'device_code'; userCode: string; verificationUri: string } => e.type === 'device_code',
  );
  const userCode = deviceEvent?.userCode;
  const verificationUri = deviceEvent?.verificationUri;
  const prompt = session.prompt;

  return (
    <div className="mp-oauth">
      {authUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <p>{t(lang, 'dlg_oauth_opened_tip')}</p>
          <button
            type="button"
            className="mp-btn mp-pri"
            data-testid="next-oauth-open"
            onClick={() => window.open(authUrl, '_blank', 'noopener,noreferrer')}
          >
            {t(lang, 'dlg_oauth_btn_open')}
          </button>
        </div>
      )}

      {userCode && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <div className="mp-oauth-code">{userCode}</div>
          <p>{t(lang, 'dlg_oauth_code_tip')}</p>
          {verificationUri && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center' }}>
              <p style={{ margin: 0 }}>{t(lang, 'dlg_oauth_verify_tip')}</p>
              <a
                href={verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="next-oauth-verify-link"
              >
                {verificationUri}
              </a>
            </div>
          )}
        </div>
      )}

      {prompt && (
        <div className="mp-fld" style={{ width: '100%', textAlign: 'left' }}>
          <label>{prompt.message}</label>
          {prompt.type === 'select' ? (
            <select
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
              className="mp-mono"
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
              className="mp-btn mp-pri"
              disabled={submitting || !answerVal.trim()}
              onClick={() => void handleAnswerSubmit()}
            >
              {t(lang, 'dlg_verify_continue')}
            </button>
          </div>
        </div>
      )}

      {(session.state === 'pending' || session.state === 'prompt') && (
        <p>
          <span className="mp-spin" />
          {' '}
          {t(lang, 'dlg_oauth_waiting')}
        </p>
      )}

      {session.state === 'done' && (
        <span className="mp-okline">
          ✓ {t(lang, 'dlg_oauth_signed_in', { account: session.provider?.auth.account || '' })}
        </span>
      )}

      {session.state === 'error' && session.error && (
        <div className="mp-err">{session.error}</div>
      )}

      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
        <button type="button" className="mp-btn" onClick={() => void onCancel()}>
          {t(lang, 'dlg_cancel')}
        </button>
      </div>
    </div>
  );
}
