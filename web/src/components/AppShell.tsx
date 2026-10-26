import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { removeWorkspace } from '../data/api';
import type { Lang } from '../data/lang';
import {
  clampNum,
  defaultLeftOpen,
  defaultRightOpen,
  isOverlayWidth,
  isRightOverlayWidth,
  LEFT_OVERLAY_MAX,
  LEFT_W_DEFAULT,
  LEFT_W_MAX,
  LEFT_W_MIN,
  LS_LEFT_OPEN,
  persistLeftOpen,
  readActiveWorkspace,
  readLeftWidth,
  readPref,
  RIGHT_OVERLAY_MAX,
  RIGHT_W_DEFAULT,
  RIGHT_W_MAX,
  RIGHT_W_MIN,
  writeActiveWorkspace,
  writeLeftWidth,
} from '../data/layout';
import { RightPaneProvider, useRightPane } from '../data/rightPaneContext';
import { conversationPath, draftPath, navigate } from '../data/nav';
import { latestConversation, pickDraftWorkspace } from '../data/sidebarModel';
import { useWorkspaces } from '../data/useWorkspaces';
import { t } from '../i18n';
import type { AppRoute } from '../route';
import { CenterPane } from './CenterPane';
import { ConfirmDialog, type ConfirmOpts } from './ConfirmDialog';
import { DemoModelBadge } from './DemoModelBadge';
import { RightPane } from './RightPane';
import { RightToggle } from './RightToggle';
import { Sidebar } from './Sidebar';

type Props = {
  route: AppRoute;
  lang: Lang;
  demo?: boolean;
};

function overlayKeepOpen(target: HTMLElement): boolean {
  return Boolean(
    target.closest?.('.md-path, [data-testid=next-right-toggle], [data-testid=next-right], [data-testid=next-tool-row][data-tool=edit], [data-testid=next-tool-row][data-tool=write]'),
  );
}

export function AppShell({ route, lang, demo = false }: Props) {
  const { workspaces, conversations, groups, latest, ready } = useWorkspaces();
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const activeConversationId = route.name === 'conversation'
    ? route.id
    : route.name === 'subagent'
      ? route.conversationId
      : null;
  const draftWorkspaceId = route.name === 'draft' ? route.workspaceId : null;
  const workspaceId = draftWorkspaceId
    || groups.find((group) => group.conversations.some((conv) => conv.id === activeConversationId))?.workspace.id
    || null;

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  return (
    <RightPaneProvider
      conversationId={activeConversationId}
      workspaceId={workspaceId}
      lang={lang}
      onToast={showToast}
    >
      <AppShellLayout
        route={route}
        lang={lang}
        demo={demo}
        toast={toast}
        onToast={showToast}
        workspaces={workspaces}
        conversations={conversations}
        groups={groups}
        latest={latest}
        ready={ready}
      />
    </RightPaneProvider>
  );
}

type LayoutProps = {
  route: AppRoute;
  lang: Lang;
  demo: boolean;
  toast: string | null;
  onToast: (message: string) => void;
  workspaces: ReturnType<typeof useWorkspaces>['workspaces'];
  conversations: ReturnType<typeof useWorkspaces>['conversations'];
  groups: ReturnType<typeof useWorkspaces>['groups'];
  latest: ReturnType<typeof useWorkspaces>['latest'];
  ready: boolean;
};

