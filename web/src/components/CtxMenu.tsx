import { useEffect, useLayoutEffect, useRef } from 'react';
import { cssViewportHeight, cssViewportWidth, visualToCss } from '../data/uiZoom';

export type CtxMenuItem =
  | { sep: true; action?: undefined; label?: undefined }
  | {
      sep?: false;
      label: string;
      action: string;
      danger?: boolean;
      disabled?: boolean;
      run: () => void;
    };

type Props = {
  x: number;
  y: number;
  title?: string;
  items: CtxMenuItem[];
  onClose: () => void;
};

export function CtxMenu({ x, y, title, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const w = menu.offsetWidth || 220;
    const h = menu.offsetHeight || 120;
    let left = visualToCss(x);
    let top = visualToCss(y);
    left = Math.max(8, Math.min(left, cssViewportWidth() - w - 8));
    top = Math.max(8, Math.min(top, cssViewportHeight() - h - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [x, y, items, title]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    const onDown = (ev: MouseEvent) => {
      if (!ref.current?.contains(ev.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ctx-menu" data-testid="next-ctx-menu" role="menu" style={{ left: visualToCss(x), top: visualToCss(y) }}>
      {title ? <div className="ctx-menu-title">{title}</div> : null}
      {items.map((item, i) => (
        item.sep ? (
          <div key={`sep-${i}`} className="ctx-menu-sep" />
        ) : (
          <button
            key={item.action}
            type="button"
            className={`ctx-menu-item${item.danger ? ' is-danger' : ''}`}
            data-testid="next-ctx-item"
            data-action={item.action}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
          </button>
        )
      ))}
    </div>
  );
}
