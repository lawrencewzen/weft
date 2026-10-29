import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addCustomProvider,
  connectProvider,
  connectProviderOAuth,
  deleteProvider,
  getAvailableProviders,
  getLoginSession,
  getProviders,
  patchProvider,
  testProvider,
  type Available,
  type CustomApiProtocol,
  type LoginSession,
  type Model,
  type Provider,
} from '../../data/api';
import type { Lang } from '../../data/lang';
import type { ConfirmOpts } from '../ConfirmDialog';
import { useProviders } from '../../data/useProviders';
import { formatTokenNum, parseContextInput, defaultEnabledRule } from '../../data/providerFormat';
import { t } from '../../i18n';
import { BrandIcon, brandIconUrl } from '../BrandIcon';

type Props = {
  lang: Lang;
  onToast: (message: string) => void;
  onConfirm: (opts: ConfirmOpts) => Promise<boolean>;
  providersNavSeq?: number;
};

const POPULAR_IDS = [
  'deepseek',
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'moonshotai-cn',
  'zai',
  'qwen-token-plan-cn',
  'minimax-cn',
  'xiaomi',
];

function initial(name: string): string {
  const match = name.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '');
  return (match[0] || '?').toUpperCase();
}

function formatTimeAgo(ts: number | null | undefined, lang: Lang): string {
  if (!ts) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return lang === 'en' ? 'just now' : '刚刚';
  const mins = Math.floor(sec / 60);
  if (mins < 60) return lang === 'en' ? `${mins}m ago` : `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return lang === 'en' ? `${hours}h ago` : `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return lang === 'en' ? `${days}d ago` : `${days} 天前`;
}

