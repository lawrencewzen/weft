import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { PANEL_SLIDE_MS } from './panelMotion';
import { readUiZoom, visualToCss } from './uiZoom';

export type FlipCoords = {
  cssDeltaX: number;
  cssDeltaY: number;
  visualDeltaX: number;
  visualDeltaY: number;
  totalDistance: number;
};

export function computeFlipCoords({
  originRect,
  targetRect,
  scrollRect,
  zoom = 1,
}: {
  originRect: { left: number; top: number; width: number; height: number };
  targetRect: { left: number; top: number; width: number; height: number };
  scrollRect?: { left: number; top: number; width: number; height: number; right?: number; bottom?: number } | null;
  zoom?: number;
}): FlipCoords {
  let originX = originRect.left;
  let originY = originRect.top;

  if (scrollRect) {
    const scrollRight = scrollRect.right ?? (scrollRect.left + scrollRect.width);
    const scrollBottom = scrollRect.bottom ?? (scrollRect.top + scrollRect.height);
    originX = Math.max(scrollRect.left, Math.min(scrollRight - originRect.width, originX));
    originY = Math.max(scrollRect.top, Math.min(scrollBottom - originRect.height, originY));
  }

  const visualDeltaX = originX - targetRect.left;
  const visualDeltaY = originY - targetRect.top;
  const totalDistance = Math.hypot(visualDeltaX, visualDeltaY);

  return {
    cssDeltaX: visualToCss(visualDeltaX, zoom),
    cssDeltaY: visualToCss(visualDeltaY, zoom),
    visualDeltaX,
    visualDeltaY,
    totalDistance,
  };
}

