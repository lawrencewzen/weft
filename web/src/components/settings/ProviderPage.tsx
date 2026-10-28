import { useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteProvider,
  patchProvider,
  testProvider,
  type Provider,
} from '../../data/api';
import type { Lang } from '../../data/lang';
import type { ConfirmOpts } from '../ConfirmDialog';
import {
  blankWizard,
  formatContextWindow,
  hostOf,
  isGrokProvider,
  keyTail,
  statusKind,
  vendorForProvider,
  wizardFromProvider,
  type WizardState,
} from '../../data/providerWizard';
import { useProviders } from '../../data/useProviders';
import { t } from '../../i18n';
import { BrandIcon } from '../BrandIcon';
import { cancelProviderWizard, ProviderWizard } from './ProviderWizard';

type Props = {
  lang: Lang;
  onToast: (message: string) => void;
  onConfirm: (opts: ConfirmOpts) => Promise<boolean>;
  providersNavSeq?: number;
};

type View = { kind: 'list' } | { kind: 'wizard'; state: WizardState };

function accessTag(access: Provider['access']): { cls: string; key: 'provider_access_api_key' | 'provider_access_account' | 'provider_access_local' | 'provider_access_custom' } {
  if (access === 'account') return { cls: 'is-account', key: 'provider_access_account' };
  if (access === 'local') return { cls: 'is-local', key: 'provider_access_local' };
  if (access === 'custom_endpoint') return { cls: 'is-key', key: 'provider_access_custom' };
  return { cls: 'is-key', key: 'provider_access_api_key' };
}

function detailOf(provider: Provider, lang: Lang): string {
  if (provider.access === 'account') return t(lang, 'provider_detail_account');
  const host = hostOf(provider.baseUrl);
  if (provider.access === 'local') {
    return [host, t(lang, 'provider_detail_ollama')].filter(Boolean).join(' · ');
  }
  const parts: string[] = [];
  const tail = keyTail(provider.keyMasked);
  if (tail) parts.push(t(lang, 'provider_detail_key', { tail }));
  if (host) parts.push(host);
  return parts.join(' · ');
}

function statusLabel(provider: Provider, lang: Lang): string {
  if (provider.statusText) return provider.statusText;
  if (provider.status === 'ok') return t(lang, 'provider_status_ok');
  return t(lang, 'provider_status_untested');
}