function AppShellLayout({
  route,
  lang,
  demo,
  toast,
  onToast,
  workspaces,
  conversations,
  groups,
  latest,
  ready,
}: LayoutProps) {
  const right = useRightPane();
  const [leftOpen, setLeftOpen] = useState(() => defaultLeftOpen(window.innerWidth));
  const [leftW, setLeftW] = useState(() => readLeftWidth());
  const [dragging, setDragging] = useState(false);
  const [confirm, setConfirm] = useState<{
    opts: ConfirmOpts;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const leftWRef = useRef(leftW);
  leftWRef.current = leftW;
  const rightWRef = useRef(right.width);
  rightWRef.current = right.width;
  const leftOpenRef = useRef(leftOpen);
  leftOpenRef.current = leftOpen;
  const lastWidth = useRef(window.innerWidth);

  const activeConversationId = route.name === 'conversation'
    ? route.id
    : route.name === 'subagent'
      ? route.conversationId
      : null;
  const activeAgentId = route.name === 'subagent' ? route.agentId : null;
  const draftWorkspaceId = route.name === 'draft' ? route.workspaceId : null;

  const visibleWorkspaces = workspaces.filter((ws) => !removedIds.includes(ws.id));
  const visibleConversations = conversations.filter((conv) => !removedIds.includes(conv.workspaceId));
  const visibleLatest = latest && !removedIds.includes(latest.workspaceId)
    ? latest
    : latestConversation(visibleConversations);

  const workspace = draftWorkspaceId
    ? workspaces.find((item) => item.id === draftWorkspaceId)
    : groups.find((group) => group.conversations.some((conv) => conv.id === activeConversationId))?.workspace;
  const workspaceLabel = workspace?.path || workspace?.name || '';

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
      if (lastWidth.current >= RIGHT_OVERLAY_MAX && vw < RIGHT_OVERLAY_MAX) {
        right.setOpen(false);
      }
      if (lastWidth.current < RIGHT_OVERLAY_MAX && vw >= RIGHT_OVERLAY_MAX) {
        right.setOpen(defaultRightOpen(vw));
      }
      lastWidth.current = vw;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [right]);

  const setOpen = useCallback((open: boolean) => {
    setLeftOpen(open);
    persistLeftOpen(open, window.innerWidth);
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

  function onDividerDown(ev: MouseEvent<HTMLDivElement>, side: 'left' | 'right') {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startLeft = leftWRef.current;
    const startRight = rightWRef.current;
    setDragging(true);
    const move = (e: globalThis.MouseEvent) => {
      if (side === 'left') {
        setLeftW(clampNum(startLeft + (e.clientX - startX), LEFT_W_MIN, LEFT_W_MAX));
        return;
      }
      const max = Math.min(
        RIGHT_W_MAX,
        Math.max(RIGHT_W_MIN, window.innerWidth - (leftOpenRef.current ? leftWRef.current : 0) - 420),
      );
      right.setWidth(clampNum(startRight - (e.clientX - startX), RIGHT_W_MIN, max));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDragging(false);
      if (side === 'left') writeLeftWidth(leftWRef.current);
      else right.persistWidth(rightWRef.current);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function onShellPointerDown(ev: PointerEvent<HTMLDivElement>) {
    const target = ev.target as HTMLElement;
    if (!target.closest?.('.col-center')) return;
    if (overlayKeepOpen(target)) return;
    if (isOverlayWidth(window.innerWidth) && leftOpen) setOpen(false);
    if (isRightOverlayWidth(window.innerWidth) && right.open) right.setOpen(false);
  }

  const classes = [
    'next-shell',
    !leftOpen ? 'left-closed' : '',
    !right.open ? 'right-closed' : '',
    dragging ? 'is-dragging' : '',
  ].filter(Boolean).join(' ');

  const emptyHome = route.name === 'home' && ready && visibleWorkspaces.length === 0;

  return (
    <div
      className={classes}
      data-testid="next-app"
      style={{
        ['--left-w' as string]: `${leftW}px`,
        ['--right-w' as string]: `${right.width}px`,
      }}
      onPointerDown={onShellPointerDown}
    >
      <Sidebar
        lang={lang}
        activeConversationId={activeConversationId}
        activeAgentId={activeAgentId}
        draftWorkspaceId={draftWorkspaceId}
        onCollapse={() => setOpen(false)}
        onToast={onToast}
        onConfirm={askConfirm}
        onRemoveWorkspace={onRemoveWorkspace}
      />
      <div
        className="col-divider"
        data-testid="next-left-divider"
        data-side="left"
        title={t(lang, 'drag_resize')}
        onMouseDown={(ev) => onDividerDown(ev, 'left')}
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
              {demo ? <DemoModelBadge lang={lang} testId="next-demo-model-badge" /> : null}
              <div className="top-right">
                <RightToggle lang={lang} />
              </div>
            </div>
          </header>
          <div className="thread-empty">
            <p data-testid="next-home-hint">{t(lang, 'no_workspaces')}</p>
          </div>
        </main>
      ) : (
        <CenterPane
          cid={activeConversationId}
          agentId={activeAgentId}
          workspaceId={draftWorkspaceId}
          lang={lang}
          demo={demo}
          showOpenLeft={!leftOpen}
          onOpenLeft={() => setOpen(true)}
        />
      )}
      <div
        className="col-divider"
        data-testid="next-right-divider"
        data-side="right"
        title={t(lang, 'drag_resize')}
        onMouseDown={(ev) => onDividerDown(ev, 'right')}
        onDoubleClick={() => {
          right.setWidth(RIGHT_W_DEFAULT);
          right.persistWidth(RIGHT_W_DEFAULT);
        }}
      />
      <RightPane lang={lang} workspaceLabel={workspaceLabel} />
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
