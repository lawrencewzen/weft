import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export interface DropdownOption<T = string> {
  value: T;
  label: React.ReactNode;
  testId?: string;
  dataModel?: string;
  extra?: React.ReactNode;
  disabled?: boolean;
  key?: string;
}

export interface DropdownGroup<T = string> {
  groupLabel: React.ReactNode;
  options: DropdownOption<T>[];
}

export type DropdownItem<T = string> = DropdownOption<T> | DropdownGroup<T>;

export function isDropdownGroup<T>(item: DropdownItem<T>): item is DropdownGroup<T> {
  return typeof item === 'object' && item !== null && 'groupLabel' in item && Array.isArray((item as DropdownGroup<T>).options);
}

export interface DropdownProps<T = string> {
  triggerClassName?: string;
  triggerTestId?: string;
  triggerContent: React.ReactNode;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;

  items: DropdownItem<T>[];
  value?: T;
  onSelect: (value: T, option: DropdownOption<T>) => void;

  variant?: 'dialog' | 'picker';
  menuClassName?: string;
  menuTestId?: string;
  minWidth?: number;
  align?: 'left' | 'right';
  preferredMaxHeight?: number;

  portalContainer?: HTMLElement | null;
}

export function Dropdown<T = string>({
  triggerClassName = '',
  triggerTestId,
  triggerContent,
  disabled = false,
  title,
  ariaLabel,
  items,
  value,
  onSelect,
  variant = 'dialog',
  menuClassName,
  menuTestId,
  minWidth,
  align = 'left',
  preferredMaxHeight,
  portalContainer,
}: DropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [coords, setCoords] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    width?: number;
    maxHeight?: number;
  }>({});

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const flatOptions = useMemo(() => {
    const list: DropdownOption<T>[] = [];
    for (const item of items) {
      if (isDropdownGroup(item)) {
        for (const opt of item.options) {
          list.push(opt);
        }
      } else {
        list.push(item);
      }
    }
    return list;
  }, [items]);

  const defaultMaxHeight = preferredMaxHeight ?? (variant === 'picker' ? 340 : 260);

  const calculatePosition = useCallback((menuEl?: HTMLElement | null) => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    const vw = window.innerWidth || 1200;
    const GAP = 4;
    const EDGE_MARGIN = 8;

    const spaceBelow = Math.max(0, vh - rect.bottom - GAP - EDGE_MARGIN);
    const spaceAbove = Math.max(0, rect.top - GAP - EDGE_MARGIN);

    const measuredHeight = menuEl ? menuEl.scrollHeight : 0;
    const desiredHeight = measuredHeight > 0 ? measuredHeight : defaultMaxHeight;

    // Requirement: 下方放不下且上方更宽就向上展开
    const shouldFlipUp = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
    const nextPlacement: 'bottom' | 'top' = shouldFlipUp ? 'top' : 'bottom';

    const availableSpace = shouldFlipUp ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(60, Math.min(defaultMaxHeight, availableSpace));

    const effectiveMinWidth = minWidth ?? (variant === 'picker' ? 300 : 0);
    const calculatedWidth = Math.max(effectiveMinWidth, rect.width);

    let left = rect.left;
    if (align === 'right') {
      left = rect.right - calculatedWidth;
    }
    if (left + calculatedWidth > vw - EDGE_MARGIN) {
      left = Math.max(EDGE_MARGIN, vw - EDGE_MARGIN - calculatedWidth);
    }
    if (left < EDGE_MARGIN) {
      left = EDGE_MARGIN;
    }

    setPlacement(nextPlacement);
    if (nextPlacement === 'top') {
      setCoords({
        bottom: vh - rect.top + GAP,
        top: undefined,
        left,
        width: calculatedWidth,
        maxHeight,
      });
    } else {
      setCoords({
        top: rect.bottom + GAP,
        bottom: undefined,
        left,
        width: calculatedWidth,
        maxHeight,
      });
    }
  }, [align, defaultMaxHeight, minWidth, variant]);

  const openMenu = () => {
    if (disabled) return;
    calculatePosition(menuRef.current);
    setIsOpen(true);
  };

  const closeMenu = () => {
    setIsOpen(false);
  };

  const handleToggle = () => {
    if (disabled) return;
    if (isOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  };

  // Re-check position and measure menu once open
  useLayoutEffect(() => {
    if (!isOpen) return;
    calculatePosition(menuRef.current);
  }, [isOpen, calculatePosition]);

  // When opened, find and scroll selected option into view, and initialize highlightedIndex
  useEffect(() => {
    if (!isOpen) return;
    const selectedIdx = flatOptions.findIndex((opt) => opt.value === value);
    if (selectedIdx >= 0) {
      setHighlightedIndex(selectedIdx);
    } else {
      setHighlightedIndex(0);
    }

    if (menuRef.current) {
      const selectedEl = menuRef.current.querySelector<HTMLElement>('.is-selected, .on');
      selectedEl?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [isOpen, flatOptions, value]);

  // When highlighted index changes, scroll into view
  useEffect(() => {
    if (!isOpen || !menuRef.current) return;
    const highlightedEl = menuRef.current.querySelector<HTMLElement>('.is-highlighted, .highlighted');
    highlightedEl?.scrollIntoView?.({ block: 'nearest' });
  }, [highlightedIndex, isOpen]);

  // Outside click, Esc, ancestor scroll, window resize
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target;
      if (target instanceof Node) {
        if (triggerRef.current?.contains(target)) return;
        if (menuRef.current?.contains(target)) return;
      }
      closeMenu();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        closeMenu();
        triggerRef.current?.focus();
      }
    };

    const handleScroll = (e: Event) => {
      const target = e.target;
      // If scroll happened inside the dropdown menu itself, ignore
      if (target instanceof Node && menuRef.current) {
        if (target === menuRef.current || menuRef.current.contains(target)) {
          return;
        }
      }
      closeMenu();
    };

    const handleResize = () => {
      closeMenu();
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('touchstart', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [isOpen]);

  const handleSelectOption = (opt: DropdownOption<T>) => {
    if (opt.disabled) return;
    onSelect(opt.value, opt);
    closeMenu();
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => {
        if (flatOptions.length === 0) return 0;
        let next = (prev + 1) % flatOptions.length;
        // Skip disabled options if any
        let attempts = flatOptions.length;
        while (flatOptions[next]?.disabled && attempts > 0) {
          next = (next + 1) % flatOptions.length;
          attempts--;
        }
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => {
        if (flatOptions.length === 0) return 0;
        let next = (prev - 1 + flatOptions.length) % flatOptions.length;
        let attempts = flatOptions.length;
        while (flatOptions[next]?.disabled && attempts > 0) {
          next = (next - 1 + flatOptions.length) % flatOptions.length;
          attempts--;
        }
        return next;
      });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const currentOpt = flatOptions[highlightedIndex];
      if (currentOpt && !currentOpt.disabled) {
        handleSelectOption(currentOpt);
      }
    } else if (e.key === 'Tab') {
      closeMenu();
    }
  };

  const renderOption = (opt: DropdownOption<T>, optIndexInGroup?: number) => {
    const isSelected = value !== undefined && opt.value === value;
    const optIndex = flatOptions.indexOf(opt);
    const isHighlighted = highlightedIndex === optIndex;
    const itemKey = opt.key ?? (opt.value != null ? String(opt.value) : (opt.testId ?? String(optIndexInGroup ?? optIndex)));
    const dataModel = opt.dataModel ?? (typeof opt.value === 'string' ? opt.value : undefined);

    if (variant === 'picker') {
      return (
        <div
          key={itemKey}
          className={`mp-menu-i${isSelected ? ' on is-selected' : ''}${isHighlighted ? ' highlighted is-highlighted' : ''}${opt.disabled ? ' disabled' : ''}`}
          data-testid={opt.testId}
          data-model={dataModel}
          onClick={() => handleSelectOption(opt)}
          onMouseEnter={() => !opt.disabled && setHighlightedIndex(optIndex)}
        >
          <span>{opt.label}</span>
          {opt.extra ? <span className="mp-menu-x">{opt.extra}</span> : null}
        </div>
      );
    }

    return (
      <div
        key={itemKey}
        className={`mp-add-dd-it${isSelected ? ' on is-selected' : ''}${isHighlighted ? ' highlighted is-highlighted' : ''}${opt.disabled ? ' disabled' : ''}`}
        data-testid={opt.testId}
        data-model={dataModel}
        onClick={() => handleSelectOption(opt)}
        onMouseEnter={() => !opt.disabled && setHighlightedIndex(optIndex)}
      >
        <span className="ck">{isSelected ? '✓' : ''}</span>
        <span>{opt.label}</span>
        {opt.extra ? <span className="cx">{opt.extra}</span> : null}
      </div>
    );
  };

  const baseMenuClass = variant === 'picker' ? 'mp-menu' : 'mp-add-dd-menu';
  const menuClassNameResolved = `${baseMenuClass}${menuClassName ? ` ${menuClassName}` : ''} is-${placement}`.trim();

  const menuNode = isOpen ? (
    <div
      ref={menuRef}
      className={menuClassNameResolved}
      data-testid={menuTestId}
      data-placement={placement}
      role="listbox"
      style={{
        position: 'fixed',
        zIndex: 300,
        boxSizing: 'border-box',
        left: coords.left !== undefined ? `${coords.left}px` : undefined,
        top: coords.top !== undefined ? `${coords.top}px` : undefined,
        bottom: coords.bottom !== undefined ? `${coords.bottom}px` : undefined,
        width: coords.width !== undefined ? `${coords.width}px` : undefined,
        maxHeight: coords.maxHeight !== undefined ? `${coords.maxHeight}px` : undefined,
        overflowY: 'auto',
      }}
    >
      {items.map((item, idx) => {
        if (isDropdownGroup(item)) {
          return (
            <div key={`group-${idx}`}>
              <div className="mp-menu-g">{item.groupLabel}</div>
              {item.options.map((opt, optIdx) => renderOption(opt, optIdx))}
            </div>
          );
        }
        return renderOption(item, idx);
      })}
    </div>
  ) : null;

  const targetContainer = portalContainer ?? (typeof document !== 'undefined' ? document.body : null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${triggerClassName}${isOpen ? ' open' : ''}`.trim()}
        data-testid={triggerTestId}
        disabled={disabled}
        onClick={handleToggle}
        onKeyDown={handleTriggerKeyDown}
        title={title}
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        {triggerContent}
      </button>
      {menuNode && targetContainer ? createPortal(menuNode, targetContainer) : null}
    </>
  );
}
