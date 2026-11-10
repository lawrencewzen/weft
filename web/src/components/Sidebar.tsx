import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ApiError, archiveConversation, deleteConversation } from '../data/api';
import { copyText } from '../data/copyText';
import type { Lang } from '../data/lang';
import { readActiveWorkspace, readWorkspaceOpen, writeActiveWorkspace, writeWorkspaceOpen } from '../data/layout';
import { conversationPath, draftPath, navigate, newChatPath, openSettings, schedulesPath } from '../data/nav';
import { effectiveAppearance, subscribePrefs, toggleAppearance } from '../data/prefs';
import { useSession } from '../data/session';
import { useSchedules } from '../data/useSchedules';
import {
  deleteOpenRecord,
  NO_PROJECT_ID,
  pickDraftWorkspace,
  setOpenRecord,
  storedActiveWorkspaceId,
  toggleOpenRecord,
  workspaceIsOpen,
  type OpenRecord,
} from '../data/sidebarModel';
import { isMac, type SearchItem } from '../data/sidebarSearchModel';
import { readLastOpenedMap, writeLastOpened } from '../data/sidebarUnread';
import { isChatWorkspace, type ConversationSummary, type Workspace } from '../data/store';
import { useLeftPanel } from '../data/leftPanelContext';
import { useStripProjectsFlip } from '../data/stripProjectsMotion';
import { useRightActions } from '../data/rightPaneContext';
import { useWorkspaces } from '../data/useWorkspaces';
import { t } from '../i18n';
import type { ToastInput } from '../data/toast';
import { CtxMenu, type CtxMenuItem } from './CtxMenu';
import type { ConfirmOpts } from './ConfirmDialog';
import { SidebarArchived } from './SidebarArchived';
import { SidebarConvRow, SidebarGroup } from './SidebarGroup';
import {
  CLOCK_ICON,
  EDIT_ICON,
  FOLDER_ICON,
  GEAR_ICON,
  MOON_ICON,
  PLUS_ICON,
  SEARCH_ICON,
  SUN_ICON,
} from './SidebarIcons';
import { buildConversationItems, buildProjectItems } from './SidebarMenus';
import { ArchiveIcon } from './StatusIcon';
import { SidebarSearch } from './SidebarSearch';

type MenuState = {
  x: number;
  y: number;
  title: string;
  items: CtxMenuItem[];
};

type Props = {
  lang: Lang;
  activeConversationId: string | null;
  activeAgentId: string | null;
  draftWorkspaceId: string | null;
  onToast: (toast: ToastInput) => void;
  onConfirm: (opts: ConfirmOpts) => Promise<boolean>;
  onRemoveWorkspace: (workspaceId: string) => Promise<void>;
  onNewWorkspace: () => void;
  wsBusy?: boolean;
  isSchedulesActive?: boolean;
};

