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
      <p className="ns-grok-desc">
        {t(lang, 'grok_login_desc_pre')}{' '}
        <code>grok login --device-auth</code>
        {t(lang, 'grok_login_desc_post')}
      </p>
      {error ? <div className="ns-test-card is-bad" data-testid="next-test-result">{error}</div> : null}
      <div className="ns-grok-cards">
        <div className="ns-grok-card is-done">
          <div className="ns-grok-kicker">
            <span className="ns-step-num is-done-mark" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 12l5 5L20 7" /></svg>
            </span>
            {t(lang, 'grok_step1_kicker')}
          </div>
          <h4>{t(lang, 'grok_step1')}</h4>
          <p>{t(lang, 'grok_step1_done')}</p>
          <button type="button" className="ns-btn" onClick={() => openUrl(pending?.verificationUri || '')}>
            {t(lang, 'grok_reopen')}
          </button>
        </div>
        <div className="ns-grok-card is-on">
          <div className="ns-grok-kicker">
            <span className="ns-step-num">2</span>
            {t(lang, 'grok_step2_kicker')}
          </div>
          <h4>{t(lang, 'grok_step2')}</h4>
          <div className="ns-grok-code-wrap">
            <div className="ns-grok-code" data-testid="next-grok-code">{pending?.userCode || '····-····'}</div>
            <button type="button" className="ns-btn" onClick={() => { if (pending?.userCode) void copy(pending.userCode); }}>
              {t(lang, 'copy_code')}
            </button>
          </div>
          <p className="ns-grok-ttl">{t(lang, 'grok_code_ttl', { n: ttlMin })}</p>
        </div>
        <div className="ns-grok-card">
          <div className="ns-grok-kicker">
            <span className="ns-step-num is-idle">3</span>
            {t(lang, 'grok_step3_kicker')}
          </div>
          <h4>{t(lang, 'grok_step3')}</h4>
          <p className="ns-grok-wait">
            <span className="ns-spin" aria-hidden="true" />
            {t(lang, 'grok_waiting')}
          </p>
          <p className="ns-grok-idle">{t(lang, 'grok_step3_idle')}</p>
        </div>
      </div>
      <div className="ns-grok-help">
        <section className="is-after">
          <h4>{t(lang, 'grok_after')}</h4>
          <div className="ns-grok-meta">
            <span className="ns-grok-meta-k">{t(lang, 'grok_after_account')}</span>
            <span>{t(lang, 'grok_after_account_value')}</span>
            <span className="ns-grok-meta-k">{t(lang, 'grok_after_token')}</span>
            <span>
              <code>{t(lang, 'grok_after_token_path')}</code>
              <span className="ns-grok-meta-note">{t(lang, 'grok_after_token_local')}</span>
            </span>
            <span className="ns-grok-meta-k">{t(lang, 'grok_after_models')}</span>
            <span className="ns-grok-models">
              <span className="ns-grok-chip"><BrandIcon brand="Grok" size={12} />{t(lang, 'grok_after_model_chip')}</span>
              <span className="ns-grok-chip"><BrandIcon brand="Grok" size={12} />{t(lang, 'grok_after_model_chip')}</span>
              <span className="ns-grok-meta-note">{t(lang, 'grok_after_models_hint')}</span>
            </span>
          </div>
        </section>
        <section>
          <h4>{t(lang, 'grok_trouble')}</h4>
          <p>
            {t(lang, 'grok_trouble_url')}{' '}
            <button type="button" className="ns-field-link" onClick={() => { if (pending?.verificationUri) void copy(pending.verificationUri); }}>
              {t(lang, 'grok_copy_url')}
            </button>
          </p>
          <p>{t(lang, 'grok_trouble_proxy')}</p>
          <p>
            {t(lang, 'grok_trouble_restart')}{' '}
            <button type="button" className="ns-field-link" onClick={() => { void begin(); }}>{t(lang, 'grok_restart')}</button>
          </p>
        </section>
      </div>
    </div>
  );
}