export function useStripProjectsFlip({
  leftOpen,
  stripBtnRef,
  sidebarRef,
  hasProjects,
}: {
  leftOpen: boolean;
  stripBtnRef: RefObject<HTMLButtonElement | null>;
  sidebarRef: RefObject<HTMLElement | null>;
  hasProjects: boolean;
}) {
  const prevLeftOpenRef = useRef(leftOpen);
  const currentAnimRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const wasOpen = prevLeftOpenRef.current;
    prevLeftOpenRef.current = leftOpen;

    if (wasOpen === leftOpen) return;

    const sidebarEl = sidebarRef.current;
    const stripBtn = stripBtnRef.current;
    if (!sidebarEl || !stripBtn) return;

    // Boundary: prefers-reduced-motion
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (currentAnimRef.current) {
        currentAnimRef.current.cancel();
        currentAnimRef.current = null;
      }
      stripBtn.classList.remove('is-sliding');
      sidebarEl.classList.remove('sb-hide-first-folder');
      stripBtn.style.transform = '';
      return;
    }

    // Boundary: dragging
    if (document.querySelector('.next-shell.is-dragging')) {
      return;
    }

    // Find first folder icon in workspace list
    const firstFolder = sidebarEl.querySelector('[data-testid="next-ws-toggle"] .sb-ic');
    if (!firstFolder || !hasProjects) {
      // Boundary: no projects -> do not slide
      if (currentAnimRef.current) {
        currentAnimRef.current.cancel();
        currentAnimRef.current = null;
      }
      stripBtn.classList.remove('is-sliding');
      sidebarEl.classList.remove('sb-hide-first-folder');
      stripBtn.style.transform = '';
      return;
    }

    const scrollEl = sidebarEl.querySelector('.sb-scroll');
    const scrollBox = scrollEl ? scrollEl.getBoundingClientRect() : null;
    const zoom = readUiZoom();
    const stripIcon = stripBtn.querySelector('.sb-ic') ?? stripBtn;

    if (!leftOpen) {
      // --- COLLAPSE (收起) ---
      const firstBox = firstFolder.getBoundingClientRect();
      const targetBox = stripIcon.getBoundingClientRect();

      let startX = firstBox.left;
      let startY = firstBox.top;
      if (scrollBox) {
        startX = Math.max(scrollBox.left, Math.min(scrollBox.right - firstBox.width, startX));
        startY = Math.max(scrollBox.top, Math.min(scrollBox.bottom - firstBox.height, startY));
      }

      // Check if reversing an active animation
      if (currentAnimRef.current) {
        const curBox = stripIcon.getBoundingClientRect();
        currentAnimRef.current.cancel();
        currentAnimRef.current = null;
        startX = curBox.left;
        startY = curBox.top;
      }

      const visualDx = startX - targetBox.left;
      const visualDy = startY - targetBox.top;
      const cssDx = visualToCss(visualDx, zoom);
      const cssDy = visualToCss(visualDy, zoom);

      const totalDist = Math.hypot(firstBox.left - targetBox.left, firstBox.top - targetBox.top);
      const curDist = Math.hypot(visualDx, visualDy);
      const duration = totalDist > 0 && curDist < totalDist
        ? Math.max(50, Math.min(PANEL_SLIDE_MS, Math.round(PANEL_SLIDE_MS * (curDist / totalDist))))
        : PANEL_SLIDE_MS;

      sidebarEl.classList.add('sb-hide-first-folder');
      stripBtn.classList.add('is-sliding');

      try {
        const anim = stripBtn.animate(
          [
            { transform: `translate3d(${cssDx}px, ${cssDy}px, 0)` },
            { transform: 'translate3d(0, 0, 0)' },
          ],
          {
            duration,
            easing: 'ease',
            fill: 'none',
          }
        );
        currentAnimRef.current = anim;
        const cleanup = () => {
          if (currentAnimRef.current === anim) {
            currentAnimRef.current = null;
          }
          stripBtn.classList.remove('is-sliding');
          sidebarEl.classList.remove('sb-hide-first-folder');
          stripBtn.style.transform = '';
        };
        anim.onfinish = cleanup;
        anim.oncancel = cleanup;
      } catch {
        stripBtn.classList.remove('is-sliding');
        sidebarEl.classList.remove('sb-hide-first-folder');
      }
    } else {
      // --- EXPAND (展开) ---
      const firstBox = firstFolder.getBoundingClientRect();
      let targetX = firstBox.left;
      let targetY = firstBox.top;
      if (scrollBox) {
        targetX = Math.max(scrollBox.left, Math.min(scrollBox.right - firstBox.width, targetX));
        targetY = Math.max(scrollBox.top, Math.min(scrollBox.bottom - firstBox.height, targetY));
      }

      stripBtn.classList.add('is-sliding');
      sidebarEl.classList.add('sb-hide-first-folder');

      const baseBox = stripIcon.getBoundingClientRect();
      let startX = baseBox.left;
      let startY = baseBox.top;

      if (currentAnimRef.current) {
        const curBox = stripIcon.getBoundingClientRect();
        currentAnimRef.current.cancel();
        currentAnimRef.current = null;
        startX = curBox.left;
        startY = curBox.top;
      }

      const startDx = startX - baseBox.left;
      const startDy = startY - baseBox.top;
      const targetDx = targetX - baseBox.left;
      const targetDy = targetY - baseBox.top;

      const startCssX = visualToCss(startDx, zoom);
      const startCssY = visualToCss(startDy, zoom);
      const targetCssX = visualToCss(targetDx, zoom);
      const targetCssY = visualToCss(targetDy, zoom);

      const totalDist = Math.hypot(targetX - baseBox.left, targetY - baseBox.top);
      const curDist = Math.hypot(targetX - startX, targetY - startY);
      const duration = totalDist > 0 && curDist < totalDist
        ? Math.max(50, Math.min(PANEL_SLIDE_MS, Math.round(PANEL_SLIDE_MS * (curDist / totalDist))))
        : PANEL_SLIDE_MS;

      try {
        const anim = stripBtn.animate(
          [
            { transform: `translate3d(${startCssX}px, ${startCssY}px, 0)` },
            { transform: `translate3d(${targetCssX}px, ${targetCssY}px, 0)` },
          ],
          {
            duration,
            easing: 'ease',
            fill: 'none',
          }
        );
        currentAnimRef.current = anim;
        const cleanup = () => {
          if (currentAnimRef.current === anim) {
            currentAnimRef.current = null;
          }
          stripBtn.classList.remove('is-sliding');
          sidebarEl.classList.remove('sb-hide-first-folder');
          stripBtn.style.transform = '';
        };
        anim.onfinish = cleanup;
        anim.oncancel = cleanup;
      } catch {
        stripBtn.classList.remove('is-sliding');
        sidebarEl.classList.remove('sb-hide-first-folder');
      }
    }
  }, [leftOpen, hasProjects, sidebarRef, stripBtnRef]);

  useEffect(() => {
    const sidebarEl = sidebarRef.current;
    const stripBtn = stripBtnRef.current;
    return () => {
      if (currentAnimRef.current) {
        currentAnimRef.current.cancel();
        currentAnimRef.current = null;
      }
      stripBtn?.classList.remove('is-sliding');
      sidebarEl?.classList.remove('sb-hide-first-folder');
      if (stripBtn) {
        stripBtn.style.transform = '';
      }
    };
  }, [sidebarRef, stripBtnRef]);
}
