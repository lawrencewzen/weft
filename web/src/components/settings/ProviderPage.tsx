import { useEffect, useRef, useState } from 'react';
import {
  addCustomProvider,
  answerLoginSession,
  cancelLoginSession,
  connectProvider,
  connectProviderOAuth,
  deleteProvider,
  getAvailableProviders,
  getLoginSession,
  patchProvider,
  putModelContextWindow,
  testProvider,
} from '../../data/api';
import type { Lang } from '../../data/lang';
import { formatNumber, parseContextInput } from '../../data/providerFormat';
import type {
  Available,
  LoginSession,
  Model,
  Provider,
} from '../../data/providerTypes';
import { useProviders } from '../../data/useProviders';
import { t } from '../../i18n';
import type { ConfirmOpts } from '../ConfirmDialog';
import { AddProviderDialog } from './AddProviderDialog';
import { ProviderList } from './ProviderList';

type Props = {
  lang: Lang;
  onToast?: (message: string) => void;
  onConfirm?: (opts: ConfirmOpts) => Promise<boolean>;
  providersNavSeq?: number;
};

export function ProviderPage({ lang, onConfirm }: Props) {
  const { providers, defaultModel } = useProviders();

  const [openId, setOpenId] = useState<string | null>('deepseek');
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [defMenuOpen, setDefMenuOpen] = useState(false);
  const defMenuRef = useRef<HTMLDivElement | null>(null);

  // Add dialog state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [available, setAvailable] = useState<Available[]>([]);
  const [loginSession, setLoginSession] = useState<LoginSession | null>(null);
  const sessionPollRef = useRef<number | null>(null);

  useEffect(() => {
    if (!defMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (defMenuRef.current && !defMenuRef.current.contains(e.target as Node)) {
        setDefMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [defMenuOpen]);

  useEffect(() => {
    return () => {
      if (sessionPollRef.current) window.clearTimeout(sessionPollRef.current);
    };
  }, []);

  const handleOpenAdd = async () => {
    setIsAddOpen(true);
    setLoginSession(null);
    try {
      const res = await getAvailableProviders(lang);
      setAvailable(res.providers);
    } catch {
      // ignore
    }
  };

  const handleTest = async (id: string) => {
    setTesting((prev) => ({ ...prev, [id]: true }));
    try {
      await testProvider(id);
    } catch {
      // ignore
    } finally {
      setTesting((prev) => ({ ...prev, [id]: false }));
    }
  };

  const handleToggleModel = async (providerId: string, modelId: string, enabled: boolean) => {
    const p = providers.find((x) => x.id === providerId);
    if (!p) return;
    const enabledSet = new Set(p.models.filter((m) => m.enabled).map((m) => m.id));
    if (enabled) enabledSet.add(modelId);
    else enabledSet.delete(modelId);
    await patchProvider(providerId, { enabled: Array.from(enabledSet) }, lang);
  };

  const handleSaveOverride = async (
    providerId: string,
    modelId: string,
    key: 'contextWindow' | 'maxTokens',
    value: string,
  ) => {
    const trimmed = value.trim();
    const parsed = parseContextInput(trimmed);
    if (parsed === null) {
      if (key === 'contextWindow') {
        await putModelContextWindow(providerId, modelId, null, lang);
      } else {
        await patchProvider(providerId, { overrides: { [modelId]: { maxTokens: null } } }, lang);
      }
    } else if (parsed !== undefined) {
      if (key === 'contextWindow') {
        await putModelContextWindow(providerId, modelId, parsed, lang);
      } else {
        await patchProvider(providerId, { overrides: { [modelId]: { maxTokens: parsed } } }, lang);
      }
    }
  };

  const handleSelectDefault = async (providerId: string, modelId: string) => {
    setDefMenuOpen(false);
    await patchProvider(providerId, { defaultModel: modelId });
  };

  // OAuth Session flow
  const pollSession = (sid: string) => {
    if (sessionPollRef.current) window.clearTimeout(sessionPollRef.current);
    sessionPollRef.current = window.setTimeout(async () => {
      try {
        const res = await getLoginSession(sid, lang);
        const s = (res as { session?: LoginSession }).session || (res as unknown as LoginSession);
        setLoginSession(s);
        if (s && (s.state === 'pending' || s.state === 'prompt')) pollSession(sid);
      } catch {
        // ignore
      }
    }, 1000);
  };

  const handleStartOAuth = async (vendor: Available) => {
    const res = await connectProviderOAuth(vendor.id, lang);
    setLoginSession(res.session);
    pollSession(res.session.id);
  };

  const handleAnswerOAuth = async (input: string) => {
    if (!loginSession) return;
    const res = await answerLoginSession(loginSession.id, input, lang);
    setLoginSession(res.session);
    if (res.session.state === 'pending' || res.session.state === 'prompt') pollSession(res.session.id);
  };

  const handleCancelOAuth = async () => {
    if (!loginSession) return;
    if (sessionPollRef.current) window.clearTimeout(sessionPollRef.current);
    await cancelLoginSession(loginSession.id, lang);
    setLoginSession(null);
  };

  const handleFinishAdd = async (models: Model[]) => {
    if (loginSession && loginSession.providerId) {
      setOpenId(loginSession.providerId);
    }
    setLoginSession(null);
    if (sessionPollRef.current) {
      window.clearTimeout(sessionPollRef.current);
      sessionPollRef.current = null;
    }
    await Promise.resolve(models);
  };

  const handleCloseAdd = () => {
    setIsAddOpen(false);
    setLoginSession(null);
    if (sessionPollRef.current) {
      window.clearTimeout(sessionPollRef.current);
      sessionPollRef.current = null;
    }
  };

  const handleDelete = async (p: Provider) => {
    if (onConfirm) {
      const ok = await onConfirm({
        title: t(lang, 'provider_delete_title', { name: p.name }),
        message: t(lang, 'provider_delete_message'),
        danger: true,
        confirmLabel: t(lang, 'provider_act_remove'),
      });
      if (!ok) return;
    }
    await deleteProvider(p.id);
  };

  // Find default model display name
  let currentDefaultName = t(lang, 'provider_default_unselected');
  let currentDefaultProviderName = '';
  if (defaultModel) {
    for (const p of providers) {
      if (p.id === defaultModel.providerId) {
        const m = p.models.find((item) => item.id === defaultModel.modelId);
        if (m) {
          currentDefaultName = m.name;
          currentDefaultProviderName = p.name;
          break;
        }
      }
    }
  }

  return (
    <div className="main" data-testid="next-provider-page">
      <h2>{t(lang, 'provider_title')}</h2>
      <p className="lead">{t(lang, 'provider_subtitle')}</p>

      {/* 默认模型 */}
      <div className="sec">
        <div className="card def">
          <span className="l">
            <span>{t(lang, 'provider_default_title')}</span>
            <span>{t(lang, 'provider_default_hint')}</span>
          </span>
          <span
            className="pick"
            data-testid="next-provider-default-picker"
            onClick={() => setDefMenuOpen(!defMenuOpen)}
          >
            <span>{currentDefaultName}</span>
            {currentDefaultProviderName && <span className="from">{currentDefaultProviderName}</span>}
            {defMenuOpen && (
              <div className="menu" ref={defMenuRef} onClick={(e) => e.stopPropagation()}>
                {providers.map((p) => {
                  const enabledModels = p.models.filter((m) => m.enabled);
                  if (enabledModels.length === 0) return null;
                  return (
                    <div key={p.id}>
                      <div className="g">{p.name}</div>
                      {enabledModels.map((m) => (
                        <div
                          key={m.id}
                          className="i"
                          data-testid="next-provider-default-item"
                          onClick={() => void handleSelectDefault(p.id, m.id)}
                        >
                          <span>{m.name}</span>
                          <span className="x">{m.contextWindow ? formatNumber(m.contextWindow) : ''}</span>
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

      {/* 服务商列表 */}
      <div className="sec">
        <div className="sec-h">
          <b>{t(lang, 'provider_sec_title')}</b>
          <small>{t(lang, 'provider_sec_hint')}</small>
          <span className="sp" />
          <button
            type="button"
            className="btn"
            data-testid="next-provider-add"
            onClick={() => void handleOpenAdd()}
          >
            {t(lang, 'provider_add_button')}
          </button>
        </div>

        <div className="card">
          <div className="plist">
            <ProviderList
              providers={providers}
              openId={openId}
              onToggleOpen={(id) => setOpenId(openId === id ? null : id)}
              testing={testing}
              onTest={handleTest}
              onOpenRelogin={(p) => {
                const vendor = available.find((a) => a.id === p.id);
                if (vendor) {
                  setIsAddOpen(true);
                  void handleStartOAuth(vendor);
                }
              }}
              onKeyChange={async (id, apiKey) => {
                await patchProvider(id, { apiKey });
              }}
              onCustomEdit={async (id, data) => {
                await patchProvider(id, data);
              }}
              onDelete={handleDelete}
              lang={lang}
              onToggleModel={handleToggleModel}
              onSaveOverride={handleSaveOverride}
              onRefreshModels={handleTest}
            />
          </div>
        </div>
      </div>

      {/* Add Provider Dialog */}
      <AddProviderDialog
        lang={lang}
        isOpen={isAddOpen}
        onClose={handleCloseAdd}
        available={available}
        loginSession={loginSession}
        onAnswerOAuth={handleAnswerOAuth}
        onCancelOAuth={handleCancelOAuth}
        onConnectBuiltinKey={async (id, key) => {
          const res = await connectProvider(id, { method: 'api_key', apiKey: key }, lang);
          setOpenId(id);
          return res.provider.models;
        }}
        onConnectBuiltinEnv={async (id) => {
          const res = await connectProvider(id, { method: 'env' }, lang);
          setOpenId(id);
          return res.provider.models;
        }}
        onStartOAuth={handleStartOAuth}
        onConnectCustom={async (form) => {
          const res = await addCustomProvider(form, lang);
          setOpenId(res.provider.id);
          return res.provider.models;
        }}
        onFinish={handleFinishAdd}
      />
    </div>
  );
}
