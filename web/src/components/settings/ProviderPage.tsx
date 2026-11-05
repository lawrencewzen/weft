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
import { Dropdown } from '../ui/Dropdown';
import { AddProviderDialog } from './AddProviderDialog';
import { ProviderList } from './ProviderList';

type Props = {
  lang: Lang;
  onToast?: (message: string) => void;
  onConfirm?: (opts: ConfirmOpts) => Promise<boolean>;
  providersNavSeq?: number;
  customOnly?: boolean;
};

export function ProviderPage({ lang, onConfirm, customOnly }: Props) {
  const { providers, defaultModel } = useProviders();

  const [openId, setOpenId] = useState<string | null>('deepseek');
  const [testing, setTesting] = useState<Record<string, boolean>>({});

  // Add dialog state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Provider | null>(null);
  const [available, setAvailable] = useState<Available[]>([]);
  const [loginSession, setLoginSession] = useState<LoginSession | null>(null);
  const sessionPollRef = useRef<number | null>(null);
  const oauthTabRef = useRef<Window | null>(null);

  useEffect(() => {
    return () => {
      if (sessionPollRef.current) window.clearTimeout(sessionPollRef.current);
      closeOAuthTab();
    };
  }, []);

  const handleOpenAdd = async () => {
    closeOAuthTab();
    setLoginSession(null);
    setEditTarget(null);
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
    await patchProvider(providerId, { defaultModel: modelId });
  };

  // OAuth Session flow & tab management
  const openOAuthTab = () => {
    try {
      const popup = window.open('', '_blank');
      if (popup) {
        try {
          const text = t(lang, 'dlg_oauth_redirecting');
          popup.document.title = text;
          const doc = popup.document;
          if (doc && doc.body) {
            while (doc.body.firstChild) {
              doc.body.removeChild(doc.body.firstChild);
            }
            const div = doc.createElement('div');
            div.textContent = text;
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.justifyContent = 'center';
            div.style.height = '100vh';
            div.style.margin = '0';
            div.style.color = '#555';
            div.style.fontFamily = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            doc.body.appendChild(div);
          }
        } catch {
          // ignore
        }
        try {
          popup.opener = null;
        } catch {
          // ignore
        }
        oauthTabRef.current = popup;
      } else {
        oauthTabRef.current = null;
      }
    } catch {
      oauthTabRef.current = null;
    }
  };

  const redirectOAuthTab = (session: LoginSession | null | undefined) => {
    const tab = oauthTabRef.current;
    if (!tab) return;
    if (!session?.events) return;

    const deviceEvt = session.events.find(
      (e): e is { type: 'device_code'; userCode: string; verificationUri: string } => e.type === 'device_code',
    );
    const authUrlEvt = session.events.find(
      (e): e is { type: 'auth_url'; url: string; instructions?: string } => e.type === 'auth_url',
    );

    const targetUrl = deviceEvt?.verificationUri || authUrlEvt?.url;
    if (targetUrl) {
      try {
        if (!tab.closed) {
          tab.location.href = targetUrl;
        }
      } catch {
        // ignore
      }
      oauthTabRef.current = null;
    }
  };

  const closeOAuthTab = () => {
    const tab = oauthTabRef.current;
    if (tab) {
      try {
        if (!tab.closed) {
          tab.close();
        }
      } catch {
        // ignore
      }
      oauthTabRef.current = null;
    }
  };

  const pollSession = (sid: string) => {
    if (sessionPollRef.current) window.clearTimeout(sessionPollRef.current);
    sessionPollRef.current = window.setTimeout(async () => {
      try {
        const res = await getLoginSession(sid, lang);
        const s = (res as { session?: LoginSession }).session || (res as unknown as LoginSession);
        setLoginSession(s);
        if (s?.state === 'error') {
          closeOAuthTab();
        } else {
          redirectOAuthTab(s);
        }
        if (s && (s.state === 'pending' || s.state === 'prompt')) pollSession(sid);
      } catch {
        // ignore
      }
    }, 1000);
  };

  const handleStartOAuth = async (vendor: Available) => {
    openOAuthTab();
    try {
      const res = await connectProviderOAuth(vendor.id, lang);
      setLoginSession(res.session);
      if (res.session.state === 'error') {
        closeOAuthTab();
      } else {
        redirectOAuthTab(res.session);
      }
      pollSession(res.session.id);
    } catch (err) {
      closeOAuthTab();
      setLoginSession({
        id: '',
        providerId: vendor.id,
        state: 'error',
        events: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleAnswerOAuth = async (input: string) => {
    if (!loginSession) return;
    try {
      const res = await answerLoginSession(loginSession.id, input, lang);
      setLoginSession(res.session);
      if (res.session.state === 'error') {
        closeOAuthTab();
      } else {
        redirectOAuthTab(res.session);
      }
      if (res.session.state === 'pending' || res.session.state === 'prompt') pollSession(res.session.id);
    } catch (err) {
      closeOAuthTab();
      throw err;
    }
  };

  const handleCancelOAuth = async () => {
    closeOAuthTab();
    if (!loginSession) return;
    if (sessionPollRef.current) window.clearTimeout(sessionPollRef.current);
    await cancelLoginSession(loginSession.id, lang);
    setLoginSession(null);
  };

  const handleCloseAdd = () => {
    closeOAuthTab();
    setIsAddOpen(false);
    setEditTarget(null);
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

  const totalEnabledModels = providers.reduce(
    (acc, p) => acc + p.models.filter((m) => m.enabled).length,
    0,
  );
  const noEnabledModels = totalEnabledModels === 0;

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
          <Dropdown
            variant="picker"
            align="right"
            minWidth={300}
            triggerTestId="next-provider-default-picker"
            triggerClassName="mp-pick"
            disabled={noEnabledModels}
            value={defaultModel ? `${defaultModel.providerId}:${defaultModel.modelId}` : undefined}
            onSelect={(val) => {
              const colonIdx = val.indexOf(':');
              const pId = val.slice(0, colonIdx);
              const mId = val.slice(colonIdx + 1);
              void handleSelectDefault(pId, mId);
            }}
            triggerContent={
              <>
                <span>{currentDefaultName}</span>
                {currentDefaultProviderName ? <span className="mp-from">{currentDefaultProviderName}</span> : null}
              </>
            }
            items={providers
              .filter((p) => p.models.some((m) => m.enabled))
              .map((p) => ({
                groupLabel: p.name,
                options: p.models
                  .filter((m) => m.enabled)
                  .map((m) => ({
                    value: `${p.id}:${m.id}`,
                    label: m.name,
                    extra: m.contextWindow ? formatNumber(m.contextWindow) : '',
                    testId: 'next-provider-default-item',
                  })),
              }))}
          />
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
                const vendor = available.find((a) => a.id === p.id) || ({ id: p.id, name: p.name, authMethods: ['oauth'] } as Available);
                setIsAddOpen(true);
                void handleStartOAuth(vendor);
              }}
              onKeyChange={async (id, apiKey) => {
                await patchProvider(id, { apiKey });
              }}
              onCustomEdit={async (id, data) => {
                await patchProvider(id, data);
              }}
              onEditProvider={(p) => {
                setEditTarget(p);
                setIsAddOpen(true);
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

      {/* Add / Edit Provider Dialog */}
      <AddProviderDialog
        lang={lang}
        isOpen={isAddOpen}
        onClose={handleCloseAdd}
        editTarget={editTarget}
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
        onSaveEdit={async (id, patch) => {
          await patchProvider(id, patch, lang);
          setOpenId(id);
        }}
        onTest={async (id) => {
          await testProvider(id, lang);
        }}
        onRollback={async (ids) => {
          for (const id of ids) {
            try { await deleteProvider(id); } catch { /* already gone */ }
          }
        }}
        customOnly={customOnly}
      />
    </div>
  );
}