export function Sidebar({
  lang,
  activeConversationId,
  draftWorkspaceId,
  onToast,
  onConfirm,
  onRemoveWorkspace,
  onNewWorkspace,
  wsBusy = false,
  isSchedulesActive = false,
}: Props) {
  const { workspaces, groups, chats, archived } = useWorkspaces();
  const { enabledCount } = useSchedules();
  const { status } = useSession();
  const { showFiles, openInTerminal } = useRightActions();
  const { leftOpen, setLeftOpen } = useLeftPanel();
  const collapsed = !leftOpen;
  const sidebarRef = useRef<HTMLElement | null>(null);
  const stripBtnRef = useRef<HTMLButtonElement | null>(null);
  const [openMap, setOpenMap] = useState<OpenRecord>(() => readWorkspaceOpen());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dark, setDark] = useState(() => effectiveAppearance() === 'dark');
  const [lastOpenedMap, setLastOpenedMap] = useState<Record<string, number>>(() => readLastOpenedMap());
  const serviceOk = status === 'connected';

  useStripProjectsFlip({
    leftOpen,
    stripBtnRef,
    sidebarRef,
    hasProjects: groups.length > 0,
  });

  useEffect(() => subscribePrefs(() => setDark(effectiveAppearance() === 'dark')), []);

  useEffect(() => {
    if (activeConversationId) {
      writeLastOpened(activeConversationId);
      setLastOpenedMap((prev) => ({ ...prev, [activeConversationId]: Date.now() }));
    }
  }, [activeConversationId]);

  const activeWorkspaceId = useMemo(() => {
    if (draftWorkspaceId) return draftWorkspaceId;
    if (!activeConversationId) return null;
    return groups.find((g) => g.conversations.some((c) => c.id === activeConversationId))?.workspace.id || null;
  }, [groups, activeConversationId, draftWorkspaceId]);

  const persistOpen = useCallback((next: OpenRecord) => {
    setOpenMap(next);
    writeWorkspaceOpen(next);
  }, []);

  useEffect(() => {
    if (!draftWorkspaceId) return;
    setOpenMap((prev) => {
      if (prev[draftWorkspaceId] === true) return prev;
      const next = setOpenRecord(prev, draftWorkspaceId, true);
      writeWorkspaceOpen(next);
      return next;
    });
  }, [draftWorkspaceId]);

  const isOpen = useCallback((wsId: string, isActive: boolean) => workspaceIsOpen(wsId, isActive, openMap), [openMap]);

  const toggleProject = useCallback((wsId: string, isActive: boolean) => {
    const currentlyOpen = workspaceIsOpen(wsId, isActive, openMap);
    persistOpen(toggleOpenRecord(openMap, wsId, currentlyOpen));
  }, [openMap, persistOpen]);

  const startDraft = useCallback((wsId: string) => {
    persistOpen(setOpenRecord(openMap, wsId, true));
    writeActiveWorkspace(wsId);
    navigate(draftPath(wsId));
  }, [openMap, persistOpen]);

  const startNewChat = useCallback(() => {
    // 先看当前所在的对话或草稿，再退回上次记住的选择。
    const inChat = Boolean(activeConversationId && chats.some((conv) => conv.id === activeConversationId));
    const current = inChat ? NO_PROJECT_ID : activeWorkspaceId;
    const ws = pickDraftWorkspace(workspaces, current || readActiveWorkspace());
    if (ws) {
      startDraft(ws.id);
      return;
    }
    writeActiveWorkspace(NO_PROJECT_ID);
    navigate(newChatPath());
  }, [activeConversationId, activeWorkspaceId, chats, startDraft, workspaces]);

  const openConversation = useCallback((wsId: string, cid: string) => {
    const ws = workspaces.find((item) => item.id === wsId);
    writeActiveWorkspace(storedActiveWorkspaceId(ws));
    writeLastOpened(cid);
    setLastOpenedMap((prev) => ({ ...prev, [cid]: Date.now() }));
    navigate(conversationPath(cid));
  }, [workspaces]);

  const copy = useCallback(async (text: string) => {
    const ok = await copyText(text);
    onToast(t(lang, ok ? 'copied' : 'err_copy'));
  }, [lang, onToast]);

  const removeWorkspace = useCallback(async (ws: Workspace) => {
    const ok = await onConfirm({
      title: t(lang, 'ws_remove_title', { name: ws.name }),
      message: t(lang, 'ws_remove_message', { path: ws.path || '' }),
      confirmLabel: t(lang, 'ws_remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await onRemoveWorkspace(ws.id);
      persistOpen(deleteOpenRecord(openMap, ws.id));
      onToast(t(lang, 'ws_removed', { name: ws.name }));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.code === 'E_WS_BUSY')) {
        onToast(t(lang, 'ws_remove_busy'));
        return;
      }
      onToast(err instanceof Error ? err.message : t(lang, 'ws_remove_busy'));
    }
  }, [lang, onConfirm, onRemoveWorkspace, onToast, openMap, persistOpen]);

  const openMenu = useCallback((ev: MouseEvent, items: CtxMenuItem[], title: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    const fromClick = ev.type === 'click';
    const target = ev.currentTarget as HTMLElement;
    const rect = fromClick ? target.getBoundingClientRect() : null;
    setMenu({
      x: rect ? rect.left : ev.clientX,
      y: rect ? rect.bottom + 4 : ev.clientY,
      title,
      items,
    });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const handleShowFiles = useCallback((wsId: string) => {
    writeActiveWorkspace(wsId);
    if (wsId !== activeWorkspaceId) {
      const latest = groups.find((group) => group.workspace.id === wsId)?.conversations[0];
      if (latest) navigate(conversationPath(latest.id));
      else navigate(draftPath(wsId));
    }
    showFiles();
  }, [activeWorkspaceId, groups, showFiles]);

  const projectItems = useCallback((ws: Workspace): CtxMenuItem[] => buildProjectItems({
    lang,
    ws,
    onNewWorkspace,
    startDraft,
    copy,
    openInTerminal,
    showFiles: handleShowFiles,
    removeWorkspace,
  }), [copy, handleShowFiles, lang, onNewWorkspace, openInTerminal, removeWorkspace, startDraft]);

  const handleArchive = useCallback(async (conv: ConversationSummary, archived: boolean) => {
    try {
      await archiveConversation(conv.id, archived);
      if (archived) {
        onToast({
          message: t(lang, 'conversation_archived', { title: conv.title || t(lang, 'default_conversation_title') }),
          action: {
            label: t(lang, 'toast_undo'),
            run: () => {
              void handleArchive(conv, false);
            },
          },
        });
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : t(lang, 'err_request_failed'));
    }
  }, [lang, onToast]);

  const handleDelete = useCallback(async (conv: ConversationSummary) => {
    const title = conv.title || t(lang, 'default_conversation_title');
    const ok = await onConfirm({
      title: t(lang, 'delete_conversation_title'),
      message: t(lang, 'delete_conversation_message', { title }),
      confirmLabel: t(lang, 'delete_conversation'),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteConversation(conv.id);
      if (activeConversationId === conv.id) {
        const ws = workspaces.find((item) => item.id === conv.workspaceId);
        if (ws && !isChatWorkspace(ws)) {
          startDraft(ws.id);
        } else {
          writeActiveWorkspace(NO_PROJECT_ID);
          navigate(newChatPath());
        }
      }
      onToast(t(lang, 'conversation_deleted', { title }));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.code === 'E_CONVERSATION_RUNNING')) {
        onToast(err.message || t(lang, 'stop_conversation_first'));
        return;
      }
      onToast(err instanceof Error ? err.message : t(lang, 'err_request_failed'));
    }
  }, [activeConversationId, lang, onConfirm, onToast, startDraft, workspaces]);

  const conversationItems = useCallback((wsId: string, conv: ConversationSummary): CtxMenuItem[] => (
    buildConversationItems({
      lang,
      wsId,
      conv,
      openConversation,
      copy,
      onArchive: handleArchive,
      onDelete: handleDelete,
    })
  ), [copy, handleArchive, handleDelete, lang, openConversation]);

  const chatSearchItems: SearchItem[] = useMemo(() => {
    const byId = new Map(workspaces.map((ws) => [ws.id, ws]));
    const items: SearchItem[] = [];
    for (const conv of chats) {
      const workspace = byId.get(conv.workspaceId);
      if (workspace) items.push({ conv, workspace });
    }
    return items;
  }, [chats, workspaces]);
  const modKey = isMac() ? '⌘' : 'Ctrl+';

  useEffect(() => {
    function onKeyDown(ev: globalThis.KeyboardEvent) {
      const isMod = ev.metaKey || ev.ctrlKey;
      if (!isMod) return;
      const key = ev.key.toLowerCase();
      if (key === 'k') {
        ev.preventDefault();
        setSearchOpen(true);
      } else if (key === 'n' && !ev.shiftKey && !ev.altKey) {
        ev.preventDefault();
        startNewChat();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [startNewChat]);

  return (
    <aside
      ref={sidebarRef}
      className="col-left sb"
      data-testid="next-sidebar"
    >
      <div className="col-panel-inner">
        <div className="sb-hd hd">
          <span className="sb-brand brand">Weft</span>
        </div>

        <button
          type="button"
          className="sb-row row sb-top-row"
          data-testid="next-new-chat"
          title={t(lang, 'new_conversation')}
          aria-label={t(lang, 'new_conversation')}
          onClick={() => startNewChat()}
        >
          <span className="sb-ic ic" aria-hidden="true">{EDIT_ICON}</span>
          <span className="sb-row-text">{t(lang, 'new_conversation')}</span>
          <span className="sb-kbd kbd" aria-hidden="true">{modKey}N</span>
        </button>

        <button
          type="button"
          className="sb-row row sb-top-row"
          data-testid="next-search"
          title={t(lang, 'search')}
          aria-label={t(lang, 'search')}
          onClick={() => {
            if (collapsed) setLeftOpen(true);
            setSearchOpen(true);
          }}
        >
          <span className="sb-ic ic" aria-hidden="true">{SEARCH_ICON}</span>
          <span className="sb-row-text">{t(lang, 'search')}</span>
          <span className="sb-kbd kbd" aria-hidden="true">{modKey}K</span>
        </button>

        <button
          type="button"
          className={`sb-row row sb-top-row${isSchedulesActive ? ' sel' : ''}`}
          data-testid="next-schedules"
          title={t(lang, 'schedules_nav')}
          aria-label={t(lang, 'schedules_nav')}
          onClick={() => {
            if (collapsed) setLeftOpen(true);
            navigate(schedulesPath());
          }}
        >
          <span className="sb-ic ic" aria-hidden="true">{CLOCK_ICON}</span>
          <span className="sb-row-text">{t(lang, 'schedules_nav')}</span>
          {enabledCount > 0 ? (
            <span
              className="sb-count-badge next-schedules-badge"
              data-testid="next-schedules-count"
            >
              {enabledCount}
            </span>
          ) : null}
        </button>

        <button
          ref={stripBtnRef}
          type="button"
          className="sb-row row sb-top-row sb-strip-projects"
          data-testid="next-strip-projects"
          title={t(lang, 'projects_label')}
          aria-label={t(lang, 'projects_label')}
          onClick={() => setLeftOpen(true)}
        >
          <span className="sb-ic ic" aria-hidden="true">{FOLDER_ICON}</span>
          <span className="sb-row-text">{t(lang, 'projects_label')}</span>
        </button>

        <div
          className="sb-scroll scroll left-body"
          inert={collapsed || undefined}
          aria-hidden={collapsed || undefined}
        >
          <div className="sb-sec sec">
            <span>{t(lang, 'projects_label')}</span>
            <button
              type="button"
              className={`sb-sec-add add btn-icon-xs${wsBusy ? ' is-busy' : ''}`}
              data-testid="next-ws-new"
              disabled={wsBusy}
              title={t(lang, 'add_project')}
              aria-label={t(lang, 'new_workspace')}
              onClick={onNewWorkspace}
            >
              {wsBusy ? <span className="sb-spin" aria-hidden="true" /> : PLUS_ICON}
            </button>
          </div>

          <div className="sb-tree-root tree-root">
            {groups.map((group) => (
              <SidebarGroup
                key={group.workspace.id}
                ws={group.workspace}
                conversations={group.conversations}
                isActive={group.workspace.id === activeWorkspaceId}
                isOpen={isOpen(group.workspace.id, group.workspace.id === activeWorkspaceId)}
                activeConversationId={activeConversationId}
                lastOpenedMap={lastOpenedMap}
                lang={lang}
                onToggleProject={toggleProject}
                onStartDraft={startDraft}
                onOpenConversation={openConversation}
                onOpenMenu={openMenu}
                projectItems={projectItems}
                conversationItems={conversationItems}
              />
            ))}
            {!groups.length ? (
              <button
                type="button"
                className={`sb-row row sb-add-project${wsBusy ? ' is-busy' : ''}`}
                data-testid="next-ws-empty-add"
                disabled={wsBusy}
                onClick={onNewWorkspace}
              >
                <span className="sb-ic ic" aria-hidden="true">{wsBusy ? <span className="sb-spin" aria-hidden="true" /> : PLUS_ICON}</span>
                <span className="sb-row-text">{t(lang, 'add_project')}</span>
              </button>
            ) : null}
          </div>

          {chats.length ? (
            <>
              <div className="sb-sec sec" data-testid="next-chats-section">
                <span>{t(lang, 'chats_label')}</span>
              </div>
              <div className="sb-tree-root tree-root" data-testid="next-chats-list">
                {chats.map((conv) => (
                  <SidebarConvRow
                    key={conv.id}
                    conv={conv}
                    wsId={conv.workspaceId}
                    activeConversationId={activeConversationId}
                    lastOpenedMap={lastOpenedMap}
                    lang={lang}
                    onOpenConversation={openConversation}
                    onOpenMenu={openMenu}
                    conversationItems={conversationItems}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>

        {archivedOpen ? (
          <SidebarArchived
            lang={lang}
            archived={archived}
            activeConversationId={activeConversationId}
            onOpenConversation={openConversation}
            onOpenMenu={openMenu}
            conversationItems={conversationItems}
          />
        ) : null}

        <div className="sb-foot foot left-footer">
          <div className="sb-row row sb-foot-row">
            <button
              type="button"
              className="sb-foot-link foot-link"
              data-testid="next-open-settings"
              title={t(lang, 'settings_title')}
              aria-label={t(lang, 'settings_title')}
              onClick={() => openSettings('general')}
            >
              <span className="sb-ic ic" aria-hidden="true">{GEAR_ICON}</span>
              <span>{t(lang, 'settings_short')}</span>
            </button>
            <span
              className={`sb-svc svc foot-status-dot${serviceOk ? ' is-ok' : ''}`}
              data-testid="next-service-dot"
              data-ok={serviceOk ? 'true' : 'false'}
              title={t(lang, serviceOk ? 'service_ok' : 'service_reconnecting')}
              aria-label={t(lang, serviceOk ? 'service_ok' : 'service_reconnecting')}
            />
            <span className="sb-end end foot-right">
              <button
                type="button"
                className="sb-act act foot-archived"
                data-testid="next-archived-toggle"
                title={archived.length > 0 ? `${t(lang, 'archived_label')} (${archived.length})` : t(lang, 'archived_label')}
                aria-label={archived.length > 0 ? `${t(lang, 'archived_label')} (${archived.length})` : t(lang, 'archived_label')}
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((prev) => !prev)}
              >
                <ArchiveIcon size={14} />
                {archived.length > 0 ? (
                  <span className="sb-badge sidebar-archived-badge" data-testid="next-archived-count">
                    {archived.length}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="sb-act act foot-appearance"
                data-testid="next-appearance-toggle"
                title={t(lang, dark ? 'appearance_to_light' : 'appearance_to_dark')}
                aria-label={t(lang, dark ? 'appearance_to_light' : 'appearance_to_dark')}
                aria-pressed={dark ? 'true' : 'false'}
                onClick={() => toggleAppearance()}
              >
                {dark ? SUN_ICON : MOON_ICON}
              </button>
            </span>
          </div>
        </div>
      </div>

      <SidebarSearch
        lang={lang}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        groups={groups}
        extra={chatSearchItems}
        onSelectConversation={openConversation}
      />

      {menu ? (
        <CtxMenu
          x={menu.x}
          y={menu.y}
          title={menu.title}
          items={menu.items}
          onClose={closeMenu}
        />
      ) : null}
    </aside>
  );
}
