import { useEffect, useRef, useState, useCallback, useId, type FormEvent } from 'react';
import type { Lang } from '../data/lang';
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  clampThinkingLevel,
  contextWindowOptions,
  parseContextWindowInput,
  getRecentModelEntries,
  isSelectedOption,
  readRecentModels,
  saveRecentModel,
  type ComposerModelGroup,
  type ComposerModelOption,
  type ThinkingLevel,
} from '../data/composerModel';
import { formatTokenCount, t } from '../i18n';
import { BrandIcon } from './BrandIcon';
import { GaugeIcon } from './GaugeIcon';

const CHECK_ICON = (
  <svg className="model-menu-check" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12l5 5L20 7" />
  </svg>
);

type Props = {
  lang: Lang;
  selected: ComposerModelOption | null;
  groups: ComposerModelGroup[];
  thinkingLevel?: ThinkingLevel | null;
  onPick: (option: ComposerModelOption) => void;
  onPickThinkingLevel?: (level: ThinkingLevel) => void;
  onPickRecent?: (option: ComposerModelOption, level: ThinkingLevel | null) => void;
  onManage: () => void;
  contextWindow?: number;
  onSetContextWindow?: (window: number | null) => void;
};

export function ModelChip({
  lang,
  selected,
  groups,
  thinkingLevel,
  onPick,
  onPickThinkingLevel,
  onPickRecent,
  onManage,
  contextWindow = 0,
  onSetContextWindow,
}: Props) {
  const [open, setOpen] = useState(false);
  const [subMenu, setSubMenu] = useState<'model' | 'thinking' | 'context' | null>(null);
  const [ctxCustom, setCtxCustom] = useState('');
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [isInline, setIsInline] = useState(false);
  const [recentRaw, setRecentRaw] = useState(() => readRecentModels());
  const wrap = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerId = useId();

  const supportsThinking = Boolean(selected?.thinkingLevels && selected.thinkingLevels.length > 0);
  const effectiveThinkingLevel = supportsThinking
    ? clampThinkingLevel(selected?.thinkingLevels, thinkingLevel ?? selected?.defaultThinkingLevel)
    : null;

  const canSetContext = Boolean(selected?.providerId && selected.modelId && onSetContextWindow);
  const ctxOptions = contextWindowOptions(contextWindow);
  const ctxIsCustom = ctxOptions.some((o) => o.selected && o.custom);

  const checkFit = useCallback(() => {
    if (!wrap.current) return;
    const rect = wrap.current.getBoundingClientRect();
    // Primary menu ~300px + gap 8px + submenu ~300px + 16px padding
    const needed = rect.left + 300 + 8 + 300 + 16;
    setIsInline(needed > window.innerWidth || window.innerWidth < 640);
  }, []);

  const handleOpen = useCallback(() => {
    setRecentRaw(readRecentModels());
    checkFit();
    setSubMenu(null);
    setCtxCustom('');
    setCtxError(null);
    setOpen((prev) => !prev);
  }, [checkFit]);

  useEffect(() => {
    if (!open) return;
    checkFit();
    const onResize = () => checkFit();
    const onDown = (ev: MouseEvent) => {
      if (!wrap.current?.contains(ev.target as Node)) {
        setOpen(false);
        setSubMenu(null);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        if (subMenu !== null) {
          setSubMenu(null);
        } else {
          setOpen(false);
        }
        return;
      }
      if (ev.key === 'ArrowLeft' && subMenu !== null) {
        ev.preventDefault();
        setSubMenu(null);
        return;
      }
      if (subMenu === null) {
        if (ev.key === 'ArrowRight') {
          const focused = document.activeElement;
          if (focused?.getAttribute('data-testid') === 'next-menu-model') {
            ev.preventDefault();
            setSubMenu('model');
          } else if (focused?.getAttribute('data-testid') === 'next-menu-thinking' && supportsThinking) {
            ev.preventDefault();
            setSubMenu('thinking');
          } else if (focused?.getAttribute('data-testid') === 'next-menu-context' && canSetContext) {
            ev.preventDefault();
            setSubMenu('context');
          }
        }
      }
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, subMenu, supportsThinking, canSetContext, checkFit]);

  const handlePickModel = useCallback((option: ComposerModelOption) => {
    const clampedLevel = clampThinkingLevel(option.thinkingLevels, effectiveThinkingLevel);
    saveRecentModel({
      providerId: option.providerId,
      modelId: option.modelId,
      thinkingLevel: clampedLevel,
    });
    setOpen(false);
    setSubMenu(null);
    onPick(option);
  }, [effectiveThinkingLevel, onPick]);

  const handlePickThinkingLevel = useCallback((lvl: ThinkingLevel) => {
    if (selected) {
      saveRecentModel({
        providerId: selected.providerId,
        modelId: selected.modelId,
        thinkingLevel: lvl,
      });
    }
    setOpen(false);
    setSubMenu(null);
    onPickThinkingLevel?.(lvl);
  }, [selected, onPickThinkingLevel]);

  const handlePickContext = useCallback((tokens: number | null) => {
    setOpen(false);
    setSubMenu(null);
    setCtxCustom('');
    setCtxError(null);
    onSetContextWindow?.(tokens);
  }, [onSetContextWindow]);

  function submitContextCustom(event: FormEvent) {
    event.preventDefault();
    const parsed = parseContextWindowInput(ctxCustom);
    if (parsed == null) {
      setCtxError(t(lang, 'ctx_window_range', { min: CONTEXT_WINDOW_MIN, max: CONTEXT_WINDOW_MAX }));
      return;
    }
    handlePickContext(parsed);
  }

  const handlePickRecent = useCallback((option: ComposerModelOption, lvl: ThinkingLevel | null) => {
    saveRecentModel({
      providerId: option.providerId,
      modelId: option.modelId,
      thinkingLevel: lvl,
    });
    setOpen(false);
    setSubMenu(null);
    if (onPickRecent) {
      onPickRecent(option, lvl);
    } else {
      onPick(option);
      if (lvl) onPickThinkingLevel?.(lvl);
    }
  }, [onPickRecent, onPick, onPickThinkingLevel]);

  const recentEntries = getRecentModelEntries(
    recentRaw,
    selected ? { providerId: selected.providerId, modelId: selected.modelId, thinkingLevel: effectiveThinkingLevel } : null,
    groups,
  );

  const modelLabel = selected?.displayName || selected?.modelId || '';
  const hasThinkingSuffix = Boolean(supportsThinking && effectiveThinkingLevel && effectiveThinkingLevel !== 'off');
  const thinkingSuffixText = hasThinkingSuffix && effectiveThinkingLevel ? t(lang, `thinking_level_${effectiveThinkingLevel}`) : '';

  const buttonTitle = hasThinkingSuffix
    ? `${modelLabel} · ${thinkingSuffixText}`
    : modelLabel;

  const modelListContent = (
    <div className="models-menu-list">
      {groups.map((group) => (
        <div key={group.providerId} className="model-menu-group">
          <div className="model-menu-label dmenu-label">
            {group.mixedBrands ? <BrandIcon brand={group.providerBrand} size={11} /> : null}
            <span>{group.providerName}</span>
          </div>
          {group.models.map((option) => {
            const selectedRow = isSelectedOption(option, selected);
            return (
              <button
                key={`${option.providerId}:${option.modelId}`}
                type="button"
                className={`mi model-menu-item${selectedRow ? ' sel is-selected' : ''}`}
                role="option"
                aria-selected={selectedRow}
                data-testid="next-model-option"
                data-provider={option.providerId}
                data-model={option.modelId}
                onClick={() => handlePickModel(option)}
              >
                <BrandIcon brand={option.brand} size={14} />
                <span className="model-menu-copy tt">
                  <b className="model-menu-title">{option.displayName}</b>
                  <small className="model-menu-id">{option.modelId}</small>
                </span>
                <span className="model-menu-meta meta">
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
    </div>
  );

  const thinkingListContent = selected && supportsThinking ? (
    <div className="thinking-menu-list">
      <div className="model-menu-label dmenu-label">
        {t(lang, 'thinking_sub_title', { model: selected.displayName })}
      </div>
      {selected.thinkingLevels.map((lvl) => {
        const isSel = lvl === effectiveThinkingLevel;
        return (
          <button
            key={lvl}
            type="button"
            className={`mi${isSel ? ' sel' : ''}`}
            role="option"
            aria-selected={isSel}
            data-testid="next-thinking-option"
            data-level={lvl}
            onClick={() => handlePickThinkingLevel(lvl)}
          >
            <span className={`ti${isSel ? ' sel' : ''}`}>
              <GaugeIcon level={lvl} size={16} />
            </span>
            <span className="tt">
              <b>{t(lang, `thinking_level_${lvl}`)}</b>
              <span className="hint">{t(lang, `thinking_hint_${lvl}`)}</span>
            </span>
            <span className="model-menu-check-slot">
              {isSel ? CHECK_ICON : null}
            </span>
          </button>
        );
      })}
      <div className="mfoot">
        {selected.thinkingLevels.includes('off')
          ? t(lang, 'thinking_foot_slow')
          : t(lang, 'thinking_foot_cannot_close')}
      </div>
    </div>
  ) : null;

  const contextListContent = selected && canSetContext ? (
    <div className="context-menu-list">
      <div className="model-menu-label dmenu-label">
        {t(lang, 'ctx_sub_title', { model: selected.displayName })}
      </div>
      {ctxOptions.map((option) => (
        <button
          key={option.tokens}
          type="button"
          className={`mi${option.selected ? ' sel' : ''}`}
          role="option"
          aria-selected={option.selected}
          data-testid="next-context-option"
          data-tokens={option.tokens}
          onClick={() => handlePickContext(option.tokens)}
        >
          <span className="tt">
            <b>{formatTokenCount(option.tokens)}</b>
          </span>
          {option.custom ? <span className="meta">{t(lang, 'ctx_custom_mark')}</span> : null}
          <span className="model-menu-check-slot">
            {option.selected ? CHECK_ICON : null}
          </span>
        </button>
      ))}
      <form className="context-custom" onSubmit={submitContextCustom}>
        <input
          className="context-custom-input"
          data-testid="next-context-custom"
          inputMode="numeric"
          placeholder={t(lang, 'ctx_custom_placeholder')}
          value={ctxCustom}
          onChange={(event) => {
            setCtxCustom(event.target.value);
            setCtxError(null);
          }}
        />
        <button type="submit" className="context-custom-apply" data-testid="next-context-apply">
          {t(lang, 'ctx_custom_apply')}
        </button>
      </form>
      {ctxError ? <div className="context-custom-error">{ctxError}</div> : null}
      <div className="mfoot">
        <button
          type="button"
          className="model-menu-manage"
          data-testid="next-context-restore"
          onClick={() => handlePickContext(null)}
        >
          {t(lang, 'ctx_restore')}
        </button>
        <span className="model-menu-dot" aria-hidden="true">{' · '}</span>
        <span>{t(lang, 'ctx_foot_per_model')}</span>
      </div>
    </div>
  ) : null;

  return (
    <div className="chip-selector-wrap" ref={wrap}>
      <button
        id={triggerId}
        type="button"
        className={`model-chip dchip${open ? ' is-open' : ''}`}
        data-testid="next-model-chip"
        aria-haspopup="true"
        aria-expanded={open}
        title={buttonTitle}
        onClick={handleOpen}
      >
        <BrandIcon brand={selected?.brand} size={13} />
        <span className="model-chip-name nm">{modelLabel}</span>
        {hasThinkingSuffix ? (
          <span className="model-chip-thinking lvs hot" data-testid="next-model-chip-thinking">
            {` · ${thinkingSuffixText}`}
          </span>
        ) : null}
        <span className="model-chip-caret car" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open ? (
        <div
          ref={menuRef}
          className="dmenu model-menu"
          data-testid="next-model-menu"
          role="menu"
        >
          {isInline && subMenu !== null ? (
            <div className="inline-submenu">
              <button
                type="button"
                className="back"
                data-testid="next-menu-back"
                onClick={() => setSubMenu(null)}
              >
                {subMenu === 'model'
                  ? t(lang, 'back_to_model')
                  : subMenu === 'thinking' ? t(lang, 'back_to_thinking') : t(lang, 'back_to_context')}
              </button>
              {subMenu === 'model' ? modelListContent : subMenu === 'thinking' ? thinkingListContent : contextListContent}
            </div>
          ) : (
            <>
              {recentEntries.length > 0 ? (
                <>
                  <div className="model-menu-label dmenu-label">{t(lang, 'model_recent')}</div>
                  {recentEntries.map(({ option, thinkingLevel: recLv }) => (
                    <button
                      key={`${option.providerId}:${option.modelId}:${recLv ?? ''}`}
                      type="button"
                      className="dr recent"
                      data-testid="next-recent-option"
                      onClick={() => handlePickRecent(option, recLv)}
                    >
                      <BrandIcon brand={option.brand} size={14} />
                      <span className="k">{option.displayName}</span>
                      <span className="v">
                        {recLv
                          ? t(lang, 'recent_thinking_suffix', { level: t(lang, `thinking_level_${recLv}`) })
                          : t(lang, 'recent_no_thinking')}
                      </span>
                    </button>
                  ))}
                  <div className="dsep" />
                </>
              ) : null}

              {/* Model row */}
              <div
                role="button"
                tabIndex={0}
                className={`dr${subMenu === 'model' ? ' act' : ''}`}
                data-testid="next-menu-model"
                onMouseEnter={() => {
                  if (!isInline) setSubMenu('model');
                }}
                onClick={() => {
                  setSubMenu((prev) => (isInline ? 'model' : (prev === 'model' ? null : 'model')));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    setSubMenu('model');
                  }
                }}
              >
                <span className="k">{t(lang, 'model_menu_title')}</span>
                <span className="v">{modelLabel}</span>
                <span className="chev">›</span>
                {!isInline && subMenu === 'model' ? (
                  <div
                    className="dsub models"
                    data-testid="next-sub-models"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {modelListContent}
                  </div>
                ) : null}
              </div>

              {/* Thinking row */}
              {supportsThinking ? (
                <div
                  role="button"
                  tabIndex={0}
                  className={`dr${subMenu === 'thinking' ? ' act' : ''}`}
                  data-testid="next-menu-thinking"
                  onMouseEnter={() => {
                    if (!isInline) setSubMenu('thinking');
                  }}
                  onClick={() => {
                    setSubMenu((prev) => (isInline ? 'thinking' : (prev === 'thinking' ? null : 'thinking')));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
                      e.preventDefault();
                      setSubMenu('thinking');
                    }
                  }}
                >
                  <span className="k">{t(lang, 'thinking_menu_title')}</span>
                  <span className="v">
                    <GaugeIcon level={effectiveThinkingLevel} size={14} />
                    {effectiveThinkingLevel ? t(lang, `thinking_level_${effectiveThinkingLevel}`) : ''}
                  </span>
                  <span className="chev">›</span>
                  {!isInline && subMenu === 'thinking' ? (
                    <div
                      className="dsub"
                      data-testid="next-sub-thinking"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {thinkingListContent}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div
                  className="dr dis"
                  data-testid="next-menu-thinking"
                  aria-disabled="true"
                >
                  <span className="k">{t(lang, 'thinking_menu_title')}</span>
                  <span className="v">{t(lang, 'thinking_unsupported')}</span>
                </div>
              )}

              {/* Context row */}
              {canSetContext ? (
                <div
                  role="button"
                  tabIndex={0}
                  className={`dr${subMenu === 'context' ? ' act' : ''}`}
                  data-testid="next-menu-context"
                  onMouseEnter={() => {
                    if (!isInline) setSubMenu('context');
                  }}
                  onClick={() => {
                    setSubMenu((prev) => (isInline ? 'context' : (prev === 'context' ? null : 'context')));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
                      e.preventDefault();
                      setSubMenu('context');
                    }
                  }}
                >
                  <span className="k">{t(lang, 'ctx_menu_title')}</span>
                  <span className="v">
                    {formatTokenCount(contextWindow)}
                    {ctxIsCustom ? ` · ${t(lang, 'ctx_custom_mark')}` : ''}
                  </span>
                  <span className="chev">›</span>
                  {!isInline && subMenu === 'context' ? (
                    <div
                      className="dsub"
                      data-testid="next-sub-context"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {contextListContent}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="dr dis" data-testid="next-menu-context" aria-disabled="true">
                  <span className="k">{t(lang, 'ctx_menu_title')}</span>
                  <span className="v">{contextWindow ? formatTokenCount(contextWindow) : ''}</span>
                </div>
              )}

              <div className="mfoot">
                <span>{t(lang, 'model_only_this_chat')}</span>
                <span className="model-menu-dot" aria-hidden="true">{' · '}</span>
                <button
                  type="button"
                  className="model-menu-manage"
                  data-testid="next-model-manage"
                  onClick={() => {
                    setOpen(false);
                    setSubMenu(null);
                    onManage();
                  }}
                >
                  {t(lang, 'model_manage')}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
