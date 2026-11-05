import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { PANEL_SLIDE_MS } from './panelMotion';
import { readUiZoom, visualToCss } from './uiZoom';

type Props = {
  leftOpen: boolean;
  stripBtnRef: RefObject<HTMLButtonElement | null>;
  sidebarRef: RefObject<HTMLElement | null>;
  hasProjects: boolean;
};

export function useStripProjectsFlip({ leftOpen, stripBtnRef, sidebarRef, hasProjects }: Props) {
  const prevLeftOpenRef = useRef(leftOpen);
  const currentAnimRef = useRef<Animation | null>(null);

  const clear = (strip?: HTMLElement | null, sidebar?: HTMLElement | null) => {
    if (currentAnimRef.current) {
      currentAnimRef.current.cancel();
      currentAnimRef.current = null;
    }
    strip?.classList.remove('is-sliding');
    sidebar?.classList.remove('sb-hide-first-folder');
    if (strip) strip.style.transform = '';
  };

  useLayoutEffect(() => {
    const wasOpen = prevLeftOpenRef.current;
    prevLeftOpenRef.current = leftOpen;
    if (wasOpen === leftOpen) return;

    const sidebarEl = sidebarRef.current;
    const stripBtn = stripBtnRef.current;
    if (!sidebarEl || !stripBtn) return;

    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const firstFolder = sidebarEl.querySelector('[data-testid="next-ws-toggle"] .sb-ic');
    if (reduce || document.querySelector('.next-shell.is-dragging') || !firstFolder || !hasProjects) {
      clear(stripBtn, sidebarEl);
      return;
    }

    const scrollEl = sidebarEl.querySelector('.sb-scroll');
    const scrollBox = scrollEl?.getBoundingClientRect();
    const firstBox = firstFolder.getBoundingClientRect();
    const folderPos = {
      x: scrollBox ? Math.max(scrollBox.left, Math.min(scrollBox.right - firstBox.width, firstBox.left)) : firstBox.left,
      y: scrollBox ? Math.max(scrollBox.top, Math.min(scrollBox.bottom - firstBox.height, firstBox.top)) : firstBox.top,
    };

    stripBtn.classList.add('is-sliding');
    sidebarEl.classList.add('sb-hide-first-folder');

    const stripIcon = stripBtn.querySelector('.sb-ic') ?? stripBtn;
    let start: { x: number; y: number } | null = null;
    if (currentAnimRef.current) {
      const curBox = stripIcon.getBoundingClientRect();
      start = { x: curBox.left, y: curBox.top };
      currentAnimRef.current.cancel();
      currentAnimRef.current = null;
    }

    const baseBox = stripIcon.getBoundingClientRect();
    const stripPos = { x: baseBox.left, y: baseBox.top };
    if (!start) {
      start = leftOpen ? stripPos : folderPos;
    }
    const target = leftOpen ? folderPos : stripPos;

    const zoom = readUiZoom();
    const fromX = visualToCss(start.x - baseBox.left, zoom);
    const fromY = visualToCss(start.y - baseBox.top, zoom);
    const toX = visualToCss(target.x - baseBox.left, zoom);
    const toY = visualToCss(target.y - baseBox.top, zoom);

    const anim = stripBtn.animate(
      [{ transform: `translate3d(${fromX}px, ${fromY}px, 0)` }, { transform: `translate3d(${toX}px, ${toY}px, 0)` }],
      { duration: PANEL_SLIDE_MS, easing: 'ease', fill: 'none' },
    );
    currentAnimRef.current = anim;

    const cleanup = () => {
      if (currentAnimRef.current === anim) clear(stripBtn, sidebarEl);
    };
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
  }, [leftOpen, hasProjects, sidebarRef, stripBtnRef]);

  useEffect(() => () => clear(stripBtnRef.current, sidebarRef.current), [sidebarRef, stripBtnRef]);
}