export function ProviderPage({ lang, onToast, onConfirm }: Props) {
  const { providers, defaultModel } = useProviders();
  const [available, setAvailable] = useState<Available[]>([]);
  const [openId, setOpenId] = useState<string | null>('deepseek');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [defPickerOpen, setDefPickerOpen] = useState(false);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingVal, setEditingVal] = useState<string>('');

  // Add provider dialog state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addStep, setAddStep] = useState<0 | 1 | 2>(0);
  const [addSearch, setAddSearch] = useState('');
  const [selectedVendor, setSelectedVendor] = useState<Available | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [addWay, setAddWay] = useState<'env' | 'api_key' | 'oauth'>('api_key');
  const [addApiKey, setAddApiKey] = useState('');
  const [customForm, setCustomForm] = useState<{
    name: string;
    baseUrl: string;
    api: CustomApiProtocol;
    apiKey: string;
  }>({
    name: '',
    baseUrl: '',
    api: 'openai-completions',
    apiKey: '',
  });
  const [loginSession, setLoginSession] = useState<LoginSession | null>(null);
  const [sessionPolling, setSessionPolling] = useState(false);
  const [createdProviderId, setCreatedProviderId] = useState<string | null>(null);
  const [modelsToPick, setModelsToPick] = useState<Array<Model & { picked: boolean }>>([]);
  const [modelsSearch, setModelsSearch] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Modals for editing
  const [keyModalProvider, setKeyModalProvider] = useState<Provider | null>(null);
  const [newApiKey, setNewApiKey] = useState('');
  const [customEditProvider, setCustomEditProvider] = useState<Provider | null>(null);
  const [customEditForm, setCustomEditForm] = useState<{
    name: string;
    baseUrl: string;
    api: CustomApiProtocol;
    apiKey: string;
  }>({
    name: '',
    baseUrl: '',
    api: 'openai-completions',
    apiKey: '',
  });

  const menuRef = useRef<HTMLDivElement>(null);
  const defMenuRef = useRef<HTMLDivElement>(null);

  // Fetch available providers catalog
  useEffect(() => {
    let cancelled = false;
    void getAvailableProviders(lang)
      .then((res) => {
        if (!cancelled && res.providers) {
          setAvailable(res.providers);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lang]);

  // Outside click listener for menus
  useEffect(() => {
    function handleDown(e: MouseEvent) {
      if (menuId && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuId(null);
      }
      if (defPickerOpen && defMenuRef.current && !defMenuRef.current.contains(e.target as Node)) {
        setDefPickerOpen(false);
      }
    }
    window.addEventListener('mousedown', handleDown);
    return () => window.removeEventListener('mousedown', handleDown);
  }, [menuId, defPickerOpen]);

  // OAuth session polling
  useEffect(() => {
    if (!sessionPolling || !loginSession || loginSession.state !== 'pending') return;
    let timer: ReturnType<typeof setTimeout>;
    let active = true;

    const poll = async () => {
      try {
        const res = await getLoginSession(loginSession.id, lang);
        if (!active) return;
        setLoginSession(res.session);
        if (res.session.state === 'done') {
          setSessionPolling(false);
          const pList = await getProviders(lang);
          const p = pList.providers.find((row) => row.id === res.session.providerId);
          if (p) {
            setCreatedProviderId(p.id);
            const autoEnable = defaultEnabledRule(p.models.length);
            setModelsToPick(p.models.map((m) => ({ ...m, picked: autoEnable })));
            setAddStep(2);
          }
          return;
        }
        if (res.session.state === 'error' || res.session.state === 'cancelled') {
          setSessionPolling(false);
          setAddError(res.session.state === 'cancelled' ? t(lang, 'dlg_cancel') : 'OAuth authorization failed');
          return;
        }
        timer = setTimeout(poll, 1500);
      } catch {
        if (active) timer = setTimeout(poll, 2000);
      }
    };

    timer = setTimeout(poll, 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [sessionPolling, loginSession, lang]);

  // Default model display
  const defaultEntry = useMemo(() => {
    if (!defaultModel) return null;
    const p = providers.find((row) => row.id === defaultModel.providerId);
    const m = p?.models.find((row) => row.id === defaultModel.modelId);
    if (!p || !m) return null;
    return { provider: p, model: m };
  }, [defaultModel, providers]);

  // Test provider
  const handleTest = async (id: string) => {
    setTesting((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await testProvider(id, lang);
      if (res.provider?.status.state === 'ok') {
        onToast(t(lang, 'provider_status_ok'));
      } else if (res.provider?.status.error) {
        onToast(res.provider.status.error);
      }
    } catch (err: unknown) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting((prev) => ({ ...prev, [id]: false }));
    }
  };

  // Toggle model enable
  const handleToggleModel = async (provider: Provider, modelId: string, nextEnabled: boolean) => {
    const curEnabled = provider.models.filter((m) => m.enabled).map((m) => m.id);
    const nextList = nextEnabled
      ? [...new Set([...curEnabled, modelId])]
      : curEnabled.filter((id) => id !== modelId);
    try {
      await patchProvider(provider.id, { enabled: nextList }, lang);
    } catch (err: unknown) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  };

  // In-place edit save
  const handleSaveOverride = async (providerId: string, modelId: string, field: 'contextWindow' | 'maxTokens', valStr: string) => {
    const parsed = parseContextInput(valStr);
    try {
      await patchProvider(
        providerId,
        {
          overrides: {
            [modelId]: { [field]: parsed },
          },
        },
        lang,
      );
    } catch (err: unknown) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setEditingKey(null);
    }
  };

  // Remove provider
  const handleRemoveProvider = async (p: Provider) => {
    setMenuId(null);
    const ok = await onConfirm({
      title: t(lang, 'provider_delete_title', { name: p.name }),
      message: t(lang, 'provider_delete_message'),
      confirmLabel: t(lang, 'provider_act_remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteProvider(p.id, lang);
      onToast(t(lang, 'provider_act_remove'));
    } catch (err: unknown) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  };

  // Refresh custom provider models
  const handleRefreshCustom = async (id: string) => {
    try {
      await testProvider(id, lang);
      onToast(t(lang, 'provider_status_ok'));
    } catch (err: unknown) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  };

  // Start add flow
  const handleOpenAdd = () => {
    setAddStep(0);
    setAddSearch('');
    setSelectedVendor(null);
    setIsCustom(false);
    setAddApiKey('');
    setCustomForm({ name: '', baseUrl: '', api: 'openai-completions', apiKey: '' });
    setLoginSession(null);
    setSessionPolling(false);
    setCreatedProviderId(null);
    setModelsToPick([]);
    setModelsSearch('');
    setAddBusy(false);
    setAddError(null);
    setIsAddOpen(true);
  };

  // Connect action in step 1
  const handleStep1Connect = async () => {
    setAddBusy(true);
    setAddError(null);
    try {
      if (isCustom) {
        const res = await addCustomProvider(customForm, lang);
        setCreatedProviderId(res.provider.id);
        const autoEnable = defaultEnabledRule(res.provider.models.length);
        setModelsToPick(res.provider.models.map((m) => ({ ...m, picked: autoEnable })));
        setAddStep(2);
      } else if (selectedVendor) {
        if (addWay === 'env') {
          const res = await connectProvider(selectedVendor.id, { method: 'env' }, lang);
          setCreatedProviderId(res.provider.id);
          const autoEnable = defaultEnabledRule(res.provider.models.length);
          setModelsToPick(res.provider.models.map((m) => ({ ...m, picked: autoEnable })));
          setAddStep(2);
        } else if (addWay === 'api_key') {
          const res = await connectProvider(selectedVendor.id, { method: 'api_key', apiKey: addApiKey }, lang);
          setCreatedProviderId(res.provider.id);
          const autoEnable = defaultEnabledRule(res.provider.models.length);
          setModelsToPick(res.provider.models.map((m) => ({ ...m, picked: autoEnable })));
          setAddStep(2);
        } else if (addWay === 'oauth') {
          const res = await connectProviderOAuth(selectedVendor.id, lang);
          setLoginSession(res.session);
          setSessionPolling(true);
          const authUrlEvent = res.session.events?.find((e) => e.type === 'auth_url');
          if (authUrlEvent?.url) {
            window.open(authUrlEvent.url, '_blank');
          }
        }
      }
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  };

  // Finish add in step 2
  const handleFinishAdd = async () => {
    if (!createdProviderId) return;
    setAddBusy(true);
    try {
      const enabledIds = modelsToPick.filter((m) => m.picked).map((m) => m.id);
      await patchProvider(createdProviderId, { enabled: enabledIds }, lang);
      setOpenId(createdProviderId);
      setIsAddOpen(false);
      onToast(t(lang, 'provider_status_ok'));
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  };

  // Render protocol tag for custom provider
  const protoTag = (api?: CustomApiProtocol) => {
    if (api === 'openai-responses') return <span className="tag">{t(lang, 'dlg_custom_proto_responses')}</span>;
    if (api === 'anthropic-messages') return <span className="tag">Anthropic</span>;
    return <span className="tag">OpenAI</span>;
  };

  return (
    <div className="next-settings-content" data-testid="next-settings-providers">
      <div className="next-settings-head">
        <div>
          <h2>{t(lang, 'provider_title')}</h2>
          <p className="next-settings-sub">{t(lang, 'provider_subtitle')}</p>
        </div>
      </div>

      {/* Default Model Selector */}
      <div className="sec" style={{ marginTop: 8 }}>
        <div className="card def">
          <span className="l">
            <span>{t(lang, 'provider_default_title')}</span>
            <span>{t(lang, 'provider_default_hint')}</span>
          </span>
          <span
            className="pick"
            data-testid="next-default-model"
            onClick={() => setDefPickerOpen(!defPickerOpen)}
          >
            {defaultEntry ? defaultEntry.model.name : t(lang, 'provider_default_unselected')}
            {defaultEntry ? <span className="from">{defaultEntry.provider.name}</span> : null}
            <span style={{ fontSize: 10, color: 'var(--faint)' }}>▾</span>
            {defPickerOpen && (
              <div className="menu" ref={defMenuRef} onClick={(e) => e.stopPropagation()}>
                {providers.map((p) => {
                  const enabledModels = p.models.filter((m) => m.enabled);
                  if (!enabledModels.length) return null;
                  return (
                    <div key={p.id}>
                      <div className="g">{p.name}</div>
                      {enabledModels.map((m) => (
                        <div
                          key={m.id}
                          className="i ns-pop-item"
                          onClick={async () => {
                            setDefPickerOpen(false);
                            try {
                              await patchProvider(p.id, { defaultModel: m.id }, lang);
                            } catch (err: unknown) {
                              onToast(err instanceof Error ? err.message : String(err));
                            }
                          }}
                        >
                          <BrandIcon brand={m.brand || p.brand || p.id} size={14} />
                          <span>{m.name}</span>
                          <span className="x">{formatTokenNum(m.contextWindow)}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </span>
        </div>
      </div>

      {/* Providers Section */}
      <div className="sec">
        <div className="sec-h">
          <b>{t(lang, 'provider_sec_title')}</b>
          <small>{t(lang, 'provider_sec_hint')}</small>
          <span className="sp" />
          <button
            className="btn"
            data-testid="next-provider-add"
            onClick={handleOpenAdd}
          >
            {t(lang, 'provider_add_button')}
          </button>
        </div>

        <div className="card">
          <div className="plist">
            {providers.map((p, i) => {
              const enabledCount = p.models.filter((m) => m.enabled).length;
              const isOpen = openId === p.id;
              const iconUrl = brandIconUrl(p.brand || p.id);
              const isTesting = Boolean(testing[p.id]);

              return (
                <div
                  key={p.id}
                  className={`prow ${i === 0 ? 'first' : ''} ${isOpen ? 'open' : ''}`}
                  data-testid="next-provider-row"
                  data-id={p.id}
                  onClick={() => setOpenId(isOpen ? null : p.id)}
                >
                  {/* Col 1: Icon (58px) */}
                  <span className="c">
                    <span className="av">
                      {iconUrl ? (
                        <BrandIcon brand={p.brand || p.id} size={18} />
                      ) : (
                        <span>{initial(p.name)}</span>
                      )}
                    </span>
                  </span>

                  {/* Col 2: Name & Auth (1fr) */}
                  <span className="c">
                    <span className="pn">
                      <span className="n">
                        <span>{p.name}</span>
                        {p.kind === 'custom' ? protoTag(p.api) : null}
                        <svg
                          className="chev"
                          viewBox="0 0 12 12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                        >
                          <path d="M4.5 2.5 8 6l-3.5 3.5" />
                        </svg>
                      </span>
                      <span className="d">
                        {p.kind === 'custom' ? (
                          `自定义 · ${p.baseUrl || ''}`
                        ) : p.auth.type === 'oauth' ? (
                          `账号登录 · ${p.auth.account || ''}`
                        ) : p.auth.type === 'env' ? (
                          <>
                            环境变量 <span className="k">{p.auth.envVar}</span>
                          </>
                        ) : p.auth.type === 'api_key' ? (
                          <>
                            API Key <span className="k">····{p.auth.keyTail}</span>
                          </>
                        ) : (
                          '无认证'
                        )}
                      </span>
                    </span>
                  </span>

                  {/* Col 3: Enabled Count (136px) */}
                  <span className="c cnt">
                    {t(lang, 'provider_enabled_summary', {
                      enabled: enabledCount,
                      total: p.models.length,
                    })}
                  </span>

                  {/* Col 4: Status (166px) */}
                  <span className="c">
                    {isTesting ? (
                      <span className="st run">
                        <i />
                        {t(lang, 'provider_status_run')}
                      </span>
                    ) : p.status.state === 'ok' ? (
                      <span className="st ok">
                        <i />
                        {t(lang, 'provider_status_ok')}
                        {p.status.testedAt ? (
                          <small>{formatTimeAgo(p.status.testedAt, lang)}</small>
                        ) : null}
                      </span>
                    ) : p.status.state === 'error' ? (
                      <span className="st bad">
                        <i />
                        {t(lang, 'provider_status_bad')}
                        {p.status.testedAt ? (
                          <small>{formatTimeAgo(p.status.testedAt, lang)}</small>
                        ) : null}
                      </span>
                    ) : (
                      <span className="st">
                        <i />
                        {t(lang, 'provider_status_untested')}
                      </span>
                    )}
                  </span>

                  {/* Col 5: Actions (146px) */}
                  <span className="c" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn"
                      data-testid="next-provider-test"
                      disabled={isTesting}
                      onClick={() => handleTest(p.id)}
                    >
                      {t(lang, 'provider_btn_test')}
                    </button>
                    <button
                      className="more"
                      data-testid="next-provider-more"
                      onClick={() => setMenuId(menuId === p.id ? null : p.id)}
                    >
                      ⋯
                      {menuId === p.id && (
                        <div className="pop" ref={menuRef}>
                          {p.auth.type === 'oauth' && (
                            <div
                              onClick={() => {
                                setMenuId(null);
                                setSelectedVendor(available.find((a) => a.id === p.id) || null);
                                setIsCustom(false);
                                setAddWay('oauth');
                                setAddStep(1);
                                setIsAddOpen(true);
                              }}
                            >
                              {t(lang, 'provider_act_relogin')}
                            </div>
                          )}
                          {p.kind === 'custom' && (
                            <div
                              data-testid="next-provider-edit"
                              onClick={() => {
                                setMenuId(null);
                                setCustomEditProvider(p);
                                setCustomEditForm({
                                  name: p.name,
                                  baseUrl: p.baseUrl || '',
                                  api: p.api || 'openai-completions',
                                  apiKey: '',
                                });
                              }}
                            >
                              {t(lang, 'provider_act_edit')}
                            </div>
                          )}
                          {p.auth.type === 'api_key' && (
                            <div
                              data-testid="next-provider-key"
                              onClick={() => {
                                setMenuId(null);
                                setKeyModalProvider(p);
                                setNewApiKey('');
                              }}
                            >
                              {t(lang, 'provider_act_key')}
                            </div>
                          )}
                          <div
                            className="danger"
                            data-testid="next-provider-delete"
                            onClick={() => handleRemoveProvider(p)}
                          >
                            {t(lang, 'provider_act_remove')}
                          </div>
                        </div>
                      )}
                    </button>
                  </span>

                  {/* Expanded Model Table */}
                  {isOpen && (
                    <div className="models">
                      {p.status.state === 'error' && p.status.error && (
                        <div className="err" data-testid="next-test-result">{p.status.error}</div>
                      )}
                      <div className="mt">
                        <span className="h">{t(lang, 'model_th_name')}</span>
                        <span className="h r">{t(lang, 'model_th_context')}</span>
                        <span className="h r">{t(lang, 'model_th_max_tokens')}</span>
                        <span className="h">{t(lang, 'model_th_caps')}</span>
                        <span className="h r">{t(lang, 'model_th_enabled')}</span>

                        {p.models.map((m) => {
                          const isEditingCtx = editingKey === `${p.id}:${m.id}:contextWindow`;
                          const isEditingMax = editingKey === `${p.id}:${m.id}:maxTokens`;

                          return (
                            <div key={m.id} style={{ display: 'contents' }} data-testid="next-model-row" data-model={m.id}>
                              {/* Model name & id */}
                              <span className="c">
                                <span className={`mn ${m.enabled ? '' : 'off'}`}>
                                  <span className="nm">{m.name}</span>
                                  {m.name !== m.id ? <span className="id">{m.id}</span> : null}
                                </span>
                              </span>

                              {/* Context Window */}
                              <span className="c num">
                                {isEditingCtx ? (
                                  <input
                                    autoFocus
                                    data-testid="next-ctx-input"
                                    value={editingVal}
                                    placeholder="131072"
                                    onChange={(e) => setEditingVal(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        void handleSaveOverride(p.id, m.id, 'contextWindow', editingVal);
                                      } else if (e.key === 'Escape') {
                                        setEditingKey(null);
                                      }
                                    }}
                                    onBlur={() => void handleSaveOverride(p.id, m.id, 'contextWindow', editingVal)}
                                  />
                                ) : (
                                  <span
                                    className={`v ${m.overridden?.contextWindow ? 'cus' : ''} ${m.contextWindow == null ? 'unk' : ''}`}
                                    title={
                                      m.contextWindow == null
                                        ? t(lang, 'model_title_unknown')
                                        : m.overridden?.contextWindow
                                          ? t(lang, 'model_title_overridden')
                                          : t(lang, 'model_title_default')
                                    }
                                    onClick={() => {
                                      setEditingKey(`${p.id}:${m.id}:contextWindow`);
                                      setEditingVal(m.contextWindow == null ? '' : String(m.contextWindow));
                                    }}
                                  >
                                    {formatTokenNum(m.contextWindow)}
                                  </span>
                                )}
                              </span>

                              {/* Max Tokens */}
                              <span className="c num">
                                {isEditingMax ? (
                                  <input
                                    autoFocus
                                    value={editingVal}
                                    placeholder="8192"
                                    onChange={(e) => setEditingVal(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        void handleSaveOverride(p.id, m.id, 'maxTokens', editingVal);
                                      } else if (e.key === 'Escape') {
                                        setEditingKey(null);
                                      }
                                    }}
                                    onBlur={() => void handleSaveOverride(p.id, m.id, 'maxTokens', editingVal)}
                                  />
                                ) : (
                                  <span
                                    className={`v ${m.overridden?.maxTokens ? 'cus' : ''} ${m.maxTokens == null ? 'unk' : ''}`}
                                    title={
                                      m.maxTokens == null
                                        ? t(lang, 'model_title_unknown')
                                        : m.overridden?.maxTokens
                                          ? t(lang, 'model_title_overridden')
                                          : t(lang, 'model_title_default')
                                    }
                                    onClick={() => {
                                      setEditingKey(`${p.id}:${m.id}:maxTokens`);
                                      setEditingVal(m.maxTokens == null ? '' : String(m.maxTokens));
                                    }}
                                  >
                                    {formatTokenNum(m.maxTokens)}
                                  </span>
                                )}
                              </span>

                              {/* Capabilities */}
                              <span className="c">
                                <span className="caps">
                                  {m.images ? <span>{t(lang, 'model_cap_images')}</span> : null}
                                  {m.reasoning ? <span>{t(lang, 'model_cap_reasoning')}</span> : null}
                                  {!m.images && !m.reasoning ? (
                                    <span style={{ color: 'var(--faint)' }}>—</span>
                                  ) : null}
                                </span>
                              </span>

                              {/* Enable Switch */}
                              <span className="c">
                                <button
                                  className={`sw ${m.enabled ? 'on' : ''}`}
                                  data-testid="next-model-toggle"
                                  data-tog={`${p.id}|${m.id}`}
                                  title={m.enabled ? t(lang, 'model_toggle_on') : t(lang, 'model_toggle_off')}
                                  onClick={() => handleToggleModel(p, m.id, !m.enabled)}
                                />
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Footer note */}
                      <div className="mnote">
                        {p.models.filter((m) => m.contextWindow == null).length > 0 && (
                          <span>
                            {t(lang, 'model_unknown_note', {
                              count: p.models.filter((m) => m.contextWindow == null).length,
                            })}
                          </span>
                        )}
                        {p.kind === 'custom' && (
                          <>
                            <span style={{ flex: 1 }} />
                            <a onClick={() => handleRefreshCustom(p.id)}>
                              {t(lang, 'model_refresh_custom')}
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Add Provider Dialog */}
      {isAddOpen && (
        <div
          className="mask"
          onClick={(e) => {
            if (e.target === e.currentTarget && !addBusy) setIsAddOpen(false);
          }}
        >
          <div className="dlg">
            {/* Dialog Header */}
            <div className="dh">
              <b>
                {addStep === 0
                  ? t(lang, 'dlg_add_provider_title')
                  : addStep === 1
                    ? isCustom
                      ? t(lang, 'dlg_add_custom_title')
                      : t(lang, 'dlg_connect_title', { name: selectedVendor?.name || '' })
                    : t(lang, 'dlg_models_title')}
              </b>
              <span className="steps">
                <i className={addStep >= 0 ? 'on' : ''} />
                <i className={addStep >= 1 ? 'on' : ''} />
                <i className={addStep >= 2 ? 'on' : ''} />
              </span>
              <button
                className="x"
                disabled={addBusy}
                onClick={() => setIsAddOpen(false)}
              >
                ×
              </button>
            </div>

            {/* Dialog Body */}
            <div className="db">
              {addError && <div className="err" style={{ marginBottom: 12 }}>{addError}</div>}

              {/* Step 0: Pick Provider */}
              {addStep === 0 && (
                <>
                  <input
                    className="search"
                    placeholder={t(lang, 'dlg_add_search_placeholder')}
                    value={addSearch}
                    autoFocus
                    onChange={(e) => setAddSearch(e.target.value)}
                  />

                  {/* Popular group */}
                  {(() => {
                    const connectedIds = new Set(providers.map((p) => p.id));
                    const q = addSearch.trim().toLowerCase();
                    const filteredPopular = available
                      .filter((a) => POPULAR_IDS.includes(a.id))
                      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.includes(q));

                    if (!filteredPopular.length) return null;
                    return (
                      <>
                        <div className="grp">{t(lang, 'dlg_add_grp_popular')}</div>
                        <div className="vgrid">
                          {filteredPopular.map((a) => {
                            const isConnected = connectedIds.has(a.id);
                            return (
                              <div
                                key={a.id}
                                className={`vi ${isConnected ? 'dis' : ''}`}
                                data-testid="next-vendor-card"
                                data-vendor={a.id}
                                onClick={() => {
                                  if (isConnected) return;
                                  setSelectedVendor(a);
                                  setIsCustom(false);
                                  if (a.envDetected) setAddWay('env');
                                  else if (a.authMethods.includes('api_key')) setAddWay('api_key');
                                  else setAddWay('oauth');
                                  setAddStep(1);
                                }}
                              >
                                <span className="av">
                                  <BrandIcon brand={a.id} size={18} />
                                </span>
                                <span className="t">
                                  <span>{a.name}</span>
                                  <span>
                                    {isConnected
                                      ? t(lang, 'dlg_add_already_connected')
                                      : `${a.authMethods.includes('oauth') ? t(lang, 'dlg_add_ways_both') : t(lang, 'dlg_add_ways_key_only')} · ${t(lang, 'dlg_add_models_count', { count: a.modelCount })}`}
                                  </span>
                                </span>
                                {a.envDetected && !isConnected && (
                                  <span className="env">{t(lang, 'dlg_add_env_detected')}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}

                  {/* All other providers */}
                  {(() => {
                    const connectedIds = new Set(providers.map((p) => p.id));
                    const q = addSearch.trim().toLowerCase();
                    const filteredRest = available
                      .filter((a) => !POPULAR_IDS.includes(a.id))
                      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.includes(q));

                    if (!filteredRest.length) return null;
                    return (
                      <>
                        <div className="grp">{t(lang, 'dlg_add_grp_all')}</div>
                        <div className="vgrid">
                          {filteredRest.map((a) => {
                            const isConnected = connectedIds.has(a.id);
                            return (
                              <div
                                key={a.id}
                                className={`vi ${isConnected ? 'dis' : ''}`}
                                data-testid="next-vendor-card"
                                data-vendor={a.id}
                                onClick={() => {
                                  if (isConnected) return;
                                  setSelectedVendor(a);
                                  setIsCustom(false);
                                  if (a.envDetected) setAddWay('env');
                                  else if (a.authMethods.includes('api_key')) setAddWay('api_key');
                                  else setAddWay('oauth');
                                  setAddStep(1);
                                }}
                              >
                                <span className="av">
                                  <BrandIcon brand={a.id} size={18} />
                                </span>
                                <span className="t">
                                  <span>{a.name}</span>
                                  <span>
                                    {isConnected
                                      ? t(lang, 'dlg_add_already_connected')
                                      : `${a.authMethods.includes('oauth') ? t(lang, 'dlg_add_ways_both') : t(lang, 'dlg_add_ways_key_only')} · ${t(lang, 'dlg_add_models_count', { count: a.modelCount })}`}
                                  </span>
                                </span>
                                {a.envDetected && !isConnected && (
                                  <span className="env">{t(lang, 'dlg_add_env_detected')}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}

                  {/* Custom Endpoint card */}
                  <div className="grp">{t(lang, 'dlg_add_grp_other')}</div>
                  <div className="vgrid">
                    <div
                      className="vi custom"
                      data-testid="next-vendor-card"
                      data-vendor="custom"
                      onClick={() => {
                        setIsCustom(true);
                        setSelectedVendor(null);
                        setAddStep(1);
                      }}
                    >
                      <span className="av">＋</span>
                      <span className="t">
                        <span>{t(lang, 'dlg_add_custom_title')}</span>
                        <span>{t(lang, 'dlg_add_custom_desc')}</span>
                      </span>
                    </div>
                  </div>
                </>
              )}

              {/* Step 1: Connect Form */}
              {addStep === 1 && (
                <>
                  {isCustom ? (
                    <div>
                      <div className="fld">
                        <label>{t(lang, 'dlg_custom_name_label')}</label>
                        <input
                          data-testid="next-custom-name"
                          placeholder={t(lang, 'dlg_custom_name_placeholder')}
                          value={customForm.name}
                          onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
                        />
                      </div>
                      <div className="fld">
                        <label>{t(lang, 'dlg_custom_url_label')}</label>
                        <input
                          className="mono"
                          data-testid="next-custom-url"
                          placeholder={t(lang, 'dlg_custom_url_placeholder')}
                          value={customForm.baseUrl}
                          onChange={(e) => setCustomForm({ ...customForm, baseUrl: e.target.value })}
                        />
                      </div>
                      <div className="fld">
                        <label>{t(lang, 'dlg_custom_proto_label')}</label>
                        <select
                          data-testid="next-custom-proto"
                          value={customForm.api}
                          onChange={(e) => setCustomForm({ ...customForm, api: e.target.value as CustomApiProtocol })}
                        >
                          <option value="openai-completions">{t(lang, 'dlg_custom_proto_openai')}</option>
                          <option value="openai-responses">{t(lang, 'dlg_custom_proto_responses')}</option>
                          <option value="anthropic-messages">{t(lang, 'dlg_custom_proto_anthropic')}</option>
                        </select>
                      </div>
                      <div className="fld">
                        <label>
                          {t(lang, 'dlg_custom_key_label')}{' '}
                          <small style={{ color: 'var(--faint)' }}>{t(lang, 'dlg_custom_key_optional')}</small>
                        </label>
                        <input
                          className="mono"
                          type="password"
                          data-testid="next-key-input"
                          placeholder={t(lang, 'dlg_custom_key_placeholder')}
                          value={customForm.apiKey}
                          onChange={(e) => setCustomForm({ ...customForm, apiKey: e.target.value })}
                        />
                      </div>
                    </div>
                  ) : selectedVendor ? (
                    <div>
                      {/* Segment selector */}
                      <div className="seg">
                        {selectedVendor.envDetected && (
                          <button
                            className={addWay === 'env' ? 'on' : ''}
                            onClick={() => setAddWay('env')}
                          >
                            {t(lang, 'dlg_tab_env')}
                          </button>
                        )}
                        {selectedVendor.authMethods.includes('api_key') && (
                          <button
                            className={addWay === 'api_key' ? 'on' : ''}
                            onClick={() => setAddWay('api_key')}
                          >
                            {t(lang, 'dlg_tab_api_key')}
                          </button>
                        )}
                        {selectedVendor.authMethods.includes('oauth') && (
                          <button
                            className={addWay === 'oauth' ? 'on' : ''}
                            onClick={() => setAddWay('oauth')}
                          >
                            {t(lang, 'dlg_tab_oauth')}
                          </button>
                        )}
                      </div>

                      {addWay === 'env' && (
                        <div className="envbox">
                          <span>✓</span>
                          <span>
                            {t(lang, 'dlg_env_note', { env: selectedVendor.envVar || 'API_KEY' })}
                          </span>
                        </div>
                      )}

                      {addWay === 'api_key' && (
                        <div className="fld">
                          <label>{t(lang, 'dlg_key_label')}</label>
                          <input
                            className="mono"
                            type="password"
                            data-testid="next-key-input"
                            autoFocus
                            placeholder={t(lang, 'dlg_key_placeholder')}
                            value={addApiKey}
                            onChange={(e) => setAddApiKey(e.target.value)}
                          />
                          <small>{t(lang, 'dlg_key_hint')}</small>
                        </div>
                      )}

                      {addWay === 'oauth' && (
                        <div className="oauth">
                          {!loginSession ? (
                            <>
                              <p>{t(lang, 'dlg_oauth_desc', { name: selectedVendor.name })}</p>
                              <button
                                className="btn pri"
                                disabled={addBusy}
                                onClick={handleStep1Connect}
                              >
                                {t(lang, 'dlg_oauth_btn_open')}
                              </button>
                              <small style={{ color: 'var(--faint)' }}>{t(lang, 'dlg_oauth_renew_tip')}</small>
                            </>
                          ) : (
                            <>
                              <p>{t(lang, 'dlg_oauth_opened_tip')}</p>
                              {(() => {
                                const deviceCode = loginSession.events?.find((e) => e.type === 'device_code');
                                if (deviceCode && 'userCode' in deviceCode) {
                                  return (
                                    <>
                                      <span className="code">{deviceCode.userCode}</span>
                                      <p>{t(lang, 'dlg_oauth_code_tip')}</p>
                                    </>
                                  );
                                }
                                return null;
                              })()}
                              <p>
                                <span className="spin" /> {t(lang, 'dlg_oauth_waiting')}
                              </p>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ) : null}
                </>
              )}

              {/* Step 2: Choose Models */}
              {addStep === 2 && (
                <>
                  <div className="okline">
                    ✓ {t(lang, 'dlg_models_ok')}
                    {isCustom ? t(lang, 'dlg_models_ok_count', { count: modelsToPick.length }) : ''}
                  </div>

                  {modelsToPick.length > 8 && (
                    <input
                      className="search"
                      style={{ marginBottom: 10 }}
                      placeholder={t(lang, 'dlg_models_search_placeholder', { count: modelsToPick.length })}
                      value={modelsSearch}
                      onChange={(e) => setModelsSearch(e.target.value)}
                    />
                  )}

                  <div className="pickm">
                    <span className="h" />
                    <span className="h">{t(lang, 'model_th_name')}</span>
                    <span className="h r">{t(lang, 'model_th_context')}</span>
                    <span className="h r">{t(lang, 'model_th_max_tokens')}</span>
                    <span className="h">{t(lang, 'model_th_caps')}</span>

                    {modelsToPick
                      .filter((m) => {
                        if (!modelsSearch.trim()) return true;
                        const q = modelsSearch.toLowerCase();
                        return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
                      })
                      .map((m) => (
                        <div key={m.id} style={{ display: 'contents' }}>
                          <span className="c">
                            <input
                              type="checkbox"
                              className="cb"
                              checked={m.picked}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setModelsToPick((prev) =>
                                  prev.map((item) => (item.id === m.id ? { ...item, picked: checked } : item)),
                                );
                              }}
                            />
                          </span>
                          <span className="c">
                            <span className="mn" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                              <span>{m.name}</span>
                              <span style={{ font: '11.5px var(--mono)', color: 'var(--faint)' }}>{m.id}</span>
                            </span>
                          </span>
                          <span className="c r num">
                            {m.contextWindow == null ? (
                              <span className="v unk">{t(lang, 'model_unknown')}</span>
                            ) : (
                              formatTokenNum(m.contextWindow)
                            )}
                          </span>
                          <span className="c r num">{formatTokenNum(m.maxTokens)}</span>
                          <span className="c">
                            <span className="caps">
                              {m.images ? <span>{t(lang, 'model_cap_images')}</span> : null}
                              {m.reasoning ? <span>{t(lang, 'model_cap_reasoning')}</span> : null}
                            </span>
                          </span>
                        </div>
                      ))}
                  </div>
                </>
              )}
            </div>

            {/* Dialog Footer */}
            <div className="df">
              {addStep === 0 ? (
                <>
                  <span className="sp" />
                  <button className="btn" onClick={() => setIsAddOpen(false)}>
                    {t(lang, 'dlg_cancel')}
                  </button>
                </>
              ) : addStep === 1 ? (
                <>
                  <button
                    className="btn"
                    disabled={addBusy}
                    onClick={() => setAddStep(0)}
                  >
                    {t(lang, 'dlg_back')}
                  </button>
                  <span className="sp" />
                  <button
                    className="btn pri"
                    data-testid="next-provider-test"
                    disabled={addBusy || (isCustom && !customForm.baseUrl) || (!isCustom && addWay === 'api_key' && !addApiKey)}
                    onClick={handleStep1Connect}
                  >
                    {isCustom
                      ? t(lang, 'dlg_connect_fetch')
                      : addWay === 'api_key'
                        ? t(lang, 'dlg_verify_continue')
                        : t(lang, 'dlg_next')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn"
                    disabled={addBusy}
                    onClick={() => setAddStep(1)}
                  >
                    {t(lang, 'dlg_back')}
                  </button>
                  <span className="hint">
                    {t(lang, 'dlg_models_selected_hint', {
                      count: modelsToPick.filter((m) => m.picked).length,
                    })}
                  </span>
                  <span className="sp" />
                  <button
                    className="btn pri"
                    data-testid="next-provider-finish"
                    disabled={addBusy || !modelsToPick.some((m) => m.picked)}
                    onClick={handleFinishAdd}
                  >
                    {t(lang, 'dlg_finish')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Change API Key Modal */}
      {keyModalProvider && (
        <div
          className="mask"
          onClick={(e) => {
            if (e.target === e.currentTarget) setKeyModalProvider(null);
          }}
        >
          <div className="dlg" style={{ width: 440 }}>
            <div className="dh">
              <b>{t(lang, 'modal_key_title')}</b>
              <button className="x" onClick={() => setKeyModalProvider(null)}>×</button>
            </div>
            <div className="db">
              <div className="fld">
                <label>API Key</label>
                <input
                  className="mono"
                  type="password"
                  data-testid="next-key-input"
                  autoFocus
                  placeholder={t(lang, 'modal_key_placeholder')}
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                />
              </div>
            </div>
            <div className="df">
              <span className="sp" />
              <button className="btn" onClick={() => setKeyModalProvider(null)}>
                {t(lang, 'dlg_cancel')}
              </button>
              <button
                className="btn pri"
                data-testid="next-provider-save"
                disabled={!newApiKey.trim()}
                onClick={async () => {
                  try {
                    await patchProvider(keyModalProvider.id, { apiKey: newApiKey }, lang);
                    setKeyModalProvider(null);
                    onToast(t(lang, 'modal_save'));
                  } catch (err: unknown) {
                    onToast(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                {t(lang, 'modal_save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Custom Endpoint Modal */}
      {customEditProvider && (
        <div
          className="mask"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCustomEditProvider(null);
          }}
        >
          <div className="dlg" style={{ width: 480 }}>
            <div className="dh">
              <b>{t(lang, 'provider_act_edit')}</b>
              <button className="x" onClick={() => setCustomEditProvider(null)}>×</button>
            </div>
            <div className="db">
              <div className="fld">
                <label>{t(lang, 'dlg_custom_name_label')}</label>
                <input
                  data-testid="next-provider-name"
                  value={customEditForm.name}
                  onChange={(e) => setCustomEditForm({ ...customEditForm, name: e.target.value })}
                />
              </div>
              <div className="fld">
                <label>{t(lang, 'dlg_custom_url_label')}</label>
                <input
                  className="mono"
                  value={customEditForm.baseUrl}
                  onChange={(e) => setCustomEditForm({ ...customEditForm, baseUrl: e.target.value })}
                />
              </div>
              <div className="fld">
                <label>{t(lang, 'dlg_custom_proto_label')}</label>
                <select
                  value={customEditForm.api}
                  onChange={(e) => setCustomEditForm({ ...customEditForm, api: e.target.value as CustomApiProtocol })}
                >
                  <option value="openai-completions">{t(lang, 'dlg_custom_proto_openai')}</option>
                  <option value="openai-responses">{t(lang, 'dlg_custom_proto_responses')}</option>
                  <option value="anthropic-messages">{t(lang, 'dlg_custom_proto_anthropic')}</option>
                </select>
              </div>
              <div className="fld">
                <label>{t(lang, 'dlg_custom_key_label')}</label>
                <input
                  className="mono"
                  type="password"
                  placeholder={t(lang, 'modal_key_placeholder')}
                  value={customEditForm.apiKey}
                  onChange={(e) => setCustomEditForm({ ...customEditForm, apiKey: e.target.value })}
                />
              </div>
            </div>
            <div className="df">
              <span className="sp" />
              <button className="btn" onClick={() => setCustomEditProvider(null)}>
                {t(lang, 'dlg_cancel')}
              </button>
              <button
                className="btn pri"
                data-testid="next-provider-save"
                onClick={async () => {
                  try {
                    await patchProvider(
                      customEditProvider.id,
                      {
                        name: customEditForm.name,
                        baseUrl: customEditForm.baseUrl,
                        api: customEditForm.api,
                        ...(customEditForm.apiKey ? { apiKey: customEditForm.apiKey } : {}),
                      },
                      lang,
                    );
                    setCustomEditProvider(null);
                    onToast(t(lang, 'modal_save'));
                  } catch (err: unknown) {
                    onToast(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                {t(lang, 'modal_save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
