import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../data/lang';
import {
  isSelectedOption,
  type ComposerModelGroup,
  type ComposerModelOption,
} from '../data/composerModel';
import { formatTokenCount, t } from '../i18n';
import { BrandIcon } from './BrandIcon';

const CHECK_ICON = (
  <svg className="model-menu-check" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12l5 5L20 7" />
  </svg>
);

type Props = {
  lang: Lang;
  selected: ComposerModelOption | null;
  groups: ComposerModelGroup[];
  onPick: (option: ComposerModelOption) => void;
  onManage: () => void;
};

export function ModelChip({ lang, selected, groups, onPick, onManage }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    const onDown = (ev: MouseEvent) => {
      if (!wrap.current?.contains(ev.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const label = selected?.displayName || selected?.modelId || '';

  return (
    <div className="chip-selector-wrap" ref={wrap}>
      <button
        type="button"
        className={`model-chip${open ? ' is-open' : ''}`}
        data-testid="next-model-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <BrandIcon brand={selected?.brand} size={13} />
        <span className="model-chip-name">{label}</span>
        <span className="model-chip-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <div className="model-menu" data-testid="next-model-menu" role="listbox">
          {groups.map((group) => (
            <div key={group.providerId} className="model-menu-group">
              <div className="model-menu-label">
                {group.mixedBrands ? <BrandIcon brand={group.providerBrand} size={11} /> : null}
                <span>{group.providerName}</span>
              </div>
              {group.models.map((option) => {
                const selectedRow = isSelectedOption(option, selected);
                return (
                  <button
                    key={`${option.providerId}:${option.modelId}`}
                    type="button"
                    className={`model-menu-item${selectedRow ? ' is-selected' : ''}`}
                    role="option"
                    aria-selected={selectedRow}
                    data-testid="next-model-option"
                    data-provider={option.providerId}
                    data-model={option.modelId}
                    onClick={() => {
                      setOpen(false);
                      onPick(option);
                    }}
                  >
                    <BrandIcon brand={option.brand} size={14} />
                    <span className="model-menu-copy">
                      <span className="model-menu-title">{option.displayName}</span>
                      <span className="model-menu-id">{option.modelId}</span>
                    </span>
                    <span className="model-menu-meta">
                      {formatTokenCount(option.contextWindow)}
                      {option.isDefault ? ` · ${t(lang, 'ctx_default_mark')}` : ''}
                    </span>
                    <span className="model-menu-check-slot">
                      {selectedRow ? CHECK_ICON : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          <div className="model-menu-foot">
            <span>{t(lang, 'model_only_this_chat')}</span>
            <span className="model-menu-dot" aria-hidden="true">{' · '}</span>
            <button
              type="button"
              className="model-menu-manage"
              data-testid="next-model-manage"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              {t(lang, 'model_manage')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
