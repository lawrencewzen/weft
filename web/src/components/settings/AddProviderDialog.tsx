import { useEffect, useRef, useState } from 'react';
import { BrandIcon } from '../BrandIcon';
import { providerBrand } from '../../data/providerBrand';
import { formatNumber } from '../../data/providerFormat';
import type {
  Available,
  CustomApiProtocol,
  LoginSession,
  Model,
  Provider,
} from '../../data/providerTypes';
import { t, type Lang } from '../../i18n';
import { LoginSessionView } from './LoginSessionView';

export const ACP_CATALOG = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    subtitleKey: 'dlg_add_acp_claude_sub' as const,
    brand: 'anthropic',
    pathPlaceholder: '/path/to/claude',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    subtitleKey: 'dlg_add_acp_agy_sub' as const,
    brand: 'google',
    pathPlaceholder: '/path/to/agy',
  },
] as const;

type ConnectBody =
  | { method: 'api_key'; apiKey: string }
  | { method: 'env' }
  | { method: 'local_login' };

type LeftKind = 'vendor' | 'custom' | 'acp';

type LeftItem = {
  kind: LeftKind;
  id: string;
  name: string;
  brand: string | null;
  connected: boolean;
  vendor?: Available;
  acp?: (typeof ACP_CATALOG)[number];
};

type Props = {
  lang: Lang;
  isOpen: boolean;
  onClose: () => void;
  available: readonly Available[];
  loginSession: LoginSession | null;
  onAnswerOAuth: (input: string) => Promise<void>;
  onCancelOAuth: () => Promise<void>;
  onStartOAuth: (vendor: Available) => Promise<void>;
  onConnect: (id: string, body: ConnectBody) => Promise<Provider>;
  onConnectCustom: (form: {
    name: string;
    baseUrl: string;
    api: CustomApiProtocol;
    apiKey?: string;
  }) => Promise<Provider>;
  onCreate: (id: string, patch: { name: string; enabled: string[]; defaultModel: string }) => Promise<void>;
  onRollback: (ids: string[]) => Promise<void>;
};

const CHECK_SVG = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="10" cy="10" r="7.5" />
    <path d="M6.5 10.2l2.4 2.3 4.6-4.8" />
  </svg>
);

const DASH_SVG = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="10" cy="10" r="7.5" strokeDasharray="2.5 2.5" />
  </svg>
);

const CHEV_SVG = (
  <svg className="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4" />
  </svg>
);

function subtitleOf(item: LeftItem, lang: Lang): string {
  if (item.kind === 'acp' && item.acp) return t(lang, item.acp.subtitleKey);
  if (item.kind === 'custom') return t(lang, 'dlg_add_subtitle_custom');
  if (item.id === 'xai') return t(lang, 'dlg_add_subtitle_grok');
  return t(lang, 'dlg_add_subtitle_api', { name: item.name });
}

