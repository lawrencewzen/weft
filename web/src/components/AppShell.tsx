import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { removeWorkspace } from '../data/api';
import type { Lang } from '../data/lang';
import {
  clampNum,
  defaultLeftOpen,
  isOverlayWidth,
  LEFT_OVERLAY_MAX,
  LEFT_W_DEFAULT,
  LEFT_W_MAX,
  LEFT_W_MIN,
  LS_LEFT_OPEN,
  persistLeftOpen,
  readActiveWorkspace,
  readLeftWidth,
  readPref,
  writeActiveWorkspace,
  writeLeftWidth,
} from '../data/layout';
import { conversationPath, draftPath, navigate } from '../data/nav';
import { latestConversation, pickDraftWorkspace } from '../data/sidebarModel';
import { useWorkspaces } from '../data/useWorkspaces';
import { t } from '../i18n';
import type { AppRoute } from '../route';
import { CenterPane } from './CenterPane';
import { ConfirmDialog, type ConfirmOpts } from './ConfirmDialog';
import { Sidebar } from './Sidebar';

type Props = {
  route: AppRoute;
  lang: Lang;
};

export function AppShell({ route, lang }: Props) {
  const { workspaces, conversations, groups, latest, ready } = useWorkspaces();
  const [leftOpen, setLeftOpen] = useState(() => defaultLeftOpen(window.innerWidth));
  const [leftW, setLeftW] = useState(() => readLeftWidth());
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    opts: ConfirmOpts;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const leftWRef = useRef(leftW);
  leftWRef.current = leftW;
  const lastWidth = useRef(window.innerWidth);
  const toastTimer = useRef<number | null>(null);

  const activeConversationId = route.name === 'conversation' ? route.id : null;
  const draftWorkspaceId = route.name === 'draft' ? route.workspaceId : null;

  const visibleWorkspaces = workspaces.filter((ws) => !removedIds.includes(ws.id));
  const visibleConversations = conversations.filter((conv) => !removedIds.includes(conv.workspaceId));
  const visibleLatest = latest && !removedIds.includes(latest.workspaceId)
    ? latest
    : latestConversation(visibleConversations);

  useEffect(() => {
    if (route.name !== 'home' || !ready) return;
    if (visibleLatest) {
      writeActiveWorkspace(visibleLatest.workspaceId);
      navigate(conversationPath(visibleLatest.id), { replace: true });
      return;
    }
    const ws = pickDraftWorkspace(visibleWorkspaces, readActiveWorkspace());
    if (ws) {
      writeActiveWorkspace(ws.id);
      navigate(draftPath(ws.id), { replace: true });
    }
  }, [route.name, ready, visibleLatest, visibleWorkspaces]);

  useEffect(() => {
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
  }, []);

  const setOpen = useCallback((open: boolean) => {
    setLeftOpen(open);
    persistLeftOpen(open, window.innerWidth);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const askConfirm = useCallback((opts: ConfirmOpts) => {
    return new Promise<boolean>((resolve) => {
      setConfirm({ opts, resolve });
    });
  }, []);

  const finishConfirm = useCallback((ok: boolean) => {
    setConfirm((current) => {
      current?.resolve(ok);
      return null;
    });
  }, []);

  const onRemoveWorkspace = useCallback(async (workspaceId: string) => {
    await removeWorkspace(workspaceId);
    setRemovedIds((ids) => (ids.includes(workspaceId) ? ids : [...ids, workspaceId]));
    const currentWs = draftWorkspaceId
      || groups.find((group) => group.conversations.some((conv) => conv.id === activeConversationId))?.workspace.id
      || null;
    if (currentWs !== workspaceId) return;
    const remaining = conversations.filter((conv) => conv.workspaceId !== workspaceId);
    const next = latestConversation(remaining);
    if (next) {
      writeActiveWorkspace(next.workspaceId);
      navigate(conversationPath(next.id), { replace: true });
      return;
    }
    const nextWs = workspaces.find((ws) => ws.id !== workspaceId);
    if (nextWs) {
      writeActiveWorkspace(nextWs.id);
      navigate(draftPath(nextWs.id), { replace: true });
      return;
    }
    writeActiveWorkspace(null);
    navigate('/next/', { replace: true });
  }, [activeConversationId, conversations, draftWorkspaceId, groups, workspaces]);

  function onDividerDown(ev: MouseEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = leftWRef.current;
    setDragging(true);
    const move = (e: globalThis.MouseEvent) => {
      setLeftW(clampNum(startW + (e.clientX - startX), LEFT_W_MIN, LEFT_W_MAX));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDragging(false);
      writeLeftWidth(leftWRef.current);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function onShellPointerDown(ev: PointerEvent<HTMLDivElement>) {
    const target = ev.target as HTMLElement;
    if (!target.closest?.('.col-center')) return;
    if (isOverlayWidth(window.innerWidth) && leftOpen) setOpen(false);
  }

  const classes = [
    'next-shell',
    !leftOpen ? 'left-closed' : '',
    dragging ? 'is-dragging' : '',
  ].filter(Boolean).join(' ');

  const emptyHome = route.name === 'home' && ready && visibleWorkspaces.length === 0;

  return (
    <div
      className={classes}
      data-testid="next-app"
      style={{ ['--left-w' as string]: `${leftW}px` }}
      onPointerDown={onShellPointerDown}
    >
      <Sidebar
        lang={lang}
        activeConversationId={activeConversationId}
        draftWorkspaceId={draftWorkspaceId}
        onCollapse={() => setOpen(false)}
        onToast={showToast}
        onConfirm={askConfirm}
        onRemoveWorkspace={onRemoveWorkspace}
      />
      <div
        className="col-divider"
        data-testid="next-left-divider"
        data-side="left"
        title={t(lang, 'drag_resize')}
        onMouseDown={onDividerDown}
        onDoubleClick={() => {
          setLeftW(LEFT_W_DEFAULT);
          writeLeftWidth(LEFT_W_DEFAULT);
        }}
      />
      {emptyHome ? (
        <main className="col-center" data-testid="next-center">
          <header className="next-status">
            <div className="next-status-inner">
              {!leftOpen ? (
                <button
                  type="button"
                  className="icon-btn top-left-open"
                  data-testid="next-left-open"
                  title={t(lang, 'expand_sidebar')}
                  onClick={() => setOpen(true)}
                >
                  <span className="ico-panel ico-panel-left" aria-hidden="true" />
                </button>
              ) : null}
              <h1 className="top-title">{t(lang, 'home_title')}</h1>
            </div>
          </header>
          <div className="thread-empty">
            <p data-testid="next-home-hint">{t(lang, 'no_workspaces')}</p>
          </div>
        </main>
      ) : (
        <CenterPane
          cid={activeConversationId}
          workspaceId={draftWorkspaceId}
          lang={lang}
          showOpenLeft={!leftOpen}
          onOpenLeft={() => setOpen(true)}
        />
      )}
      {toast ? <div className="toast-msg" data-testid="next-toast">{toast}</div> : null}
      {confirm ? (
        <ConfirmDialog
          lang={lang}
          opts={confirm.opts}
          onCancel={() => finishConfirm(false)}
          onConfirm={() => finishConfirm(true)}
        />
      ) : null}
    </div>
  );
}
