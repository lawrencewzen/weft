import { useMemo, useState } from 'react';
import {
  createProvider,
  deleteProvider,
  patchProvider,
  testProvider,
  testProviderDraft,
  type ProviderModel,
  type ProviderProbeResult,
  type Vendor,
} from '../../data/api';
import type { Lang } from '../../data/lang';
import {
  brandFilters,
  buildCreateBody,
  buildPatchBody,
  buildTestDraftBody,
  canAdvance,
  canFinish,
  defaultWay,
  effectiveBaseUrl,
  filterModels,
  filterVendors,
  formatContextWindow,
  hostOf,
  modelsFromIds,
  shouldDiscardDraftOnCancel,
  vendorDocsUrl,
  waysForVendor,
  GROK_VENDOR_ID,
  type ConnectWay,
  type WizardState,
} from '../../data/providerWizard';
import { t } from '../../i18n';
import { BrandIcon } from '../BrandIcon';
import { GrokLogin } from './GrokLogin';

type Props = {
  lang: Lang;
  vendors: Vendor[];
  models: ProviderModel[];
  state: WizardState;
  onChange: (next: WizardState) => void;
  onDone: () => void;
  onCancel: () => void;
  onToast: (message: string) => void;
};

export async function cancelProviderWizard(state: WizardState): Promise<void> {
  if (!shouldDiscardDraftOnCancel(state) || !state.createdId) return;
  try { await deleteProvider(state.createdId); } catch { /* keep going */ }
}

function BackArrow() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M10.5 3.5 6 8l4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function accessWayDesc(lang: Lang, way: ConnectWay, vendor: Vendor): string {
  if (way === 'api_key') return t(lang, 'provider_way_api_key_desc', { name: vendor.name });
  if (way === 'account') return t(lang, 'provider_way_account_desc');
  if (way === 'custom_endpoint') return t(lang, 'provider_way_custom_desc', { proto: t(lang, 'provider_proto') });
  return t(lang, 'provider_way_agent_desc');
}

