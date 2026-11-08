import { useEffect, useRef } from 'react';

/**
 * Esc 停止当前运行中的对话：一处 window keydown（冒泡阶段）。
 * 各组件的 Esc 有的没有 preventDefault、有的挂在 window / 捕获阶段，
 * 所以「有没有打开的浮层」以 DOM 为准：keydown 当下浮层还在 DOM 里，
 * 无论各处监听器的先后顺序，这一次 Esc 都只归浮层。
 */
const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.ctx-menu',
  '.model-menu',
  '.dmenu',
  '.context-pop',
  '.composer-plus-menu',
  '.composer-at-menu',
  '.composer-paste-peek',
  '.ask-panel',
  '.modal-overlay',
  '.mp-mask',
  '.mp-menu',
  '.mp-pop',
  '.search-palette-overlay',
  '.next-settings-ov',
  '.img-lightbox',
  '.file-tree-drawer',
  '.ns-drawer-scrim',
  '.is-maximized',
].join(',');

const COMPOSER_INPUT = '[data-testid="next-composer-input"]';

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest(COMPOSER_INPUT)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const html = el as HTMLElement;
  if (html.isContentEditable) return true;
  return Boolean(el.closest('[contenteditable]:not([contenteditable="false"]), .cm-editor'));
}

/** 按顺序：输入法选词 → 浮层 → 其他可编辑控件；都不挡才允许停止。 */
export function shouldEscStop(event: KeyboardEvent, doc: Document = document): boolean {
  if (event.key !== 'Escape') return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.defaultPrevented) return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (doc.querySelector(OVERLAY_SELECTOR)) return false;
  if (isEditable(doc.activeElement)) return false;
  return true;
}

export function useEscStop(canStop: boolean, onStop: () => unknown): void {
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  useEffect(() => {
    if (!canStop) return;
    const onKey = (event: KeyboardEvent) => {
      if (!shouldEscStop(event)) return;
      void stopRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canStop]);
}