export function ProviderPage({ lang, onToast, onConfirm, providersNavSeq = 0 }: Props) {
  const { providers, defaultModel, vendors } = useProviders();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    if (!providersNavSeq) return;
    const current = viewRef.current;
    if (current.kind !== 'wizard') return;
    void (async () => {
      await cancelProviderWizard(current.state);
      setView({ kind: 'list' });
    })();
  }, [providersNavSeq]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (ev: MouseEvent) => {
      if (!menuRef.current?.contains(ev.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const defaultEntry = useMemo(() => {
    if (!defaultModel) return null;
    const source = providers.find((item) => item.id === defaultModel.providerId);
    const model = source?.models.find((item) => item.id === defaultModel.modelId);
    if (!source || !model) return null;
    return { source, model };
  }, [defaultModel, providers]);

  const wizardProvider = view.kind === 'wizard' && view.state.createdId
    ? providers.find((item) => item.id === view.state.createdId) || null
    : null;
  const wizardModels = wizardProvider?.models || [];

  if (view.kind === 'wizard') {
    return (
      <ProviderWizard
        lang={lang}
        vendors={vendors}
        models={wizardModels}
        state={view.state}
        onChange={(state) => setView({ kind: 'wizard', state })}
        onDone={() => setView({ kind: 'list' })}
        onCancel={() => setView({ kind: 'list' })}
        onToast={onToast}
      />
    );
  }

  async function retry(provider: Provider) {
    try {
      await testProvider(provider.id, lang);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(provider: Provider) {
    if (isGrokProvider(provider)) return;
    const ok = await onConfirm({
      title: t(lang, 'provider_delete_title', { name: provider.name }),
      message: t(lang, 'provider_delete_message'),
      confirmLabel: t(lang, 'provider_delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteProvider(provider.id);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  }

  async function setDefault(providerId: string, modelId: string) {
    try {
      await patchProvider(providerId, { defaultModel: modelId }, lang);
      setMenuOpen(false);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="next-settings-content">
      <div className="next-settings-head">
        <div>
          <h2>{t(lang, 'provider_title')}</h2>
          <p className="next-settings-sub">{t(lang, 'provider_subtitle')}</p>
        </div>
        <button
          type="button"
          className="ns-btn"
          data-testid="next-provider-add"
          onClick={() => setView({ kind: 'wizard', state: blankWizard('add') })}
        >
          {t(lang, 'provider_add')}
        </button>
      </div>
      <div className="ns-provider-table">
        {providers.length === 0 ? (
          <div className="ns-empty">{t(lang, 'provider_none')}</div>
        ) : providers.map((provider) => {
          const tag = accessTag(provider.access);
          const kind = statusKind(provider.status);
          const grok = isGrokProvider(provider);
          return (
            <div
              key={provider.id}
              className="ns-provider-row"
              data-testid="next-provider-row"
              data-provider-id={provider.id}
            >
              <span className="ns-icon-box">
                <BrandIcon brand={provider.vendor} size={16} />
              </span>
              <div className="ns-provider-main">
                <div className="ns-provider-name">
                  <span>{provider.name}</span>
                  <span className={`ns-tag ${tag.cls}`}>{t(lang, tag.key)}</span>
                </div>
                <div className="ns-provider-detail">{detailOf(provider, lang)}</div>
              </div>
              <div className="ns-provider-models">{t(lang, 'provider_enabled_count', { n: provider.models.length })}</div>
              <div className={`ns-provider-status is-${kind}`}>
                <span className={`ns-dot is-${kind}`} />
                {statusLabel(provider, lang)}
              </div>
              <div className="ns-provider-acts">
                {kind === 'bad' && !grok ? (
                  <button type="button" className="ns-btn" onClick={() => { void retry(provider); }}>
                    {t(lang, 'provider_retry')}
                  </button>
                ) : grok && (kind === 'warn' || kind === 'bad') ? (
                  <button
                    type="button"
                    className="ns-btn"
                    onClick={() => {
                      const next = wizardFromProvider(provider);
                      next.vendorId = 'grok';
                      next.way = 'account';
                      next.step = 2;
                      next.probeOk = false;
                      setView({ kind: 'wizard', state: next });
                    }}
                  >
                    {t(lang, 'provider_relogin')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ns-btn"
                    data-testid="next-provider-edit"
                    onClick={() => {
                      const matched = vendorForProvider(provider, vendors);
                      const next = wizardFromProvider(provider);
                      if (matched) next.vendorId = matched.id;
                      if (grok) next.step = 3;
                      setView({ kind: 'wizard', state: next });
                    }}
                  >
                    {t(lang, 'provider_edit')}
                  </button>
                )}
                {kind === 'bad' && !grok ? (
                  <button
                    type="button"
                    className="ns-btn ns-btn-ghost"
                    data-testid="next-provider-edit"
                    onClick={() => {
                      const matched = vendorForProvider(provider, vendors);
                      const next = wizardFromProvider(provider);
                      if (matched) next.vendorId = matched.id;
                      setView({ kind: 'wizard', state: next });
                    }}
                  >
                    {t(lang, 'provider_edit')}
                  </button>
                ) : null}
                {grok && kind !== 'warn' && kind !== 'bad' ? (
                  <button
                    type="button"
                    className="ns-btn ns-btn-ghost"
                    onClick={() => {
                      const next = wizardFromProvider(provider);
                      next.vendorId = 'grok';
                      next.way = 'account';
                      next.step = 2;
                      next.probeOk = false;
                      setView({ kind: 'wizard', state: next });
                    }}
                  >
                    {t(lang, 'provider_relogin')}
                  </button>
                ) : null}
                {!grok ? (
                  <button
                    type="button"
                    className="ns-btn ns-btn-ghost"
                    data-testid="next-provider-delete"
                    onClick={() => { void remove(provider); }}
                  >
                    {t(lang, 'provider_delete')}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="ns-default">
        <div className="ns-default-label">
          {t(lang, 'provider_default_title')}
          <span className="ns-default-hint">{t(lang, 'provider_default_hint')}</span>
        </div>
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className="ns-default-btn"
            data-testid="next-default-model"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {defaultEntry ? (
              <>
                <BrandIcon brand={defaultEntry.model.brand} size={14} />
                <span className="ns-default-name">{defaultEntry.model.displayName}</span>
                <span className="ns-default-from">{t(lang, 'provider_from', { name: defaultEntry.source.name })}</span>
              </>
            ) : (
              <span className="ns-default-name">{t(lang, 'provider_default_empty')}</span>
            )}
            <span className="ns-caret">▾</span>
          </button>
          {menuOpen ? (
            <div className="ns-pop">
              {providers.flatMap((source) => source.models.map((model) => {
                const on = defaultModel?.providerId === source.id && defaultModel.modelId === model.id;
                return (
                  <button
                    key={`${source.id}:${model.id}`}
                    type="button"
                    className={`ns-pop-item${on ? ' is-on' : ''}`}
                    onClick={() => { void setDefault(source.id, model.id); }}
                  >
                    <BrandIcon brand={model.brand} size={14} />
                    <span className="ns-pop-main">
                      <b>{model.displayName}</b>
                      <span>{model.id} · {formatContextWindow(model.contextWindow)} · {source.name}</span>
                    </span>
                  </button>
                );
              }))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
