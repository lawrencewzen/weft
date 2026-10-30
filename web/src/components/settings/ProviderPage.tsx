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
    setLoginSession(null);
    try {
      const res = await getAvailableProviders(lang);
      setAvailable(res.providers);
    } catch {
      // ignore
    }
    setIsAddOpen(true);
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
    <div className="next-settings-content" data-testid="next-provider-page">
      <div className="next-settings-head">
        <h2>{t(lang, 'provider_title')}</h2>
      </div>

      {/* 默认模型 */}
      <div className="mp-sec">
        <div className="mp-card mp-def">
          <span className="mp-def-l">{t(lang, 'provider_default_title')}</span>
          <span
            className="mp-pick"
            data-testid="next-provider-default-picker"
            onClick={() => setDefMenuOpen(!defMenuOpen)}
          >
            <span>{currentDefaultName}</span>
            {currentDefaultProviderName && <span className="mp-from">{currentDefaultProviderName}</span>}
            {defMenuOpen && (
              <div className="mp-menu" ref={defMenuRef} onClick={(e) => e.stopPropagation()}>
                {providers.map((p) => {
                  const enabledModels = p.models.filter((m) => m.enabled);
                  if (enabledModels.length === 0) return null;
                  return (
                    <div key={p.id}>
                      <div className="mp-menu-g">{p.name}</div>
                      {enabledModels.map((m) => (
                        <div
                          key={m.id}
                          className="mp-menu-i"
                          data-testid="next-provider-default-item"
                          onClick={() => void handleSelectDefault(p.id, m.id)}
                        >
                          <span>{m.name}</span>
                          <span className="mp-menu-x">{m.contextWindow ? formatNumber(m.contextWindow) : ''}</span>
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

      {/* Provider 列表 */}
      <div className="mp-sec">
        <div className="mp-sec-h">
          <b>{t(lang, 'provider_sec_title')}</b>
          <span className="mp-sp" />
          <button
            type="button"
            className="mp-btn"
            data-testid="next-provider-add"
            onClick={() => void handleOpenAdd()}
          >
            {t(lang, 'provider_add_button')}
          </button>
        </div>

        <div className="mp-card">
          <div className="mp-plist">
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
        onStartOAuth={handleStartOAuth}
        onConnect={async (id, body) => {
          const res = await connectProvider(id, body, lang);
          setOpenId(id);
          return res.provider;
        }}
        onConnectCustom={async (form) => {
          const res = await addCustomProvider(form, lang);
          setOpenId(res.provider.id);
          return res.provider;
        }}
        onCreate={async (id, patch) => {
          await patchProvider(id, patch, lang);
          setOpenId(id);
        }}
        onRollback={async (ids) => {
          for (const id of ids) {
            try { await deleteProvider(id); } catch { /* already gone */ }
          }
        }}
      />
    </div>
  );
}
