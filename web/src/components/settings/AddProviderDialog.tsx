import { useEffect, useState } from 'react';
import { BrandIcon } from '../BrandIcon';
import { getProviders } from '../../data/api';
import type { Available, CustomApiProtocol, LoginSession, Model } from '../../data/providerTypes';
import { t, type Lang } from '../../i18n';
import { LoginSessionView } from './LoginSessionView';

export const POPULAR_PROVIDER_IDS = [
  'deepseek', 'anthropic', 'openai', 'google', 'openrouter',
  'moonshotai-cn', 'zai', 'qwen-token-plan-cn', 'minimax-cn', 'xiaomi',
] as const;

type Props = {
  lang: Lang;
  isOpen: boolean;
  onClose: () => void;
  available: readonly Available[];
  loginSession: LoginSession | null;
  onAnswerOAuth: (input: string) => Promise<void>;
  onCancelOAuth: () => Promise<void>;
  onConnectBuiltinKey: (id: string, key: string) => Promise<Model[]>;
  onConnectBuiltinEnv: (id: string) => Promise<Model[]>;
  onStartOAuth: (vendor: Available) => Promise<void>;
  onConnectCustom: (form: { name: string; baseUrl: string; api: CustomApiProtocol; apiKey?: string }) => Promise<Model[]>;
  onFinish: (models: Model[]) => Promise<void>;
};

