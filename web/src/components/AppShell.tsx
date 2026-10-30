import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { removeWorkspace } from '../data/api';
import type { Lang } from '../data/lang';
import {
  clampNum,
  defaultRightOpen,
  isOverlayWidth,
  isRightOverlayWidth,
  LEFT_W_DEFAULT,
  LEFT_W_MAX,
  LEFT_W_MIN,
  readActiveWorkspace,
  readLeftWidth,
  RIGHT_OVERLAY_MAX,
  RIGHT_W_DEFAULT,
  RIGHT_W_MAX,
  RIGHT_W_MIN,
  writeActiveWorkspace,
  writeLeftWidth,
} from '../data/layout';
import { usePanelMotionReady } from '../data/panelMotion';
import { LeftPanelProvider, useLeftPanel } from '../data/leftPanelContext';
import { RightPaneProvider, useRightLayout } from '../data/rightPaneContext';
import { conversationPath, draftPath, navigate, newChatPath, rememberSettingsBehind } from '../data/nav';
import {
  latestConversation,
  NO_PROJECT_ID,
  pickDraftWorkspace,
  storedActiveWorkspaceId,
} from '../data/sidebarModel';
import { useWorkspaces } from '../data/useWorkspaces';
import { t } from '../i18n';
import type { SettingsPage } from '../data/settingsPages';
import type { AppRoute } from '../route';
import { CenterPane } from './CenterPane';
import { ConfirmDialog, type ConfirmOpts } from './ConfirmDialog';
import { RightPane } from './RightPane';
import { SettingsOverlay } from './settings/SettingsOverlay';
import type { AboutService } from './settings/AboutPage';
import { Sidebar } from './Sidebar';
import { WorkspaceDialog } from './WorkspaceDialog';

type Props = {
  route: AppRoute;
  lang: Lang;
  demo?: boolean;
  service: AboutService;
  settingsPage?: SettingsPage | null;
};

function overlayKeepOpen(target: HTMLElement): boolean {
  return Boolean(
    target.closest?.('.md-path, [data-testid=next-right-toggle], [data-testid=next-right], [data-testid=next-tool-row][data-tool=edit], [data-testid=next-tool-row][data-tool=write]'),
  );
}

export function AppShell({ route, lang, demo = false, service, settingsPage = null }: Props) {
  const { workspaces, conversations, latest, ready } = useWorkspaces();
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const [homeStandIn, setHomeStandIn] = useState<AppRoute | null>(null);

  useEffect(() => {
    if (route.name !== 'home') {
      setHomeStandIn((current) => (current ? null : current));
      return;
    }
    if (!ready) return;
    if (latest) {
      const latestWs = workspaces.find((item) => item.id === latest.workspaceId);
      writeActiveWorkspace(storedActiveWorkspaceId(latestWs));
      const path = conversationPath(latest.id);
      if (settingsPage) {
        rememberSettingsBehind(path);
        setHomeStandIn((current) => (
          current?.name === 'conversation' && current.id === latest.id
            ? current
            : { name: 'conversation', id: latest.id }
        ));
        return;
      }
      navigate(path, { replace: true });
      return;
    }
    const ws = pickDraftWorkspace(workspaces, readActiveWorkspace());
    if (ws) {
      writeActiveWorkspace(ws.id);
      const path = draftPath(ws.id);
      if (settingsPage) {
        rememberSettingsBehind(path);
        setHomeStandIn((current) => (
          current?.name === 'draft' && current.workspaceId === ws.id
            ? current
            : { name: 'draft', workspaceId: ws.id }
        ));
        return;
      }
      navigate(path, { replace: true });
      return;
    }
    writeActiveWorkspace(NO_PROJECT_ID);
    const path = newChatPath();
    if (settingsPage) {
      rememberSettingsBehind(path);
      setHomeStandIn((current) => (current?.name === 'new' ? current : { name: 'new' }));
      return;
    }
    navigate(path, { replace: true });
  }, [route.name, ready, latest, workspaces, settingsPage]);

  const viewRoute = route.name === 'home' && homeStandIn ? homeStandIn : route;

  const activeConversationId = viewRoute.name === 'conversation'
    ? viewRoute.id
    : viewRoute.name === 'subagent'
      ? viewRoute.conversationId
      : null;
  const draftWorkspaceId = viewRoute.name === 'draft' ? viewRoute.workspaceId : null;
  const workspaceId = draftWorkspaceId
    || conversations.find((conv) => conv.id === activeConversationId)?.workspaceId
    || null;

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  return (
    <LeftPanelProvider>
      <RightPaneProvider
        conversationId={activeConversationId}
        workspaceId={workspaceId}
        lang={lang}
        onToast={showToast}
      >
        <AppShellLayout
          route={viewRoute}
          lang={lang}
          demo={demo}
          service={service}
          settingsPage={settingsPage}
          toast={toast}
          onToast={showToast}
          workspaces={workspaces}
          conversations={conversations}
        />
      </RightPaneProvider>
    </LeftPanelProvider>
  );
}

type LayoutProps = {
  route: AppRoute;
  lang: Lang;
  demo: boolean;
  service: AboutService;
  settingsPage: SettingsPage | null;
  toast: string | null;
  onToast: (message: string) => void;
  workspaces: ReturnType<typeof useWorkspaces>['workspaces'];
  conversations: ReturnType<typeof useWorkspaces>['conversations'];
};

