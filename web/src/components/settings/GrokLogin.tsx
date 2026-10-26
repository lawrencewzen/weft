import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelGrokLogin,
  startGrokLogin,
  pollGrokLogin,
  type GrokLoginStart,
  type GrokSession,
} from '../../data/api';
import { copyText } from '../../data/copyText';
import type { Lang } from '../../data/lang';
import { t } from '../../i18n';
import { BrandIcon } from '../BrandIcon';

type Props = {
  lang: Lang;
  onSignedIn: (session: GrokSession) => void;
  onToast: (message: string) => void;
};

export function GrokLogin({ lang, onSignedIn, onToast }: Props) {
  const [pending, setPending] = useState<GrokLoginStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ttlMin, setTtlMin] = useState(10);
  const loginId = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const expireTimer = useRef<number | null>(null);
  const alive = useRef(true);
  const done = useRef(false);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  const clearTimers = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (expireTimer.current) window.clearTimeout(expireTimer.current);
    timer.current = null;
    expireTimer.current = null;
  }, []);

  const openUrl = useCallback((uri: string) => {
    if (!uri) return;
    window.open(uri, '_blank', 'noopener,noreferrer');
  }, []);

  const begin = useCallback(async () => {
    clearTimers();
    setError(null);
    try {
      const started = await startGrokLogin();
      if (!alive.current) return;
      loginId.current = started.loginId;
      setPending(started);
      openUrl(started.verificationUri);
      const remain = Math.max(1, Math.round((started.expiresAt - Date.now()) / 60000));
      setTtlMin(remain);
      const intervalMs = Math.max(1000, (started.interval || 1) * 1000);
      const poll = async () => {
        if (!alive.current || !loginId.current) return;
        try {
          const result = await pollGrokLogin(loginId.current);
          if (!alive.current) return;
          if (result.status === 'done') {
            clearTimers();
            done.current = true;
            onSignedInRef.current(result.grok);
            return;
          }
          timer.current = window.setTimeout(() => { void poll(); }, Math.max(1000, (result.interval || 1) * 1000));
        } catch (err) {
          if (!alive.current) return;
          setError(err instanceof Error ? err.message : String(err));
          timer.current = window.setTimeout(() => { void poll(); }, intervalMs);
        }
      };
      timer.current = window.setTimeout(() => { void poll(); }, intervalMs);
      const until = started.expiresAt - Date.now();
      if (until > 0) {
        expireTimer.current = window.setTimeout(() => { void begin(); }, until + 200);
      }
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [clearTimers, openUrl]);

  useEffect(() => {
    alive.current = true;
    done.current = false;
    void begin();
    return () => {
      alive.current = false;
      clearTimers();
      const id = loginId.current;
      if (id && !done.current) void cancelGrokLogin(id).catch(() => {});
    };
  }, [begin, clearTimers]);

  async function copy(text: string) {
    const ok = await copyText(text);
    onToast(t(lang, ok ? 'copied' : 'err_copy'));
  }

  return (
    <div className="ns-grok">
      <div className="ns-grok-head">
        <span className="ns-icon-box is-lg"><BrandIcon brand="Grok" size={20} /></span>
        <strong>Grok Build</strong>
        <span className="ns-tag is-account">{t(lang, 'provider_access_account')}</span>
      </div>
      <p className="ns-hint" style={{ marginTop: 0 }}>{t(lang, 'grok_login_desc')}</p>
      {error ? <div className="ns-test-card is-bad" data-testid="next-test-result">{error}</div> : null}
      <div className="ns-grok-cards">
        <div className="ns-grok-card">
          <h4>① {t(lang, 'grok_step1')}</h4>
          <p>{t(lang, 'grok_step1_done')}</p>
          <button type="button" className="ns-btn" style={{ marginTop: 10 }} onClick={() => openUrl(pending?.verificationUri || '')}>
            {t(lang, 'grok_reopen')}
          </button>
        </div>
        <div className="ns-grok-card is-on">
          <h4>② {t(lang, 'grok_step2')}</h4>
          <div className="ns-grok-code" data-testid="next-grok-code">{pending?.userCode || '····-····'}</div>
          <button type="button" className="ns-btn" onClick={() => { if (pending?.userCode) void copy(pending.userCode); }}>
            {t(lang, 'copy_code')}
          </button>
          <p style={{ marginTop: 8 }}>{t(lang, 'grok_code_ttl', { n: ttlMin })}</p>
        </div>
        <div className="ns-grok-card">
          <h4>③ {t(lang, 'grok_step3')}</h4>
          <p style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ns-spin" aria-hidden="true" />
            {t(lang, 'grok_waiting')}
          </p>
        </div>
      </div>
      <div className="ns-grok-help">
        <section>
          <h4>{t(lang, 'grok_after')}</h4>
          <p>{t(lang, 'grok_after_account')}</p>
          <p>{t(lang, 'grok_after_token')}</p>
          <p>{t(lang, 'grok_after_models')}</p>
        </section>
        <section>
          <h4>{t(lang, 'grok_trouble')}</h4>
          <button type="button" onClick={() => { if (pending?.verificationUri) void copy(pending.verificationUri); }}>
            {t(lang, 'grok_copy_url')}
          </button>
          <p>{t(lang, 'grok_proxy')}</p>
          <button type="button" onClick={() => { void begin(); }}>{t(lang, 'grok_restart')}</button>
        </section>
      </div>
    </div>
  );
}
