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
  isOverlayWidth,
  LEFT_OVERLAY_MAX,
  LS_LEFT_OPEN,
  persistLeftOpen,
  readPref,
} from './layout';

export type LeftPanelValue = {
  leftOpen: boolean;
  setLeftOpen: (open: boolean) => void;
  toggleLeft: () => void;
  leftOpening: boolean;
  lbDx: number;
  lbAnim: boolean;
  leftSlotW: string;
  leftSlotM: string;
  leftSlotTr: string;
  leftBtnOp: number;
  leftBtnPe: 'auto' | 'none';
  sbBtnOp: number;
  lbTr: string;
  dragging: boolean;
  setDragging: (dragging: boolean) => void;
};

const LeftPanelContext = createContext<LeftPanelValue | null>(null);

export function LeftPanelProvider({ children }: { children: ReactNode }) {
  const [leftOpen, setLeftOpenState] = useState(() => defaultLeftOpen(typeof window !== 'undefined' ? window.innerWidth : 1440));
  const [leftOpening, setLeftOpening] = useState(false);
  const [lbDx, setLbDx] = useState(0);
  const [lbAnim, setLbAnim] = useState(false);
  const [dragging, setDragging] = useState(false);
  const lbOffRef = useRef<number | null>(null);
  const leftTimer = useRef<number | null>(null);
  const lastWidth = useRef(typeof window !== 'undefined' ? window.innerWidth : 1440);

  const setLeftOpen = useCallback((open: boolean) => {
    setLeftOpenState(open);
    setLeftOpening(false);
    setLbAnim(false);
    setLbDx(0);
    persistLeftOpen(open, typeof window !== 'undefined' ? window.innerWidth : 1440);
  }, []);

  const toggleLeft = useCallback(() => {
    if (typeof window !== 'undefined' && isOverlayWidth(window.innerWidth)) {
      setLeftOpen(!leftOpen);
      return;
    }
    const closing = leftOpen;
    if (closing) {
      const sb = document.querySelector<HTMLElement>('[data-testid="next-left-collapse"]')
        || document.querySelector<HTMLElement>('[title="收起侧栏"]');
      const as = sb?.closest('aside');
      if (sb && as) {
        lbOffRef.current = as.getBoundingClientRect().right - sb.getBoundingClientRect().left;
      }
    }
    const dx = -Math.round((lbOffRef.current || 46) + 13);
    if (closing) {
      setLeftOpenState(false);
      persistLeftOpen(false, typeof window !== 'undefined' ? window.innerWidth : 1440);
      setLeftOpening(false);
      setLbAnim(false);
      setLbDx(dx);
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            setLbAnim(true);
            setLbDx(0);
          });
        });
      }
    } else {
      setLeftOpenState(true);
      persistLeftOpen(true, typeof window !== 'undefined' ? window.innerWidth : 1440);
      setLeftOpening(true);
      setLbAnim(true);
      setLbDx(dx);
    }
    if (leftTimer.current) window.clearTimeout(leftTimer.current);
    leftTimer.current = window.setTimeout(() => {
      if (!closing) {
        setLeftOpening(false);
      }
    }, 230);
  }, [leftOpen, setLeftOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      const vw = window.innerWidth;
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

  const leftSlotW = leftOpen ? '0px' : '30px';
  const leftSlotM = leftOpen ? '-8px' : '0px';
  const leftSlotTr = dragging
    ? 'none'
    : 'width .22s cubic-bezier(.3,.8,.3,1), margin-right .22s cubic-bezier(.3,.8,.3,1)';
  const leftBtnOp = !leftOpen || leftOpening ? 1 : 0;
  const leftBtnPe: 'auto' | 'none' = !leftOpen ? 'auto' : 'none';
  const sbBtnOp = leftOpen && !leftOpening ? 1 : 0;
  const lbTr = lbAnim && !dragging ? 'transform .22s cubic-bezier(.3,.8,.3,1)' : 'none';

  const value = useMemo<LeftPanelValue>(() => ({
    leftOpen,
    setLeftOpen,
    toggleLeft,
    leftOpening,
    lbDx,
    lbAnim,
    leftSlotW,
    leftSlotM,
    leftSlotTr,
    leftBtnOp,
    leftBtnPe,
    sbBtnOp,
    lbTr,
    dragging,
    setDragging,
  }), [
    leftOpen,
    setLeftOpen,
    toggleLeft,
    leftOpening,
    lbDx,
    lbAnim,
    leftSlotW,
    leftSlotM,
    leftSlotTr,
    leftBtnOp,
    leftBtnPe,
    sbBtnOp,
    lbTr,
    dragging,
  ]);

  return <LeftPanelContext.Provider value={value}>{children}</LeftPanelContext.Provider>;
}

export function useLeftPanel(): LeftPanelValue {
  const value = useContext(LeftPanelContext);
  if (!value) throw new Error('useLeftPanel requires LeftPanelProvider');
  return value;
}