function AppShellLayout({
  route,
  lang,
  demo,
  service,
  settingsPage,
  toast,
  onToast,
  workspaces,
  conversations,
}: LayoutProps) {
  const { open, setOpen, width, setWidth, persistWidth } = useRightLayout();
  const { leftOpen, setLeftOpen, dragging, setDragging } = useLeftPanel();
  const [leftW, setLeftW] = useState(() => readLeftWidth());
  const motionReady = usePanelMotionReady();
  const [confirm, setConfirm] = useState<{
    opts: ConfirmOpts;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [wsDialog, setWsDialog] = useState(false);
  const leftWRef = useRef(leftW);
  leftWRef.current = leftW;
  const rightWRef = useRef(width);
  rightWRef.current = width;
  const leftOpenRef = useRef(leftOpen);
  leftOpenRef.current = leftOpen;
  const lastWidth = useRef(window.innerWidth);

  const activeConversationId = route.name === 'conversation'
    ? route.id
    : route.name === 'subagent'
      ? route.conversationId
      : null;
  const activeAgentId = route.name === 'subagent' ? route.agentId : null;
  const isDraftRoute = route.name === 'draft' || route.name === 'new';
  const draftWorkspaceId = route.name === 'draft' ? route.workspaceId : null;

  useEffect(() => {
    if (route.name === 'new') writeActiveWorkspace(NO_PROJECT_ID);
  }, [route.name]);

  const conversationWorkspaceId = activeConversationId
    ? conversations.find((conv) => conv.id === activeConversationId)?.workspaceId
    : null;
  const workspace = (draftWorkspaceId || conversationWorkspaceId)
    ? workspaces.find((item) => item.id === (draftWorkspaceId || conversationWorkspaceId))
    : undefined;
  const workspaceLabel = workspace?.path || workspace?.name || t(lang, 'chats_label');

  useEffect(() => {
    const onResize = () => {
      const vw = window.innerWidth;
      if (lastWidth.current >= RIGHT_OVERLAY_MAX && vw < RIGHT_OVERLAY_MAX) {
        setOpen(false);
      }
      if (lastWidth.current < RIGHT_OVERLAY_MAX && vw >= RIGHT_OVERLAY_MAX) {
        setOpen(defaultRightOpen(vw));
      }
      lastWidth.current = vw;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setOpen]);

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
    const currentWs = draftWorkspaceId
      || conversations.find((conv) => conv.id === activeConversationId)?.workspaceId
      || null;
    if (currentWs !== workspaceId) return;
    const remaining = conversations.filter((conv) => conv.workspaceId !== workspaceId);
    const next = latestConversation(remaining);
    if (next) {
      const nextWs = workspaces.find((ws) => ws.id === next.workspaceId);
      writeActiveWorkspace(storedActiveWorkspaceId(nextWs));
      navigate(conversationPath(next.id), { replace: true });
      return;
    }
    const nextWs = pickDraftWorkspace(workspaces, null);
    if (nextWs && nextWs.id !== workspaceId) {
      writeActiveWorkspace(nextWs.id);
      navigate(draftPath(nextWs.id), { replace: true });
      return;
    }
    writeActiveWorkspace(NO_PROJECT_ID);
    navigate(newChatPath(), { replace: true });
  }, [activeConversationId, conversations, draftWorkspaceId, workspaces]);

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
      setWidth(clampNum(startRight - (e.clientX - startX), RIGHT_W_MIN, max));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDragging(false);
      if (side === 'left') writeLeftWidth(leftWRef.current);
      else persistWidth(rightWRef.current);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function onShellPointerDown(ev: PointerEvent<HTMLDivElement>) {
    const target = ev.target as HTMLElement;
    if (!target.closest?.('.col-center')) return;
    if (overlayKeepOpen(target)) return;
    if (isOverlayWidth(window.innerWidth) && leftOpen) setLeftOpen(false);
    if (isRightOverlayWidth(window.innerWidth) && open) setOpen(false);
  }

  const classes = [
    'next-shell',
    motionReady ? 'is-ready' : '',
    !leftOpen ? 'left-closed' : '',
    !open ? 'right-closed' : '',
    dragging ? 'is-dragging' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      data-testid="next-app"
      data-panel-ready={motionReady ? '1' : '0'}
      style={{
        ['--left-w' as string]: `${leftW}px`,
        ['--right-w' as string]: `${width}px`,
      }}
      onPointerDown={onShellPointerDown}
    >
      <Sidebar
        lang={lang}
        collapsed={!leftOpen}
        activeConversationId={activeConversationId}
        activeAgentId={activeAgentId}
        draftWorkspaceId={draftWorkspaceId}
        onCollapse={() => setLeftOpen(false)}
        onToast={onToast}
        onConfirm={askConfirm}
        onRemoveWorkspace={onRemoveWorkspace}
        onNewWorkspace={() => setWsDialog(true)}
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
      <CenterPane
        // 草稿页和对话页用不同的 key：从对话页切回草稿页时重新挂载，
        // 草稿里记住的“已创建对话”（useDraftSend）只在这一次草稿访问内有效。
        key={isDraftRoute ? 'draft' : 'conversation'}
        cid={activeConversationId}
        workspaceId={draftWorkspaceId}
        workspace={workspace || null}
        isDraft={isDraftRoute}
        lang={lang}
        demo={demo}
        onOpenLeft={() => setLeftOpen(true)}
        onNewWorkspace={() => setWsDialog(true)}
      />
      <div
        className="col-divider"
        data-testid="next-right-divider"
        data-side="right"
        title={t(lang, 'drag_resize')}
        onMouseDown={(ev) => onDividerDown(ev, 'right')}
        onDoubleClick={() => {
          setWidth(RIGHT_W_DEFAULT);
          persistWidth(RIGHT_W_DEFAULT);
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
      {settingsPage ? (
        <SettingsOverlay
          page={settingsPage}
          lang={lang}
          service={service}
          onToast={onToast}
          onConfirm={askConfirm}
        />
      ) : null}
      {wsDialog ? (
        <WorkspaceDialog
          lang={lang}
          onClose={() => setWsDialog(false)}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}
