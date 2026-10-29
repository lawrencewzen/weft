import { Fragment, useEffect, useRef, useState } from 'react';
import { BrandIcon, brandIconUrl } from '../BrandIcon';
import { formatTimeAgo } from '../../data/providerFormat';
import type { CustomApiProtocol, Provider } from '../../data/providerTypes';
import { t, type Lang } from '../../i18n';
import { ModelTable } from './ModelTable';

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

type Props = {
  providers: readonly Provider[];
  openId: string | null;
  onToggleOpen: (id: string) => void;
  testing: Record<string, boolean>;
  onTest: (id: string) => Promise<void>;
  onOpenRelogin: (p: Provider) => void;
  onKeyChange: (providerId: string, apiKey: string) => Promise<void>;
  onCustomEdit: (
    providerId: string,
    data: { name: string; baseUrl: string; api: CustomApiProtocol; apiKey?: string },
  ) => Promise<void>;
  onDelete: (p: Provider) => void;
  lang: Lang;
  onToggleModel: (providerId: string, modelId: string, enabled: boolean) => Promise<void>;
  onSaveOverride: (
    providerId: string,
    modelId: string,
    key: 'contextWindow' | 'maxTokens',
    value: string,
  ) => Promise<void>;
  onRefreshModels?: (providerId: string) => Promise<void>;
};

