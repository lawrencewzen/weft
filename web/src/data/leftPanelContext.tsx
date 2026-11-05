import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  defaultLeftOpen,
  LEFT_OVERLAY_MAX,
  LS_LEFT_OPEN,
  persistLeftOpen,
  readPref,
} from './layout';
import { cssViewportWidth } from './uiZoom';

export type LeftPanelValue = {
  leftOpen: boolean;
  setLeftOpen: (open: boolean) => void;
  toggleLeft: () => void;
  dragging: boolean;
  setDragging: (dragging: boolean) => void;
};

const LeftPanelContext = createContext<LeftPanelValue | null>(null);

export function LeftPanelProvider({ children }: { children: ReactNode }) {
  const [leftOpen, setLeftOpenState] = useState(() => defaultLeftOpen(cssViewportWidth()));
  const [dragging, setDragging] = useState(false);
  const lastWidth = useRef(cssViewportWidth());

  const setLeftOpen = useCallback((open: boolean) => {
    setLeftOpenState(open);
    persistLeftOpen(open, cssViewportWidth());
  }, []);

  const toggleLeft = useCallback(() => {
    setLeftOpen(!leftOpen);
  }, [leftOpen, setLeftOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      const vw = cssViewportWidth();
      if (lastWidth.current > LEFT_OVERLAY_MAX && vw <= LEFT_OVERLAY_MAX) {
        setLeftOpen(false);
      }
      if (lastWidth.current <= LEFT_OVERLAY_MAX && vw > LEFT_OVERLAY_MAX) {
        setLeftOpen(readPref(LS_LEFT_OPEN, true));
      }
      lastWidth.current = vw;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setLeftOpen]);

  const value = useMemo<LeftPanelValue>(() => ({
    leftOpen,
    setLeftOpen,
    toggleLeft,
    dragging,
    setDragging,
  }), [leftOpen, setLeftOpen, toggleLeft, dragging, setDragging]);

  return <LeftPanelContext.Provider value={value}>{children}</LeftPanelContext.Provider>;
}

export function useLeftPanel(): LeftPanelValue {
  const value = useContext(LeftPanelContext);
  if (!value) throw new Error('useLeftPanel requires LeftPanelProvider');
  return value;
}