export function AddProviderDialog({
  lang,
  isOpen,
  onClose,
  available,
  loginSession,
  onAnswerOAuth,
  onCancelOAuth,
  onStartOAuth,
  onConnect,
  onConnectCustom,
  onCreate,
  onRollback,
}: Props) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string>('xai');
  const [configName, setConfigName] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [chosenId, setChosenId] = useState('');
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [ddOpen, setDdOpen] = useState(false);
  const [acpFoldOpen, setAcpFoldOpen] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const leftoverRef = useRef<Set<string>>(new Set());
  const autoKeyRef = useRef<string>('');
  const selectedIdRef = useRef(selectedId);
  const isOpenRef = useRef(isOpen);
  const ddRef = useRef<HTMLDivElement | null>(null);
  const closingRef = useRef(false);
  const onConnectRef = useRef(onConnect);
  const onRollbackRef = useRef(onRollback);
  const onCloseRef = useRef(onClose);
  onConnectRef.current = onConnect;
  onRollbackRef.current = onRollback;
  onCloseRef.current = onClose;
  selectedIdRef.current = selectedId;
  isOpenRef.current = isOpen;

  const grokVendor = available.find((item) => item.id === 'xai') || null;
  const apiVendors = available.filter((item) => item.id !== 'xai');

  const leftItems: LeftItem[] = [
    ...(grokVendor
      ? [{
          kind: 'vendor' as const,
          id: grokVendor.id,
          name: grokVendor.name,
          brand: grokVendor.brand || providerBrand(grokVendor.id),
          connected: grokVendor.connected && !sessionIds.includes(grokVendor.id),
          vendor: grokVendor,
        }]
      : []),
    ...apiVendors.map((vendor) => ({
      kind: 'vendor' as const,
      id: vendor.id,
      name: vendor.name,
      brand: vendor.brand || providerBrand(vendor.id),
      connected: vendor.connected && !sessionIds.includes(vendor.id),
      vendor,
    })),
    {
      kind: 'custom',
      id: 'custom',
      name: t(lang, 'dlg_add_custom_title'),
      brand: null,
      connected: false,
    },
    ...ACP_CATALOG.map((acp) => ({
      kind: 'acp' as const,
      id: acp.id,
      name: acp.name,
      brand: acp.brand,
      connected: false,
      acp,
    })),
  ];

  const selected = leftItems.find((item) => item.id === selectedId) || leftItems[0] || null;
  const vendor = selected?.kind === 'vendor' ? selected.vendor : undefined;
  const alreadyConnected = Boolean(vendor?.connected && !sessionIds.includes(vendor.id));
  const grokDetected = Boolean(vendor?.id === 'xai' && vendor.localLogin?.detected);
  const envDetected = Boolean(vendor?.envDetected);
  const isReady = Boolean(connectedId && models.length > 0 && !alreadyConnected);
  const isAcp = selected?.kind === 'acp';
  const isCustom = selected?.kind === 'custom';
  const isGrok = vendor?.id === 'xai';

  useEffect(() => {
    if (!isOpen) return;
    leftoverRef.current = new Set();
    autoKeyRef.current = '';
    closingRef.current = false;
    setSessionIds([]);
    setSearch('');
    setSelectedId('xai');
    setConfigName('');
    setApiKeyInput('');
    setCustomUrl('');
    setCustomKey('');
    setModels([]);
    setChosenId('');
    setConnectedId(null);
    setDdOpen(false);
    setAcpFoldOpen(false);
    setOauthOpen(false);
    setLoading(false);
    setErrorMsg(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (selectedId === 'custom' || selectedId === 'claude-code' || selectedId === 'antigravity') return;
    const hit = available.find((item) => item.id === selectedId);
    if (hit) setConfigName(hit.name);
  }, [isOpen, selectedId, available]);

  useEffect(() => {
    if (!isOpen) return;
    const hit = available.find((item) => item.id === selectedId);
    if (!hit || hit.connected) return;
    const key = hit.id === 'xai'
      ? (hit.localLogin?.detected ? `local:${hit.id}` : '')
      : (hit.envDetected ? `env:${hit.id}` : '');
    if (!key || autoKeyRef.current === key) return;
    const id = hit.id;
    const body: ConnectBody = hit.id === 'xai' ? { method: 'local_login' } : { method: 'env' };
    setLoading(true);
    setErrorMsg(null);
    void Promise.resolve(onConnectRef.current(id, body)).then((provider) => {
      if (!provider) return;
      if (!isOpenRef.current || closingRef.current) {
        void onRollbackRef.current([provider.id]);
        return;
      }
      leftoverRef.current.add(provider.id);
      setSessionIds([...leftoverRef.current]);
      if (selectedIdRef.current !== id) return;
      autoKeyRef.current = key;
      setConnectedId(provider.id);
      setModels(provider.models);
      setChosenId((prev) => prev || provider.models[0]?.id || '');
      setErrorMsg(null);
    }).catch((err: unknown) => {
      if (selectedIdRef.current !== id) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setConnectedId(null);
      setModels([]);
    }).finally(() => {
      if (selectedIdRef.current === id) setLoading(false);
    });
  }, [isOpen, selectedId, available]);

  useEffect(() => {
    if (loginSession?.state === 'done' && loginSession.provider && selectedId === loginSession.providerId) {
      leftoverRef.current.add(loginSession.provider.id);
      setSessionIds([...leftoverRef.current]);
      setConnectedId(loginSession.provider.id);
      setModels(loginSession.provider.models);
      setChosenId((prev) => prev || loginSession.provider?.models[0]?.id || '');
      setErrorMsg(null);
      setOauthOpen(false);
    }
  }, [loginSession, selectedId]);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (ddOpen) {
        setDdOpen(false);
        return;
      }
      if (closingRef.current) return;
      closingRef.current = true;
      const ids = [...leftoverRef.current];
      leftoverRef.current = new Set();
      void (async () => {
        try { if (ids.length) await onRollbackRef.current(ids); } catch { /* still close */ }
        onCloseRef.current();
      })();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, ddOpen]);

  useEffect(() => {
    if (!ddOpen) return;
    function onDown(e: MouseEvent) {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setDdOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [ddOpen]);

  if (!isOpen || !selected) return null;

  function remember(provider: Provider) {
    if (!isOpenRef.current || closingRef.current) {
      void onRollbackRef.current([provider.id]);
      return;
    }
    leftoverRef.current.add(provider.id);
    setSessionIds([...leftoverRef.current]);
    setConnectedId(provider.id);
    setModels(provider.models);
    setChosenId((prev) => prev || provider.models[0]?.id || '');
    setErrorMsg(null);
  }

  async function runConnect(body: ConnectBody) {
    if (!vendor || alreadyConnected) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const provider = await onConnect(vendor.id, body);
      remember(provider);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setConnectedId(null);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }

  async function runCustomConnect() {
    const name = configName.trim() || t(lang, 'dlg_add_custom_title');
    if (!customUrl.trim()) {
      setErrorMsg(t(lang, 'form_fill_required'));
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const provider = await onConnectCustom({
        name,
        baseUrl: customUrl.trim(),
        api: 'openai-completions',
        ...(customKey.trim() ? { apiKey: customKey.trim() } : {}),
      });
      remember(provider);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setConnectedId(null);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleTest() {
    if (isAcp || alreadyConnected) return;
    if (isCustom) {
      await runCustomConnect();
      return;
    }
    if (!vendor) return;
    if (vendor.id === 'xai') {
      if (vendor.localLogin?.detected) await runConnect({ method: 'local_login' });
      else {
        setOauthOpen(true);
        await onStartOAuth(vendor);
      }
      return;
    }
    if (apiKeyInput.trim()) await runConnect({ method: 'api_key', apiKey: apiKeyInput.trim() });
    else if (vendor.envDetected) await runConnect({ method: 'env' });
    else setErrorMsg(t(lang, 'form_fill_required'));
  }

  async function handleKeyBlur() {
    if (alreadyConnected || loading || isAcp) return;
    if (isCustom) {
      if (customUrl.trim() && (customKey.trim() || configName.trim())) await runCustomConnect();
      return;
    }
    if (vendor && apiKeyInput.trim()) {
      await runConnect({ method: 'api_key', apiKey: apiKeyInput.trim() });
    }
  }

  async function handleCancel() {
    if (closingRef.current) return;
    closingRef.current = true;
    const ids = [...leftoverRef.current];
    leftoverRef.current = new Set();
    try {
      if (ids.length) await onRollback(ids);
    } catch { /* still close */ }
    onClose();
  }

  async function handleCreate() {
    if (!isReady || !connectedId) return;
    const defaultModel = chosenId || models[0]?.id;
    if (!defaultModel) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      leftoverRef.current.delete(connectedId);
      const leftover = [...leftoverRef.current];
      leftoverRef.current = new Set();
      await onCreate(connectedId, {
        name: (configName.trim() || selected.name).slice(0, 80),
        enabled: models.map((item) => item.id),
        defaultModel,
      });
      if (leftover.length) await onRollback(leftover);
      onClose();
    } catch (err) {
      leftoverRef.current.add(connectedId);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleSelect(item: LeftItem) {
    setSelectedId(item.id);
    setErrorMsg(null);
    setDdOpen(false);
    setOauthOpen(false);
    setApiKeyInput('');
    setLoading(false);
    if (item.id !== connectedId) {
      setModels([]);
      setChosenId('');
      setConnectedId(null);
      autoKeyRef.current = '';
    }
  }

  const q = search.trim().toLowerCase();
  const match = (item: LeftItem) => !q || item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
  const builtinList = leftItems.filter((item) => item.kind === 'vendor' && item.id === 'xai').filter(match);
  const apiList = leftItems.filter((item) => (item.kind === 'vendor' && item.id !== 'xai') || item.kind === 'custom').filter(match);
  const acpList = leftItems.filter((item) => item.kind === 'acp').filter(match);

  const chosen = models.find((item) => item.id === chosenId) || models[0];
  const grokAccount = vendor?.localLogin?.account || '';

  function renderGroup(label: string, items: LeftItem[]) {
    if (!items.length) return null;
    return (
      <>
        <div className="mp-add-grp">{label}</div>
        {items.map((item) => (
          <div
            key={item.id}
            className={`mp-add-it${item.id === selected.id ? ' on' : ''}${item.connected ? ' dis' : ''}`}
            data-testid="next-vendor-card"
            data-vendor={item.id}
            onClick={() => handleSelect(item)}
          >
            <span className="mp-av">
              <BrandIcon brand={item.brand} size={14} />
            </span>
            <span className="mp-add-n">{item.name}</span>
            {item.connected
              ? <span className="mp-add-s">{t(lang, 'dlg_add_already_connected')}</span>
              : item.id === selected.id ? <span className="mp-add-ck">✓</span> : null}
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="mp-mask mp-mask-add">
      <div className="mp-dlg mp-dlg-add" data-testid="next-add-dialog">
        <div className="mp-add-left">
          <input
            className="mp-add-search"
            data-testid="next-add-search"
            placeholder={t(lang, 'dlg_add_search_placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="mp-add-list">
            {renderGroup(t(lang, 'dlg_add_grp_builtin'), builtinList)}
            {renderGroup(t(lang, 'dlg_add_grp_apikey'), apiList)}
            {renderGroup(t(lang, 'dlg_add_grp_acp'), acpList)}
          </div>
        </div>
        <div className="mp-add-right">
          <div className="mp-add-head">
            <span className="mp-av mp-add-logo">
              <BrandIcon brand={selected.brand} size={18} />
            </span>
            <div>
              <b>{t(lang, 'dlg_add_provider_title')}</b>
              <small>{subtitleOf(selected, lang)}</small>
            </div>
            <span className="mp-add-sp">
              <button
                type="button"
                className="mp-btn"
                data-testid="next-add-test"
                disabled={loading || isAcp || alreadyConnected}
                onClick={() => void handleTest()}
              >
                {loading ? t(lang, 'provider_status_run') : t(lang, 'provider_btn_test')}
              </button>
              <button type="button" className="mp-x" data-testid="next-add-close" onClick={() => void handleCancel()}>×</button>
            </span>
          </div>

          <div className="mp-add-form">
            <div className="mp-add-f">
              <label>{t(lang, 'dlg_add_config_name')}</label>
              <div className="mp-add-in">
                <input
                  data-testid={isCustom ? 'next-custom-name' : 'next-config-name'}
                  value={configName}
                  placeholder={t(lang, 'dlg_add_config_placeholder')}
                  disabled={alreadyConnected}
                  onChange={(e) => setConfigName(e.target.value)}
                />
              </div>
            </div>

            {alreadyConnected && (
              <div className="mp-add-sub">{t(lang, 'dlg_add_already_connected')}</div>
            )}

            {!alreadyConnected && isGrok && (
              <div className="mp-add-f">
                <label>{t(lang, 'dlg_add_grok_account')}</label>
                <div className="mp-add-in">
                  {grokDetected && !(errorMsg && !connectedId) ? (
                    <>
                      <input
                        data-testid="next-grok-detected"
                        value={t(lang, 'dlg_add_grok_detected', { account: grokAccount })}
                        disabled
                      />
                      <span className="mp-add-det ok" data-testid="next-detected-check">{CHECK_SVG}</span>
                    </>
                  ) : oauthOpen ? (
                    <div style={{ flex: 1 }}>
                      <LoginSessionView
                        session={loginSession}
                        lang={lang}
                        onAnswer={onAnswerOAuth}
                        onCancel={async () => {
                          setOauthOpen(false);
                          await onCancelOAuth();
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="mp-btn mp-pri"
                      data-testid="next-grok-login"
                      onClick={() => {
                        setOauthOpen(true);
                        if (vendor) void onStartOAuth(vendor);
                      }}
                    >
                      {t(lang, 'dlg_add_grok_login')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {!alreadyConnected && isCustom && (
              <>
                <div className="mp-add-f">
                  <label>{t(lang, 'dlg_custom_url_label')}</label>
                  <div className="mp-add-in">
                    <input
                      className="mono"
                      data-testid="next-custom-url"
                      value={customUrl}
                      placeholder={t(lang, 'dlg_custom_url_placeholder')}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      onBlur={() => void handleKeyBlur()}
                    />
                  </div>
                </div>
                <div className="mp-add-f">
                  <label>{t(lang, 'dlg_key_label')}</label>
                  <div className="mp-add-in">
                    <input
                      type="password"
                      className="mono"
                      data-testid="next-custom-key"
                      value={customKey}
                      placeholder="sk-…"
                      onChange={(e) => setCustomKey(e.target.value)}
                      onBlur={() => void handleKeyBlur()}
                    />
                    <span className="mp-add-det">{DASH_SVG}</span>
                  </div>
                </div>
              </>
            )}

            {!alreadyConnected && !isGrok && !isCustom && !isAcp && vendor && (
              <div className="mp-add-f">
                <label>{t(lang, 'dlg_key_label')}</label>
                <div className="mp-add-in">
                  <input
                    type="password"
                    className="mono"
                    data-testid="next-key-input"
                    value={apiKeyInput}
                    placeholder={envDetected && vendor.envVar
                      ? t(lang, 'dlg_add_env_placeholder', { env: vendor.envVar })
                      : 'sk-…'}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onBlur={() => void handleKeyBlur()}
                  />
                  <span className={`mp-add-det${envDetected ? ' ok' : ''}`} data-testid={envDetected ? 'next-detected-check' : undefined}>
                    {envDetected ? CHECK_SVG : DASH_SVG}
                  </span>
                </div>
              </div>
            )}

            {isAcp && selected.acp && (
              <>
                <div className="mp-add-f">
                  <label>{t(lang, 'dlg_add_runtime_path')}</label>
                  <div className="mp-add-in">
                    <input
                      className="mono"
                      placeholder={selected.acp.pathPlaceholder}
                      disabled
                    />
                    <span className="mp-add-det">{DASH_SVG}</span>
                  </div>
                </div>
                <div className={`mp-add-fold${acpFoldOpen ? ' open' : ''}`}>
                  <div className="fh" onClick={() => setAcpFoldOpen((open) => !open)}>
                    {t(lang, 'dlg_add_custom_prompt')}
                  </div>
                  <div className="fb">
                    <textarea disabled />
                  </div>
                </div>
              </>
            )}

            {!isAcp && !alreadyConnected && (
              <div className="mp-add-f">
                <label>{t(lang, 'dlg_add_default_model')}</label>
                <div className="mp-add-in">
                  <div className="mp-add-dd" ref={ddRef}>
                    <button
                      type="button"
                      className={`mp-add-dd-btn${ddOpen ? ' open' : ''}`}
                      data-testid="next-model-dropdown"
                      disabled={!isReady}
                      onClick={() => isReady && setDdOpen((open) => !open)}
                    >
                      {isReady && chosen ? chosen.name : t(lang, 'dlg_add_models_pending')}
                      {CHEV_SVG}
                    </button>
                    {ddOpen && isReady && (
                      <div className="mp-add-dd-menu">
                        {models.map((model) => {
                          const on = model.id === (chosen?.id || '');
                          return (
                            <div
                              key={model.id}
                              className={`mp-add-dd-it${on ? ' on' : ''}`}
                              data-testid="next-model-option"
                              data-model={model.id}
                              onClick={() => {
                                setChosenId(model.id);
                                setDdOpen(false);
                              }}
                            >
                              <span className="ck">{on ? '✓' : ''}</span>
                              <span>{model.name}</span>
                              {model.contextWindow != null ? (
                                <span className="cx">{formatNumber(model.contextWindow)}</span>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {errorMsg && <div className="mp-add-err" data-testid="next-test-result">{errorMsg}</div>}
          </div>

          <div className="mp-add-foot">
            <button type="button" className="mp-btn" data-testid="next-add-cancel" onClick={() => void handleCancel()}>
              {t(lang, 'dlg_cancel')}
            </button>
            {isAcp ? (
              <button type="button" className="mp-btn mp-pri" data-testid="next-acp-coming" disabled>
                {t(lang, 'dlg_add_coming')}
              </button>
            ) : (
              <button
                type="button"
                className="mp-btn mp-pri"
                data-testid="next-provider-finish"
                disabled={loading || !isReady}
                onClick={() => void handleCreate()}
              >
                {t(lang, 'dlg_add_create')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