export function ProviderList({
  providers,
  openId,
  onToggleOpen,
  testing,
  onTest,
  onOpenRelogin,
  onKeyChange,
  onCustomEdit,
  onDelete,
  lang,
  onToggleModel,
  onSaveOverride,
  onRefreshModels,
}: Props) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Key change modal
  const [keyTarget, setKeyTarget] = useState<Provider | null>(null);
  const [newKey, setNewKey] = useState('');

  // Custom edit modal
  const [editTarget, setEditTarget] = useState<Provider | null>(null);
  const [editForm, setEditForm] = useState({
    name: '',
    baseUrl: '',
    api: 'openai-completions' as CustomApiProtocol,
    apiKey: '',
  });

  useEffect(() => {
    if (!menuId) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuId(null);
      }
    };
    window.addEventListener('mousedown', handleClick);
    return () => window.removeEventListener('mousedown', handleClick);
  }, [menuId]);

  const protoTag = (api?: CustomApiProtocol) => {
    if (!api) return null;
    let name = t(lang, 'provider_tag_openai_compat');
    if (api === 'anthropic-messages') name = t(lang, 'provider_tag_anthropic_compat');
    else if (api === 'openai-responses') name = t(lang, 'provider_tag_openai_responses');
    return <span className="tag">{name}</span>;
  };

  const renderAuth = (p: Provider) => {
    if (p.kind === 'custom') {
      return <>{t(lang, 'provider_auth_custom')}{p.baseUrl ? ` · ${p.baseUrl}` : ''}</>;
    }
    if (p.auth.type === 'oauth') {
      return <>{t(lang, 'provider_auth_account')}{p.auth.account ? ` · ${p.auth.account}` : ''}</>;
    }
    if (p.auth.type === 'env') {
      return <>{t(lang, 'provider_auth_env')} <span className="k">{p.auth.envVar}</span></>;
    }
    if (p.auth.type === 'api_key') {
      return <>API Key <span className="k">····{p.auth.keyTail}</span></>;
    }
    return t(lang, 'provider_auth_none');
  };

  const renderStatus = (p: Provider, isTesting: boolean) => {
    if (isTesting) {
      return (
        <span className="st run">
          <i />
          <span className="st-text">{t(lang, 'provider_status_run')}</span>
        </span>
      );
    }
    if (p.status.state === 'ok') {
      return (
        <span className="st ok">
          <i />
          <span className="st-text">{t(lang, 'provider_status_ok')}</span>
          {p.status.testedAt ? <small>{formatTimeAgo(p.status.testedAt, lang)}</small> : null}
        </span>
      );
    }
    if (p.status.state === 'error') {
      return (
        <span className="st bad">
          <i />
          <span className="st-text">{t(lang, 'provider_status_bad')}</span>
          {p.status.testedAt ? <small>{formatTimeAgo(p.status.testedAt, lang)}</small> : null}
        </span>
      );
    }
    return (
      <span className="st">
        <i />
        <span className="st-text">{t(lang, 'provider_status_untested')}</span>
      </span>
    );
  };

  return (
    <>
      {providers.map((p, i) => {
        const enabledCount = p.models.filter((m) => m.enabled).length;
        const isOpen = openId === p.id;
        const iconUrl = brandIconUrl(p.brand || p.id);
        const isTesting = Boolean(testing[p.id]);

        return (
          <Fragment key={p.id}>
            <div
              className={`prow ${i === 0 ? 'first' : ''} ${isOpen ? 'open' : ''}`}
              data-testid="next-provider-row"
              data-id={p.id}
              onClick={() => onToggleOpen(p.id)}
            >
              {/* Col 1: Icon (58px) */}
              <span className="c">
                <span className="av">
                  {iconUrl ? <BrandIcon brand={p.brand || p.id} size={18} /> : <span>{initial(p.name)}</span>}
                </span>
              </span>

              {/* Col 2: Name & Auth (1fr) */}
              <span className="c">
                <span className="pn">
                  <span className="n">
                    <span>{p.name}</span>
                    {p.kind === 'custom' ? protoTag(p.api) : null}
                    <svg className="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
                      <path d="M4.5 2.5 8 6l-3.5 3.5" />
                    </svg>
                  </span>
                  <span className="d">{renderAuth(p)}</span>
                </span>
              </span>

              {/* Col 3: Enabled Count (136px) */}
              <span className="c cnt">
                {t(lang, 'provider_enabled_summary', { enabled: enabledCount, total: p.models.length })}
              </span>

              {/* Col 4: Status (166px) */}
              <span className="c">{renderStatus(p, isTesting)}</span>

              {/* Col 5: Actions (146px) */}
              <span className="c" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="btn"
                  data-testid="next-provider-test"
                  disabled={isTesting}
                  onClick={() => void onTest(p.id)}
                >
                  {t(lang, 'provider_btn_test')}
                </button>
                <button
                  type="button"
                  className="more"
                  data-testid="next-provider-more"
                  onClick={() => setMenuId(menuId === p.id ? null : p.id)}
                >
                  ⋯
                  {menuId === p.id && (
                    <div className="pop" ref={menuRef}>
                      {p.auth.type === 'oauth' && (
                        <div
                          data-testid="next-provider-relogin"
                          onClick={() => { setMenuId(null); onOpenRelogin(p); }}
                        >
                          {t(lang, 'provider_act_relogin')}
                        </div>
                      )}
                      {p.kind === 'custom' && (
                        <div
                          data-testid="next-provider-edit"
                          onClick={() => {
                            setMenuId(null);
                            setEditTarget(p);
                            setEditForm({ name: p.name, baseUrl: p.baseUrl || '', api: p.api || 'openai-completions', apiKey: '' });
                          }}
                        >
                          {t(lang, 'provider_act_edit')}
                        </div>
                      )}
                      {p.auth.type === 'api_key' && (
                        <div
                          data-testid="next-provider-key"
                          onClick={() => { setMenuId(null); setKeyTarget(p); setNewKey(''); }}
                        >
                          {t(lang, 'provider_act_key')}
                        </div>
                      )}
                      <div
                        className="danger"
                        data-testid="next-provider-delete"
                        onClick={() => { setMenuId(null); onDelete(p); }}
                      >
                        {t(lang, 'provider_act_remove')}
                      </div>
                    </div>
                  )}
                </button>
              </span>
            </div>

            {isOpen && (
              <ModelTable
                provider={p}
                lang={lang}
                onToggleModel={onToggleModel}
                onSaveOverride={onSaveOverride}
                onRefreshModels={onRefreshModels}
                isRefreshing={isTesting}
              />
            )}
          </Fragment>
        );
      })}

      {/* Key Change Modal */}
      {keyTarget && (
        <div className="mask">
          <div className="dlg" style={{ width: 440 }}>
            <div className="dh">
              <b>{t(lang, 'provider_act_key')} · {keyTarget.name}</b>
              <button type="button" className="x" onClick={() => setKeyTarget(null)}>×</button>
            </div>
            <div className="db">
              <div className="form">
                <label className="lbl">{t(lang, 'dlg_key_label')}</label>
                <input
                  type="password"
                  className="inp"
                  data-testid="next-key-change-input"
                  value={newKey}
                  placeholder="sk-..."
                  onChange={(e) => setNewKey(e.target.value)}
                />
              </div>
            </div>
            <div className="df">
              <span style={{ flex: 1 }} />
              <button type="button" className="btn" onClick={() => setKeyTarget(null)}>
                {t(lang, 'dlg_cancel')}
              </button>
              <button
                type="button"
                className="btn pri"
                data-testid="next-key-change-submit"
                disabled={!newKey.trim()}
                onClick={async () => {
                  const id = keyTarget.id;
                  setKeyTarget(null);
                  await onKeyChange(id, newKey.trim());
                }}
              >
                {t(lang, 'dlg_finish')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Edit Modal */}
      {editTarget && (
        <div className="mask">
          <div className="dlg" style={{ width: 500 }}>
            <div className="dh">
              <b>{t(lang, 'provider_act_edit')} · {editTarget.name}</b>
              <button type="button" className="x" onClick={() => setEditTarget(null)}>×</button>
            </div>
            <div className="db">
              <div className="form">
                <label className="lbl">{t(lang, 'dlg_custom_name_label')}</label>
                <input
                  className="inp"
                  data-testid="next-custom-edit-name"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                />
                <label className="lbl">{t(lang, 'dlg_custom_url_label')}</label>
                <input
                  className="inp"
                  data-testid="next-custom-edit-url"
                  value={editForm.baseUrl}
                  onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })}
                />
                <label className="lbl">{t(lang, 'dlg_custom_proto_label')}</label>
                <select
                  className="inp"
                  data-testid="next-custom-edit-api"
                  value={editForm.api}
                  onChange={(e) => setEditForm({ ...editForm, api: e.target.value as CustomApiProtocol })}
                >
                  <option value="openai-completions">{t(lang, 'dlg_custom_proto_openai')}</option>
                  <option value="openai-responses">{t(lang, 'dlg_custom_proto_responses')}</option>
                  <option value="anthropic-messages">{t(lang, 'dlg_custom_proto_anthropic')}</option>
                </select>
                <label className="lbl">{t(lang, 'dlg_key_label')}</label>
                <input
                  type="password"
                  className="inp"
                  data-testid="next-custom-edit-key"
                  value={editForm.apiKey}
                  placeholder="sk-... (留空保持不变)"
                  onChange={(e) => setEditForm({ ...editForm, apiKey: e.target.value })}
                />
              </div>
            </div>
            <div className="df">
              <span style={{ flex: 1 }} />
              <button type="button" className="btn" onClick={() => setEditTarget(null)}>
                {t(lang, 'dlg_cancel')}
              </button>
              <button
                type="button"
                className="btn pri"
                data-testid="next-custom-edit-submit"
                disabled={!editForm.name.trim() || !editForm.baseUrl.trim()}
                onClick={async () => {
                  const id = editTarget.id;
                  setEditTarget(null);
                  await onCustomEdit(id, {
                    name: editForm.name.trim(),
                    baseUrl: editForm.baseUrl.trim(),
                    api: editForm.api,
                    ...(editForm.apiKey.trim() ? { apiKey: editForm.apiKey.trim() } : {}),
                  });
                }}
              >
                {t(lang, 'dlg_finish')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
