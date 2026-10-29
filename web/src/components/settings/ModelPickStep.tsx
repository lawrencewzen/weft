import { Fragment, useState } from 'react';
import { formatNumber } from '../../data/providerFormat';
import type { Model } from '../../data/providerTypes';
import { t, type Lang } from '../../i18n';

type Props = {
  lang: Lang;
  models: readonly Model[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
};

export function ModelPickStep({ lang, models, selectedIds, onToggle }: Props) {
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const filtered = models.filter(
    (m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
  );

  return (
    <div>
      <div className="mp-okline">
        ✓ {t(lang, 'dlg_connected_models_found', { count: models.length })}
      </div>
      {models.length > 8 && (
        <input
          className="mp-search"
          data-testid="next-model-pick-search"
          style={{ marginBottom: 12 }}
          placeholder={t(lang, 'dlg_add_search_placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="mp-pickm">
        <span className="mp-h" />
        <span className="mp-h">{t(lang, 'model_th_name')}</span>
        <span className="mp-h mp-r">{t(lang, 'model_th_context')}</span>
        <span className="mp-h mp-r">{t(lang, 'model_th_max_tokens')}</span>
        <span className="mp-h">{t(lang, 'model_th_caps')}</span>
        {filtered.map((m) => {
          const checked = selectedIds.has(m.id);
          const caps = [
            m.images ? t(lang, 'model_cap_images') : null,
            m.reasoning ? t(lang, 'model_cap_reasoning') : null,
          ].filter(Boolean).join(' · ') || '—';

          return (
            <Fragment key={m.id}>
              <span className="mp-c">
                <input
                  type="checkbox"
                  className="mp-cb"
                  checked={checked}
                  onChange={() => onToggle(m.id, !checked)}
                />
              </span>
              <span className="mp-c" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ fontWeight: 500 }}>{m.name}</span>
                {m.name !== m.id && (
                  <span style={{ marginLeft: 6, fontSize: 11.5, fontFamily: 'var(--mono)', color: 'var(--faint)' }}>
                    {m.id}
                  </span>
                )}
              </span>
              <span className="mp-c mp-r" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                {m.contextWindow ? formatNumber(m.contextWindow) : '—'}
              </span>
              <span className="mp-c mp-r" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                {m.maxTokens ? formatNumber(m.maxTokens) : '—'}
              </span>
              <span className="mp-c" style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                {caps}
              </span>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
