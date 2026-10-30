import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ApiError } from '../data/api';
import { copyText } from '../data/copyText';
import type { Lang } from '../data/lang';
import { readActiveWorkspace, readWorkspaceOpen, writeActiveWorkspace, writeWorkspaceOpen } from '../data/layout';
import { conversationPath, draftPath, navigate, newChatPath, openSettings } from '../data/nav';
import { effectiveAppearance, subscribePrefs, toggleAppearance } from '../data/prefs';
import { useSession } from '../data/session';
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
import type { ConversationSummary, Workspace } from '../data/store';
import { useLeftPanel } from '../data/leftPanelContext';
import { useRightActions, useRightLayout } from '../data/rightPaneContext';
import { useWorkspaces } from '../data/useWorkspaces';
import { t } from '../i18n';
import { CtxMenu, type CtxMenuItem } from './CtxMenu';
import type { ConfirmOpts } from './ConfirmDialog';
import { SidebarArchived } from './SidebarArchived';
import { SidebarConvRow, SidebarGroup } from './SidebarGroup';
import {
  EDIT_ICON,
  GEAR_ICON,
  MOON_ICON,
  PLUS_ICON,
  SEARCH_ICON,
  SIDE_ICON,
  SUN_ICON,
} from './SidebarIcons';
import { buildConversationItems, buildProjectItems } from './SidebarMenus';
import { SidebarSearch } from './SidebarSearch';

type MenuState = {
  x: number;
  y: number;
  title: string;
  items: CtxMenuItem[];
};

type Props = {
  lang: Lang;
  collapsed?: boolean;
  activeConversationId: string | null;
  activeAgentId: string | null;
  draftWorkspaceId: string | null;
  onCollapse: () => void;
  onToast: (message: string) => void;
  onConfirm: (opts: ConfirmOpts) => Promise<boolean>;
  onRemoveWorkspace: (workspaceId: string) => Promise<void>;
  onNewWorkspace: () => void;
};

export function Sidebar({
  lang,
  collapsed = false,
  activeConversationId,
  draftWorkspaceId,
  onCollapse,
  onToast,
  onConfirm,
  onRemoveWorkspace,
  onNewWorkspace,
}: Props) {
  const { workspaces, groups, chats, archived } = useWorkspaces();
  const { status } = useSession();
  const { tab, setTab } = useRightLayout();
  const { showFiles, openInTerminal } = useRightActions();
  const { toggleLeft, sbBtnOp } = useLeftPanel();
  const [openMap, setOpenMap] = useState<OpenRecord>(() => readWorkspaceOpen());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dark, setDark] = useState(() => effectiveAppearance() === 'dark');
  const [lastOpenedMap, setLastOpenedMap] = useState<Record<string, number>>(() => readLastOpenedMap());
  const serviceOk = status === 'connected';

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
    if (tab === 'subagents') setTab('changes');
    navigate(conversationPath(cid));
  }, [setTab, tab, workspaces]);

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

  const conversationItems = useCallback((wsId: string, conv: ConversationSummary): CtxMenuItem[] => (
    buildConversationItems({ lang, wsId, conv, openConversation, copy })
  ), [copy, lang, openConversation]);

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
      className="col-left sb"
      data-testid="next-sidebar"
      inert={collapsed || undefined}
      aria-hidden={collapsed || undefined}
    >
      <div className="col-panel-inner">
        <div className="sb-hd hd">
          <span className="sb-brand brand">Weft</span>
          <button
            type="button"
            className="sb-collapse collapse icon-btn"
            data-testid="next-left-collapse"
            title={t(lang, 'collapse_sidebar')}
            aria-label={t(lang, 'collapse_sidebar')}
            style={{
              opacity: sbBtnOp,
              pointerEvents: sbBtnOp ? 'auto' : 'none',
              visibility: sbBtnOp ? 'visible' : 'hidden',
            }}
            onClick={() => {
              if (toggleLeft) toggleLeft();
              else onCollapse();
            }}
          >
            {SIDE_ICON}
          </button>
        </div>

        <button
          type="button"
          className="sb-row row sb-top-row"
          data-testid="next-new-chat"
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
          onClick={() => setSearchOpen(true)}
        >
          <span className="sb-ic ic" aria-hidden="true">{SEARCH_ICON}</span>
          <span className="sb-row-text">{t(lang, 'search')}</span>
          <span className="sb-kbd kbd" aria-hidden="true">{modKey}K</span>
        </button>

        <div className="sb-scroll scroll left-body">
          <div className="sb-sec sec">
            <span>{t(lang, 'projects_label')}</span>
            <button
              type="button"
              className="sb-sec-add add btn-icon-xs"
              data-testid="next-ws-new"
              title={t(lang, 'add_project')}
              aria-label={t(lang, 'new_workspace')}
              onClick={onNewWorkspace}
            >
              {PLUS_ICON}
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
                className="sb-row row sb-add-project"
                data-testid="next-ws-empty-add"
                onClick={onNewWorkspace}
              >
                <span className="sb-ic ic" aria-hidden="true">{PLUS_ICON}</span>
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

        <SidebarArchived
          lang={lang}
          archived={archived}
          activeConversationId={activeConversationId}
          open={archivedOpen}
          onToggle={() => setArchivedOpen((prev) => !prev)}
          onOpenConversation={openConversation}
          onOpenMenu={openMenu}
          conversationItems={conversationItems}
        />

        <div className="sb-foot foot left-footer">
          <div className="sb-row row sb-foot-row">
            <button
              type="button"
              className="sb-foot-link foot-link"
              data-testid="next-open-settings"
              title={t(lang, 'settings_title')}
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