export function ProviderWizard({
  lang,
  vendors,
  models,
  state,
  onChange,
  onDone,
  onCancel,
  onToast,
}: Props) {
  const vendor = vendors.find((item) => item.id === state.vendorId) || null;
  const [probe, setProbe] = useState<ProviderProbeResult | null>(null);
  const [probeMs, setProbeMs] = useState<number | null>(null);
  const [probing, setProbing] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [manualId, setManualId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleVendors = useMemo(
    () => filterVendors(vendors, state.vendorQuery),
    [vendors, state.vendorQuery],
  );
  const ways = vendor ? waysForVendor(vendor) : [];
  const listedModels = models.length ? models : modelsFromIds(state.probedModelIds);
  const extraSelected = state.selectedModelIds
    .filter((id) => !listedModels.some((item) => item.id === id))
    .map((id) => modelsFromIds([id])[0]);
  const allModels = [...listedModels, ...extraSelected];
  const visibleModels = filterModels(allModels, {
    query: state.modelQuery,
    brand: state.brandFilter,
    selectedOnly: state.showSelectedOnly,
    selectedIds: state.selectedModelIds,
  });
  const brands = brandFilters(allModels);
  const grokWaiting = state.step === 2 && state.way === 'account' && !state.probeOk;

  function patch(partial: Partial<WizardState>) {
    onChange({ ...state, ...partial });
  }

  function pickVendor(next: Vendor) {
    const way = defaultWay(next);
    onChange({
      ...state,
      vendorId: next.id,
      way,
      name: state.nameTouched ? state.name : next.name,
      baseUrl: next.baseUrl,
      baseUrlTouched: false,
      probeOk: false,
      probedModelIds: [],
      advancedOpen: false,
    });
  }

  async function runTest() {
    if (!vendor) return;
    setProbing(true);
    setError(null);
    const started = Date.now();
    try {
      if (state.mode === 'edit' && state.createdId && !state.apiKeyEdited && !state.baseUrlTouched) {
        const saved = await testProvider(state.createdId, lang);
        setProbeMs(Date.now() - started);
        setProbe({
          ok: saved.status === 'ok',
          models: saved.models.map((item) => item.id),
          status: saved.status,
          statusText: saved.statusText,
        });
        patch({
          probeOk: saved.status === 'ok',
          probedModelIds: saved.models.map((item) => item.id),
        });
        return;
      }
      const result = await testProviderDraft(buildTestDraftBody(state, vendor), lang);
      setProbeMs(Date.now() - started);
      setProbe(result);
      patch({
        probeOk: result.ok,
        probedModelIds: result.models,
      });
    } catch (err) {
      setProbe({
        ok: false,
        models: [],
        status: 'error',
        statusText: err instanceof Error ? err.message : String(err),
      });
      patch({ probeOk: false });
    } finally {
      setProbing(false);
    }
  }

  async function goNext() {
    if (!canAdvance(state, vendor, state.way === 'account' && state.probeOk)) return;
    if (state.step === 1) {
      patch({ step: 2 });
      return;
    }
    if (state.step !== 2 || !vendor) return;
    setBusy(true);
    setError(null);
    try {
      if (state.mode === 'add' && vendor.id !== GROK_VENDOR_ID && !state.createdId) {
        const created = await createProvider({
          ...buildCreateBody({ ...state, selectedModelIds: state.probedModelIds }, vendor),
        }, lang);
        let saved = created;
        try {
          saved = await testProvider(created.id, lang);
        } catch {
          saved = created;
        }
        patch({
          step: 3,
          createdId: saved.id,
          selectedModelIds: [],
          probedModelIds: saved.models.map((item) => item.id).length
            ? saved.models.map((item) => item.id)
            : state.probedModelIds,
        });
      } else {
        patch({ step: 3 });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!canFinish(state)) return;
    setBusy(true);
    setError(null);
    try {
      if (state.createdId) {
        const body = buildPatchBody(state);
        await patchProvider(state.createdId, body, lang);
      } else if (vendor && vendor.id !== GROK_VENDOR_ID) {
        await createProvider(buildCreateBody(state, vendor), lang);
      } else if (state.createdId === null && vendor?.id === GROK_VENDOR_ID) {
        await patchProvider('grok', { models: state.selectedModelIds }, lang);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    await cancelProviderWizard(state);
    onCancel();
  }

  function goBackStep() {
    patch({ step: (state.step - 1) as 1 | 2 });
  }

  function headerBack() {
    if (state.step === 1) {
      void cancel();
      return;
    }
    goBackStep();
  }

  const crumbLeaf = state.step === 3 && vendor
    ? vendor.name
    : t(lang, state.mode === 'edit' ? 'provider_edit' : 'provider_add_leaf');

  function toggleModel(id: string) {
    const has = state.selectedModelIds.includes(id);
    patch({
      selectedModelIds: has
        ? state.selectedModelIds.filter((item) => item !== id)
        : [...state.selectedModelIds, id],
    });
  }

  function addManual() {
    const id = manualId.trim();
    if (!id) return;
    if (!state.selectedModelIds.includes(id)) {
      patch({
        selectedModelIds: [...state.selectedModelIds, id],
        probedModelIds: state.probedModelIds.includes(id) ? state.probedModelIds : [...state.probedModelIds, id],
      });
    }
    setManualId('');
  }

  const nextDisabled = state.step < 3
    ? !canAdvance(state, vendor, state.way === 'account' && state.probeOk) || probing || busy || grokWaiting
    : !canFinish(state) || busy;

  return (
    <div className="ns-wizard">
      <div className="ns-wizard-head">
        <div className="ns-wizard-title">
          <button
            type="button"
            className="ns-wizard-back"
            data-testid="next-wizard-back"
            aria-label={t(lang, 'provider_wizard_back')}
            onClick={headerBack}
          >
            <BackArrow />
          </button>
          <div>
            <div className="next-settings-crumb">
              <button
                type="button"
                className="next-settings-crumb-link"
                data-testid="next-provider-crumb"
                onClick={() => { void cancel(); }}
              >
                {t(lang, 'provider_title')}
              </button>
              <span className="next-settings-crumb-sep">/</span>
              <strong>{crumbLeaf}</strong>
            </div>
            {state.step === 3 && vendor ? (
              <>
                <div className="ns-grok-head">
                  <span className="ns-icon-box is-lg"><BrandIcon brand={vendor.brand} size={20} /></span>
                  <h2>{vendor.name}</h2>
                </div>
                <p className="next-settings-sub">
                  {state.mode === 'edit' ? t(lang, 'provider_models_edit_sub') : t(lang, 'provider_models_sub')}
                </p>
              </>
            ) : null}
          </div>
        </div>
        <div className="ns-steps" aria-hidden="true">
          {([
            [1, 'provider_step_vendor'],
            [2, 'provider_step_connect'],
            [3, 'provider_step_models'],
          ] as const).map(([n, key]) => (
            <span key={n} className={`ns-step${state.step === n ? ' is-on' : ''}${state.step > n ? ' is-done' : ''}`}>
              <span className="ns-step-num">{state.step > n ? '✓' : n}</span>
              {t(lang, key)}
            </span>
          ))}
        </div>
      </div>

      <div className="next-settings-content ns-wizard-body">
        {state.step === 1 ? (
          <>
            <input
              className="ns-search"
              value={state.vendorQuery}
              placeholder={t(lang, 'provider_vendor_search')}
              onChange={(ev) => patch({ vendorQuery: ev.target.value })}
            />
            <p className="ns-hint">{t(lang, 'provider_vendor_hint')}</p>
            <div className="ns-vendor-grid">
              {visibleVendors.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`ns-vendor-card${state.vendorId === item.id ? ' is-on' : ''}`}
                  data-testid="next-vendor-card"
                  data-vendor={item.id}
                  onClick={() => pickVendor(item)}
                >
                  <BrandIcon brand={item.brand} size={18} />
                  <span>{item.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {state.step === 2 && vendor ? (
          state.way === 'account' ? (
            <GrokLogin
              lang={lang}
              onToast={onToast}
              onSignedIn={() => {
                patch({
                  step: 3,
                  probeOk: true,
                  createdId: GROK_VENDOR_ID,
                  way: 'account',
                });
              }}
            />
          ) : (
            <div className="ns-connect">
              <div className="ns-ways">
                <h3>{t(lang, 'provider_way_title')}</h3>
                {ways.map((way) => (
                  <button
                    key={way.id}
                    type="button"
                    className={`ns-way${state.way === way.id ? ' is-on' : ''}${way.enabled ? '' : ' is-off'}`}
                    data-testid={`next-way-${way.id}`}
                    disabled={!way.enabled}
                    onClick={() => {
                      if (!way.enabled) return;
                      patch({ way: way.id, probeOk: false });
                      setProbe(null);
                    }}
                  >
                    <span className="ns-radio" />
                    <span className="ns-way-text">
                      <b>
                        {t(lang, way.id === 'api_key' ? 'provider_way_api_key'
                          : way.id === 'custom_endpoint' ? 'provider_way_custom'
                            : way.id === 'account' ? 'provider_way_account'
                              : 'provider_way_agent')}
                        {!way.enabled ? <span className="ns-tag is-coming">{t(lang, 'provider_coming')}</span> : null}
                      </b>
                      <span>{accessWayDesc(lang, way.id, vendor)}</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="ns-connect-split" />
              <div className="ns-form">
                {state.way === 'custom_endpoint' ? (
                  <>
                    <div className="ns-field">
                      <label>{t(lang, 'provider_url_label')}</label>
                      <input
                        className="ns-input is-mono"
                        data-testid="next-provider-url"
                        value={state.baseUrl}
                        placeholder={t(lang, 'provider_url_placeholder')}
                        onChange={(ev) => patch({
                          baseUrl: ev.target.value,
                          baseUrlTouched: true,
                          probeOk: false,
                        })}
                      />
                      <div className="ns-field-hint">{t(lang, 'provider_url_hint', { proto: t(lang, 'provider_proto') })}</div>
                    </div>
                    <KeyFields
                      lang={lang}
                      vendor={vendor}
                      state={state}
                      showKey={showKey}
                      onShow={setShowKey}
                      onChange={patch}
                    />
                    <NameField lang={lang} state={state} onChange={patch} />
                    <TestPanel
                      lang={lang}
                      vendor={vendor}
                      probing={probing}
                      probe={probe}
                      probeMs={probeMs}
                      onTest={() => { void runTest(); }}
                    />
                  </>
                ) : (
                  <div className="ns-form-grid">
                    <div className="ns-form-main">
                      <KeyFields
                        lang={lang}
                        vendor={vendor}
                        state={state}
                        showKey={showKey}
                        onShow={setShowKey}
                        onChange={patch}
                      />
                      <NameField lang={lang} state={state} onChange={patch} />
                      <details
                        className="ns-advanced"
                        open={state.advancedOpen}
                        onToggle={(ev) => patch({ advancedOpen: (ev.target as HTMLDetailsElement).open })}
                      >
                        <summary>{t(lang, 'provider_advanced', { url: effectiveBaseUrl(state, vendor) || '—' })}</summary>
                        <div className="ns-field" style={{ marginTop: 8 }}>
                          <input
                            className="ns-input is-mono"
                            value={state.baseUrl}
                            onChange={(ev) => patch({
                              baseUrl: ev.target.value,
                              baseUrlTouched: true,
                              probeOk: false,
                            })}
                          />
                        </div>
                      </details>
                    </div>
                    <div className="ns-test-col">
                      <TestPanel
                        lang={lang}
                        vendor={vendor}
                        probing={probing}
                        probe={probe}
                        probeMs={probeMs}
                        onTest={() => { void runTest(); }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        ) : null}

        {state.step === 3 ? (
          <>
            <div className="ns-filters">
              <button
                type="button"
                className={`ns-chip${state.brandFilter == null ? ' is-on' : ''}`}
                data-testid="next-model-filter"
                data-brand="all"
                onClick={() => patch({ brandFilter: null })}
              >
                {t(lang, 'provider_models_filter_all')}
              </button>
              {brands.map((brand) => (
                <button
                  key={brand.id}
                  type="button"
                  className={`ns-chip${state.brandFilter === brand.id ? ' is-on' : ''}`}
                  data-testid="next-model-filter"
                  data-brand={brand.id}
                  onClick={() => patch({ brandFilter: brand.id })}
                >
                  {brand.name} {brand.count}
                </button>
              ))}
              <input
                className="ns-search"
                value={state.modelQuery}
                placeholder={t(lang, 'provider_models_search')}
                onChange={(ev) => patch({ modelQuery: ev.target.value })}
              />
            </div>
            <div className="ns-model-list">
              {visibleModels.map((model) => {
                const on = state.selectedModelIds.includes(model.id);
                return (
                  <div
                    key={model.id}
                    className={`ns-model-row${on ? ' is-on' : ''}`}
                    data-testid="next-model-row"
                    data-model={model.id}
                  >
                    <BrandIcon brand={model.brand} size={16} />
                    <div className="ns-model-main">
                      <b>{model.displayName}</b>
                      <span>{model.id}</span>
                    </div>
                    <span className="ns-model-ctx">{model.contextWindow ? formatContextWindow(model.contextWindow) : ''}</span>
                    <button
                      type="button"
                      className={`ns-switch${on ? ' is-on' : ''}`}
                      aria-label={t(lang, 'provider_models_add')}
                      aria-pressed={on}
                      onClick={() => toggleModel(model.id)}
                    />
                  </div>
                );
              })}
            </div>
            <div className="ns-manual">
              <input
                className="ns-input is-mono"
                value={manualId}
                placeholder={t(lang, 'provider_models_manual')}
                onChange={(ev) => setManualId(ev.target.value)}
                onKeyDown={(ev) => { if (ev.key === 'Enter') addManual(); }}
              />
              <button type="button" className="ns-btn" onClick={addManual}>{t(lang, 'provider_models_add')}</button>
            </div>
          </>
        ) : null}

        {error ? <div className="ns-test-card is-bad" style={{ marginTop: 12 }}>{error}</div> : null}
      </div>

      <div className="ns-foot" data-testid="next-wizard-foot">
        <div className="ns-foot-hint">
          {state.step === 1 && vendor ? t(lang, 'provider_selected_vendor', { name: vendor.name }) : null}
          {state.step === 2 && state.way !== 'account' ? t(lang, 'provider_test_required') : null}
          {state.step === 3 ? (
            <>
              {t(lang, 'provider_models_selected', { n: state.selectedModelIds.length })}
              {' · '}
              <button
                type="button"
                className={`ns-field-link${state.showSelectedOnly ? ' is-on' : ''}`}
                onClick={() => patch({ showSelectedOnly: !state.showSelectedOnly })}
              >
                {t(lang, 'provider_models_only')}
              </button>
            </>
          ) : null}
        </div>
        <div className="ns-foot-acts">
          {state.step === 1 || (state.mode === 'edit' && state.step === 2) ? (
            <button type="button" className="ns-btn" onClick={() => { void cancel(); }}>{t(lang, 'btn_cancel')}</button>
          ) : (
            <button
              type="button"
              className="ns-btn"
              onClick={goBackStep}
            >
              {t(lang, 'provider_back')}
            </button>
          )}
          {state.step < 3 ? (
            <button
              type="button"
              className="ns-btn ns-btn-primary"
              disabled={nextDisabled}
            onClick={() => { void goNext(); }}
            >
              {grokWaiting ? t(lang, 'grok_wait_btn') : t(lang, 'provider_next')}
            </button>
          ) : (
            <button
              type="button"
              className="ns-btn ns-btn-primary"
              data-testid="next-provider-finish"
              disabled={nextDisabled}
              onClick={() => { void finish(); }}
            >
              {state.mode === 'edit' ? t(lang, 'provider_save') : t(lang, 'provider_finish')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function NameField({
  lang, state, onChange,
}: {
  lang: Lang;
  state: WizardState;
  onChange: (partial: Partial<WizardState>) => void;
}) {
  return (
    <div className="ns-field">
      <label>{t(lang, 'provider_name_label')}</label>
      <input
        className="ns-input"
        data-testid="next-provider-name"
        value={state.name}
        onChange={(ev) => onChange({ name: ev.target.value, nameTouched: true })}
      />
      <div className="ns-field-hint">{t(lang, 'provider_name_hint')}</div>
    </div>
  );
}

function KeyFields({
  lang, vendor, state, showKey, onShow, onChange,
}: {
  lang: Lang;
  vendor: Vendor;
  state: WizardState;
  showKey: boolean;
  onShow: (on: boolean) => void;
  onChange: (partial: Partial<WizardState>) => void;
}) {
  const docs = vendorDocsUrl(vendor);
  return (
    <div className="ns-field">
      <label>
        {t(lang, 'provider_key_label')}
        {docs ? (
          <a className="ns-field-link" href={docs} target="_blank" rel="noreferrer">
            {t(lang, 'provider_key_get', { name: vendor.name })}
          </a>
        ) : null}
      </label>
      <div className="ns-key-wrap">
        <input
          className="ns-key"
          data-testid="next-key-input"
          type={showKey ? 'text' : 'password'}
          autoComplete="off"
          value={state.apiKey}
          onChange={(ev) => onChange({ apiKey: ev.target.value, apiKeyEdited: true, probeOk: false })}
        />
        <button type="button" className="ns-btn" onClick={() => onShow(!showKey)}>
          {t(lang, showKey ? 'provider_hide' : 'provider_show')}
        </button>
      </div>
      <div className="ns-field-hint">{t(lang, 'provider_key_hint')}</div>
    </div>
  );
}

function TestPanel({
  lang, vendor, probing, probe, probeMs, onTest,
}: {
  lang: Lang;
  vendor: Vendor;
  probing: boolean;
  probe: ProviderProbeResult | null;
  probeMs: number | null;
  onTest: () => void;
}) {
  const host = hostOf(vendor.baseUrl);
  return (
    <div className="ns-test-panel">
      <h3>{t(lang, 'provider_test')}</h3>
      <button
        type="button"
        className="ns-btn"
        data-testid="next-provider-test"
        disabled={probing}
        onClick={onTest}
      >
        {probing ? t(lang, 'provider_testing') : (probe ? t(lang, 'provider_retest') : t(lang, 'provider_test'))}
      </button>
      {probe ? (
        <div
          className={`ns-test-card ${probe.ok ? 'is-ok' : 'is-bad'}`}
          data-testid="next-test-result"
        >
          <b>
            {probe.ok
              ? t(lang, 'provider_test_ok', { n: probe.models.length })
              : (probe.statusText || t(lang, 'provider_status_untested'))}
          </b>
          <span>
            {probe.ok
              ? t(lang, 'provider_test_ok_meta', { ms: probeMs ?? 0 })
              : t(lang, 'provider_test_fail_hint', { host: host || vendor.name })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
