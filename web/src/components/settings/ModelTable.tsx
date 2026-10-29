import { useState } from 'react';
import { formatNumber } from '../../data/providerFormat';
import type { Provider } from '../../data/providerTypes';
import { t, type Lang } from '../../i18n';

type Props = {
  provider: Provider;
  lang: Lang;
  onToggleModel: (providerId: string, modelId: string, enabled: boolean) => Promise<void>;
  onSaveOverride: (
    providerId: string,
    modelId: string,
    key: 'contextWindow' | 'maxTokens',
    value: string,
  ) => Promise<void>;
  onRefreshModels?: (providerId: string) => Promise<void>;
  isRefreshing?: boolean;
};

export function ModelTable({
  provider,
  lang,
  onToggleModel,
  onSaveOverride,
  onRefreshModels,
  isRefreshing,
}: Props) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingVal, setEditingVal] = useState<string>('');

  const unknownCount = provider.models.filter((m) => m.contextWindow == null).length;

  const handleStartEdit = (
    modelId: string,
    key: 'contextWindow' | 'maxTokens',
    currentVal: number | null,
  ) => {
    setEditingKey(`${provider.id}:${modelId}:${key}`);
    setEditingVal(currentVal == null ? '' : String(currentVal));
  };

  const handleCommitEdit = async (
    modelId: string,
    key: 'contextWindow' | 'maxTokens',
    val: string,
  ) => {
    setEditingKey(null);
    await onSaveOverride(provider.id, modelId, key, val);
  };

  const renderNumCell = (
    modelId: string,
    key: 'contextWindow' | 'maxTokens',
    val: number | null,
    isOverridden: boolean,
  ) => {
    const isEditing = editingKey === `${provider.id}:${modelId}:${key}`;
    if (isEditing) {
      return (
        <span className="mp-c mp-num">
          <input
            autoFocus
            data-testid={key === 'contextWindow' ? 'next-ctx-input' : undefined}
            value={editingVal}
            placeholder={key === 'contextWindow' ? '131072' : '4096'}
            onChange={(e) => setEditingVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void handleCommitEdit(modelId, key, editingVal);
              } else if (e.key === 'Escape') {
                setEditingKey(null);
              }
            }}
            onBlur={() => void handleCommitEdit(modelId, key, editingVal)}
          />
        </span>
      );
    }

    const isUnk = val == null;
    const cls = isOverridden ? 'mp-v mp-cus' : isUnk ? 'mp-v mp-unk' : 'mp-v';
    const title = isUnk
      ? t(lang, 'model_title_unknown')
      : isOverridden
      ? t(lang, 'model_title_overridden')
      : t(lang, 'model_title_default');

    return (
      <span className="mp-c mp-num">
        <span
          className={cls}
          title={title}
          onClick={(e) => {
            e.stopPropagation();
            handleStartEdit(modelId, key, val);
          }}
        >
          {isUnk ? t(lang, 'model_unknown') : formatNumber(val)}
        </span>
      </span>
    );
  };

  return (
    <div className="mp-models">
      {provider.status.state === 'error' && provider.status.error && (
        <div className="mp-err" data-testid="next-test-result">
          {provider.status.error}
        </div>
      )}

      <div className="mp-mt">
        <span className="mp-mt-h">{t(lang, 'model_th_name')}</span>
        <span className="mp-mt-h mp-r">{t(lang, 'model_th_context')}</span>
        <span className="mp-mt-h mp-r">{t(lang, 'model_th_max_tokens')}</span>
        <span className="mp-mt-h">{t(lang, 'model_th_caps')}</span>
        <span className="mp-mt-h mp-r mp-last">{t(lang, 'model_th_enabled')}</span>

        {provider.models.map((m) => {
          const hasCaps = m.images || m.reasoning;
          const isOverriddenCtx = Boolean(m.overridden?.contextWindow);
          const isOverriddenMax = Boolean(m.overridden?.maxTokens);

          return (
            <div key={m.id} style={{ display: 'contents' }} data-testid="next-model-row" data-model={m.id}>
              {/* Col 1: Model name & id */}
              <span className="mp-c">
                <span className={`mp-mt-mn ${m.enabled ? '' : 'mp-mt-off'}`}>
                  <span className="mp-mt-nm">{m.name}</span>
                  {m.name !== m.id ? <span className="mp-mt-id">{m.id}</span> : null}
                </span>
              </span>

              {/* Col 2: Context Window */}
              {renderNumCell(m.id, 'contextWindow', m.contextWindow, isOverriddenCtx)}

              {/* Col 3: Max Tokens */}
              {renderNumCell(m.id, 'maxTokens', m.maxTokens, isOverriddenMax)}

              {/* Col 4: Capabilities */}
              <span className="mp-c">
                {hasCaps ? (
                  <span className="mp-caps">
                    {m.images && <span>{t(lang, 'model_cap_images')}</span>}
                    {m.reasoning && <span>{t(lang, 'model_cap_reasoning')}</span>}
                  </span>
                ) : (
                  <span style={{ color: 'var(--faint)' }}>—</span>
                )}
              </span>

              {/* Col 5: Enable Switch */}
              <span className="mp-c mp-last">
                <button
                  type="button"
                  className={`mp-sw ${m.enabled ? 'mp-on' : ''}`}
                  data-testid="next-model-toggle"
                  title={t(lang, m.enabled ? 'model_toggle_on' : 'model_toggle_off')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void onToggleModel(provider.id, m.id, !m.enabled);
                  }}
                />
              </span>
            </div>
          );
        })}
      </div>

      {(unknownCount > 0 || provider.kind === 'custom') && (
        <div className="mp-mnote">
          {unknownCount > 0 && (
            <span>
              {t(lang, 'model_unknown_note', { count: unknownCount })}
            </span>
          )}
          {provider.kind === 'custom' && onRefreshModels && (
            <a
              style={{ marginLeft: 'auto' }}
              data-testid="next-refresh-models"
              onClick={() => void onRefreshModels(provider.id)}
            >
              {isRefreshing ? t(lang, 'provider_status_run') : t(lang, 'model_refresh_custom')}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