export function AddProviderDialog({
  lang, isOpen, onClose, available, loginSession,
  onAnswerOAuth, onCancelOAuth, onConnectBuiltinKey, onConnectBuiltinEnv,
  onStartOAuth, onConnectCustom, onFinish,
}: Props) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [search, setSearch] = useState('');
  const [selectedVendor, setSelectedVendor] = useState<Available | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [connectWay, setConnectWay] = useState<'env' | 'api_key' | 'oauth'>('api_key');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [customForm, setCustomForm] = useState({ name: '', baseUrl: '', api: 'openai-completions' as CustomApiProtocol, apiKey: '' });
  const [fetchedModels, setFetchedModels] = useState<Model[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [modelSearch, setModelSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setStep(0); setSearch(''); setSelectedVendor(null);
      setIsCustom(false); setErrorMsg(null); setApiKeyInput('');
      setConnectWay('api_key');
      setFetchedModels([]); setSelectedModelIds(new Set());
    }
  }, [isOpen]);

  useEffect(() => {
    if (loginSession?.state === 'done' && step === 1 && !isCustom && selectedVendor?.id === loginSession.providerId) {
      void (async () => {
        try {
          const res = await getProviders(lang);
          const p = res.providers.find((row) => row.id === loginSession.providerId);
          if (p) {
            setFetchedModels(p.models);
            setSelectedModelIds(p.models.length > 6 ? new Set() : new Set(p.models.map((m) => m.id)));
            setStep(2);
          }
        } catch { /* ignore */ }
      })();
    }
  }, [loginSession, step, lang, isCustom, selectedVendor]);

  if (!isOpen) return null;

  const popularSet = new Set<string>(POPULAR_PROVIDER_IDS);
  const popularList: Available[] = POPULAR_PROVIDER_IDS.map(
    (id) => available.find((a) => a.id === id) || {
      id,
      name: id,
      authMethods: ['api_key'],
      modelCount: 0,
      popular: true,
      envDetected: false,
      connected: false,
    },
  );
  const allOtherList = available
    .filter((a) => !popularSet.has(a.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  const filterCards = (list: Available[]) => {
    if (!search.trim()) return list;
    const q = search.trim().toLowerCase();
    return list.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
  };

  const handleSelectVendor = (vendor: Available) => {
    if (vendor.connected) return;
    setSelectedVendor(vendor);
    setIsCustom(false);
    setErrorMsg(null);
    setApiKeyInput('');
    if (vendor.envDetected) setConnectWay('env');
    else if (vendor.authMethods.includes('api_key')) setConnectWay('api_key');
    else {
      setConnectWay('oauth');
      void onStartOAuth(vendor);
    }
    setStep(1);
  };

  const handleSelectCustom = () => {
    setSelectedVendor(null);
    setIsCustom(true);
    setErrorMsg(null);
    setConnectWay('api_key');
    setCustomForm({ name: '', baseUrl: '', api: 'openai-completions', apiKey: '' });
    setStep(1);
  };

  const handleStep1Submit = async () => {
    setErrorMsg(null);
    setLoading(true);
    try {
      let models: Model[] = [];
      if (isCustom) {
        if (!customForm.name.trim() || !customForm.baseUrl.trim()) {
          setErrorMsg(t(lang, 'form_fill_required'));
          return;
        }
        models = await onConnectCustom(customForm);
      } else if (selectedVendor) {
        if (connectWay === 'env') {
          models = await onConnectBuiltinEnv(selectedVendor.id);
        } else if (connectWay === 'api_key') {
          if (!apiKeyInput.trim()) {
            setErrorMsg(t(lang, 'form_fill_required'));
            return;
          }
          models = await onConnectBuiltinKey(selectedVendor.id, apiKeyInput.trim());
        }
      }
      setFetchedModels(models);
      setSelectedModelIds(models.length > 6 ? new Set() : new Set(models.map((m) => m.id)));
      setStep(2);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleFinishSubmit = async () => {
    if (selectedModelIds.size === 0) return;
    setLoading(true);
    try {
      await onFinish(fetchedModels.map((m) => ({ ...m, enabled: selectedModelIds.has(m.id) })));
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const renderCard = (p: Available) => (
    <div key={p.id} className={`vcard ${p.connected ? 'dis' : ''}`} data-testid="next-vendor-card" data-vendor={p.id} onClick={() => handleSelectVendor(p)}>
      <div className="av"><BrandIcon brand={p.brand || p.id} size={18} /></div>
      <div className="inf">
        <b>{p.name}</b>
        <span>
          {p.authMethods.includes('api_key') && p.authMethods.includes('oauth') ? t(lang, 'dlg_add_ways_both') : t(lang, 'dlg_add_ways_key_only')}
          {' · '}{t(lang, 'dlg_add_models_count', { count: p.modelCount })}
        </span>
      </div>
      {p.connected && <span className="tag">{t(lang, 'dlg_add_already_connected')}</span>}
      {!p.connected && p.envDetected && <span className="tag ok">{t(lang, 'dlg_add_env_detected')}</span>}
    </div>
  );

  return (
    <div className="mask">
      <div className="dlg" data-testid="next-add-dialog">
        <div className="dh">
          <b>{t(lang, 'dlg_add_provider_title')}</b>
          <div className="steps">
            <i className={step >= 0 ? 'on' : ''} />
            <i className={step >= 1 ? 'on' : ''} />
            <i className={step >= 2 ? 'on' : ''} />
          </div>
          <button type="button" className="x" onClick={onClose}>×</button>
        </div>

        <div className="db">
          {errorMsg && <div className="err">{errorMsg}</div>}

          {step === 0 && (
            <>
              <input
                className="search"
                data-testid="next-add-search"
                placeholder={t(lang, 'dlg_add_search_placeholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="grp">{t(lang, 'dlg_add_grp_popular')}</div>
              <div className="vgrid">{filterCards(popularList).map(renderCard)}</div>
              <div className="grp">{t(lang, 'dlg_add_grp_all')}</div>
              <div className="vgrid">{filterCards(allOtherList).map(renderCard)}</div>
              <div className="grp">{t(lang, 'dlg_add_grp_other')}</div>
              <div
                className="vcard custom"
                data-testid="next-vendor-card"
                data-vendor="custom"
                onClick={handleSelectCustom}
              >
                <div className="av">＋</div>
                <div className="inf">
                  <b>{t(lang, 'dlg_add_custom_title')}</b>
                  <span>{t(lang, 'dlg_add_custom_desc')}</span>
                </div>
              </div>
            </>
          )}

          {step === 1 && isCustom && (
            <div className="form">
              <label className="lbl">{t(lang, 'dlg_custom_name_label')}</label>
              <input className="inp" data-testid="next-custom-name" value={customForm.name} placeholder={t(lang, 'dlg_custom_name_placeholder')} onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })} />
              <label className="lbl">{t(lang, 'dlg_custom_url_label')}</label>
              <input className="inp" data-testid="next-custom-url" value={customForm.baseUrl} placeholder={t(lang, 'dlg_custom_url_placeholder')} onChange={(e) => setCustomForm({ ...customForm, baseUrl: e.target.value })} />
              <label className="lbl">{t(lang, 'dlg_custom_proto_label')}</label>
              <select className="inp" data-testid="next-custom-api" value={customForm.api} onChange={(e) => setCustomForm({ ...customForm, api: e.target.value as CustomApiProtocol })}>
                <option value="openai-completions">{t(lang, 'dlg_custom_proto_openai')}</option>
                <option value="openai-responses">{t(lang, 'dlg_custom_proto_responses')}</option>
                <option value="anthropic-messages">{t(lang, 'dlg_custom_proto_anthropic')}</option>
              </select>
              <label className="lbl">{t(lang, 'dlg_key_label')}</label>
              <input type="password" className="inp" data-testid="next-custom-key" value={customForm.apiKey} placeholder="sk-..." onChange={(e) => setCustomForm({ ...customForm, apiKey: e.target.value })} />
            </div>
          )}

          {step === 1 && !isCustom && selectedVendor && (
            <div>
              <div className="tabs seg">
                {selectedVendor.envDetected && (
                  <button type="button" className={`tab ${connectWay === 'env' ? 'on' : ''}`} onClick={() => setConnectWay('env')}>
                    {t(lang, 'dlg_tab_env')}
                  </button>
                )}
                {selectedVendor.authMethods.includes('api_key') && (
                  <button type="button" className={`tab ${connectWay === 'api_key' ? 'on' : ''}`} onClick={() => setConnectWay('api_key')}>
                    {t(lang, 'dlg_tab_api_key')}
                  </button>
                )}
                {selectedVendor.authMethods.includes('oauth') && (
                  <button type="button" className={`tab ${connectWay === 'oauth' ? 'on' : ''}`} onClick={() => { setConnectWay('oauth'); void onStartOAuth(selectedVendor); }}>
                    {t(lang, 'dlg_tab_oauth')}
                  </button>
                )}
              </div>

              {connectWay === 'env' && (
                <div style={{ padding: '16px 0', fontSize: 13, color: 'var(--mute)' }}>
                  {t(lang, 'dlg_env_note', { env: selectedVendor.envVar || 'API_KEY' })}
                </div>
              )}
              {connectWay === 'api_key' && (
                <div className="form">
                  <label className="lbl">{t(lang, 'dlg_key_label')}</label>
                  <input
                    type="password"
                    className="inp"
                    data-testid="next-key-input"
                    value={apiKeyInput}
                    placeholder={t(lang, 'dlg_key_placeholder')}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                  />
                  <span style={{ fontSize: 12, color: 'var(--faint)' }}>{t(lang, 'dlg_key_hint')}</span>
                </div>
              )}
              {connectWay === 'oauth' && (
                <LoginSessionView
                  session={loginSession}
                  lang={lang}
                  onAnswer={onAnswerOAuth}
                  onCancel={onCancelOAuth}
                />
              )}
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="conn-ok">
                ✓ {t(lang, 'dlg_connected_models_found', { count: fetchedModels.length })}
              </div>
              {fetchedModels.length > 8 && (
                <input
                  className="search"
                  data-testid="next-model-pick-search"
                  placeholder={t(lang, 'dlg_add_search_placeholder')}
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                />
              )}
              <div className="mgrid pickm">
                {fetchedModels
                  .filter(
                    (m) =>
                      !modelSearch.trim() ||
                      m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
                      m.id.toLowerCase().includes(modelSearch.toLowerCase()),
                  )
                  .map((m) => {
                    const checked = selectedModelIds.has(m.id);
                    return (
                      <div
                        key={m.id}
                        className="mrow"
                        data-testid="next-model-pick-row"
                        onClick={() => {
                          const next = new Set(selectedModelIds);
                          if (checked) next.delete(m.id);
                          else next.add(m.id);
                          setSelectedModelIds(next);
                        }}
                      >
                        <input type="checkbox" checked={checked} onChange={() => {}} />
                        <div className="minf">
                          <span className="mnm">{m.name}</span>
                          {m.name !== m.id && <span className="mid">{m.id}</span>}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>

        <div className="df">
          {step > 0 && (
            <button
              type="button"
              className="btn"
              data-testid="next-add-back"
              disabled={loading}
              onClick={() => setStep((s) => (s - 1) as 0 | 1)}
            >
              {t(lang, 'dlg_back')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose} disabled={loading}>
            {t(lang, 'dlg_cancel')}
          </button>
          {step === 1 && (isCustom || connectWay !== 'oauth') && (
            <button
              type="button"
              className="btn pri"
              data-testid="next-add-next"
              disabled={loading}
              onClick={() => void handleStep1Submit()}
            >
              {loading ? t(lang, 'provider_status_run') : t(lang, 'dlg_connect_fetch')}
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              className="btn pri"
              data-testid="next-provider-finish"
              disabled={loading || selectedModelIds.size === 0}
              onClick={() => void handleFinishSubmit()}
            >
              {loading ? t(lang, 'provider_status_run') : t(lang, 'dlg_finish')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
