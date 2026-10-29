import { useEffect, useState } from 'react';
import { BrandIcon } from '../BrandIcon';
import { getProviders } from '../../data/api';
import { providerBrand } from '../../data/providerBrand';
import type { Available, CustomApiProtocol, LoginSession, Model } from '../../data/providerTypes';
import { t, type Lang } from '../../i18n';
import { LoginSessionView } from './LoginSessionView';
import { ModelPickStep } from './ModelPickStep';

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

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

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

  const renderCard = (p: Available) => {
    const isDis = p.connected;
    const ways =
      p.authMethods.includes('api_key') && p.authMethods.includes('oauth')
        ? t(lang, 'dlg_add_ways_both')
        : t(lang, 'dlg_add_ways_key_only');
    const brand = p.brand || providerBrand(p.id);

    return (
      <div
        key={p.id}
        className={`mp-vi ${isDis ? 'mp-dis' : ''}`}
        data-testid="next-vendor-card"
        data-vendor={p.id}
        onClick={() => !isDis && handleSelectVendor(p)}
      >
        <div className="mp-av">
          <BrandIcon brand={brand} size={18} />
        </div>
        <div className="mp-vi-t">
          <span>{p.name}</span>
          <span>
            {isDis
              ? t(lang, 'dlg_add_already_connected')
              : `${ways} · ${t(lang, 'dlg_add_models_count', { count: p.modelCount })}`}
          </span>
        </div>
        {!isDis && p.envDetected && (
          <span className="mp-vi-env">{t(lang, 'dlg_add_env_detected')}</span>
        )}
      </div>
    );
  };

  return (
    <div className="mp-mask">
      <div className="mp-dlg" data-testid="next-add-dialog">
        <div className="mp-dh">
          <b>{t(lang, 'dlg_add_provider_title')}</b>
          <div className="mp-steps">
            <i className={step >= 0 ? 'mp-on' : ''} />
            <i className={step >= 1 ? 'mp-on' : ''} />
            <i className={step >= 2 ? 'mp-on' : ''} />
          </div>
          <button type="button" className="mp-x" onClick={onClose}>×</button>
        </div>

        <div className="mp-db">
          {errorMsg && <div className="mp-err" data-testid="next-test-result">{errorMsg}</div>}

          {step === 0 && (
            <>
              <input
                className="mp-search"
                data-testid="next-add-search"
                placeholder={t(lang, 'dlg_add_search_placeholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="mp-grp">{t(lang, 'dlg_add_grp_popular')}</div>
              <div className="mp-vgrid">{filterCards(popularList).map(renderCard)}</div>
              <div className="mp-grp">{t(lang, 'dlg_add_grp_all')}</div>
              <div className="mp-vgrid">{filterCards(allOtherList).map(renderCard)}</div>
              <div className="mp-grp">{t(lang, 'dlg_add_grp_other')}</div>
              <div className="mp-vgrid">
                <div
                  className="mp-vi mp-custom"
                  data-testid="next-vendor-card"
                  data-vendor="custom"
                  onClick={handleSelectCustom}
                >
                  <div className="mp-av">
                    <BrandIcon brand={null} size={18} />
                  </div>
                  <div className="mp-vi-t">
                    <span>{t(lang, 'dlg_add_custom_title')}</span>
                    <span>{t(lang, 'dlg_add_custom_desc')}</span>
                  </div>
                </div>
              </div>
            </>
          )}

          {step === 1 && isCustom && (
            <>
              <div className="mp-fld">
                <label>{t(lang, 'dlg_custom_name_label')}</label>
                <input
                  data-testid="next-custom-name"
                  value={customForm.name}
                  placeholder={t(lang, 'dlg_custom_name_placeholder')}
                  onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
                />
              </div>
              <div className="mp-fld">
                <label>{t(lang, 'dlg_custom_url_label')}</label>
                <input
                  className="mp-mono"
                  data-testid="next-custom-url"
                  value={customForm.baseUrl}
                  placeholder={t(lang, 'dlg_custom_url_placeholder')}
                  onChange={(e) => setCustomForm({ ...customForm, baseUrl: e.target.value })}
                />
              </div>
              <div className="mp-fld">
                <label>{t(lang, 'dlg_custom_proto_label')}</label>
                <select
                  data-testid="next-custom-api"
                  value={customForm.api}
                  onChange={(e) => setCustomForm({ ...customForm, api: e.target.value as CustomApiProtocol })}
                >
                  <option value="openai-completions">{t(lang, 'dlg_custom_proto_openai')}</option>
                  <option value="openai-responses">{t(lang, 'dlg_custom_proto_responses')}</option>
                  <option value="anthropic-messages">{t(lang, 'dlg_custom_proto_anthropic')}</option>
                </select>
              </div>
              <div className="mp-fld">
                <label>
                  {t(lang, 'dlg_key_label')}{' '}
                  <span style={{ color: 'var(--faint)', fontWeight: 400 }}>
                    {t(lang, 'dlg_custom_key_optional')}
                  </span>
                </label>
                <input
                  type="password"
                  className="mp-mono"
                  data-testid="next-custom-key"
                  value={customForm.apiKey}
                  placeholder="sk-..."
                  onChange={(e) => setCustomForm({ ...customForm, apiKey: e.target.value })}
                />
                <small>{t(lang, 'dlg_custom_key_placeholder')}</small>
              </div>
            </>
          )}

          {step === 1 && !isCustom && selectedVendor && (
            <div>
              <div className="mp-seg">
                {selectedVendor.envDetected && (
                  <button
                    type="button"
                    className={connectWay === 'env' ? 'mp-on' : ''}
                    onClick={() => setConnectWay('env')}
                  >
                    {t(lang, 'dlg_tab_env')}
                  </button>
                )}
                {selectedVendor.authMethods.includes('api_key') && (
                  <button
                    type="button"
                    className={connectWay === 'api_key' ? 'mp-on' : ''}
                    onClick={() => setConnectWay('api_key')}
                  >
                    {t(lang, 'dlg_tab_api_key')}
                  </button>
                )}
                {selectedVendor.authMethods.includes('oauth') && (
                  <button
                    type="button"
                    className={connectWay === 'oauth' ? 'mp-on' : ''}
                    onClick={() => {
                      setConnectWay('oauth');
                      void onStartOAuth(selectedVendor);
                    }}
                  >
                    {t(lang, 'dlg_tab_oauth')}
                  </button>
                )}
              </div>

              {connectWay === 'env' && (
                <div className="mp-envbox">
                  <span>✓</span>
                  <span>{t(lang, 'dlg_env_note', { env: selectedVendor.envVar || 'API_KEY' })}</span>
                </div>
              )}
              {connectWay === 'api_key' && (
                <div className="mp-fld">
                  <label>{t(lang, 'dlg_key_label')}</label>
                  <input
                    type="password"
                    className="mp-mono"
                    data-testid="next-key-input"
                    value={apiKeyInput}
                    placeholder={t(lang, 'dlg_key_placeholder')}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                  />
                  <small>{t(lang, 'dlg_key_hint')}</small>
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
            <ModelPickStep
              lang={lang}
              models={fetchedModels}
              selectedIds={selectedModelIds}
              onToggle={(id, checked) => {
                const next = new Set(selectedModelIds);
                if (checked) next.add(id);
                else next.delete(id);
                setSelectedModelIds(next);
              }}
            />
          )}
        </div>

        <div className="mp-df">
          {step > 0 && (
            <button
              type="button"
              className="mp-btn"
              data-testid="next-add-back"
              disabled={loading}
              onClick={() => setStep((s) => (s - 1) as 0 | 1)}
            >
              {t(lang, 'dlg_back')}
            </button>
          )}
          <span className="mp-sp" />
          <button type="button" className="mp-btn" onClick={onClose} disabled={loading}>
            {t(lang, 'dlg_cancel')}
          </button>
          {step === 1 && (isCustom || connectWay !== 'oauth') && (
            <button
              type="button"
              className="mp-btn mp-pri"
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
              className="mp-btn mp-pri"
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
