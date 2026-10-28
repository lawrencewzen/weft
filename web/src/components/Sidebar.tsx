import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ApiError, stop as stopApi } from '../data/api';
import { copyText } from '../data/copyText';
import type { Lang } from '../data/lang';
import {
  readSubagentTrees,
  readWorkspaceOpen,
  writeActiveWorkspace,
  writeSubagentTrees,
  writeWorkspaceOpen,
} from '../data/layout';
import { conversationPath, draftPath, navigate, openSettings, subagentPath } from '../data/nav';
import {
  effectiveAppearance,
  subscribePrefs,
  toggleAppearance,
} from '../data/prefs';
import { useSession } from '../data/session';
import {
  conversationMeta,
  conversationStatusKind,
  deleteOpenRecord,
  hasLiveSubagents,
  runningCount,
  setOpenRecord,
  subagentTreeIsOpen,
  toggleOpenRecord,
  workspaceIsOpen,
  type OpenRecord,
} from '../data/sidebarModel';
import {
  conversationTopic,
  subagentTopic,
  type ConversationSummary,
  type Subagent,
  type Workspace,
} from '../data/store';
import { useRightPane } from '../data/rightPaneContext';
import { useWorkspaces } from '../data/useWorkspaces';
import { t } from '../i18n';
import { CtxMenu, type CtxMenuItem } from './CtxMenu';
import type { ConfirmOpts } from './ConfirmDialog';
import { SubagentChip, SubagentTree } from './SubagentTree';

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

const CHEV = (
  <svg className="ws-chev" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 3l3 3-3 3" />
  </svg>
);

const MOON_ICON = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
    <path d="M11.8 8.6A5 5 0 0 1 5.4 2.2a5 5 0 1 0 6.4 6.4z" />
  </svg>
);

const SUN_ICON = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="2.6" />
    <path d="M7 1.2v1.4M7 11.4v1.4M1.2 7h1.4M11.4 7h1.4M2.9 2.9l1 1M10.1 10.1l1 1M2.9 11.1l1-1M10.1 3.9l1-1" />
  </svg>
);

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

export function Sidebar({
  lang,
  collapsed = false,
  activeConversationId,
  activeAgentId,
  draftWorkspaceId,
  onCollapse,
  onToast,
  onConfirm,
  onRemoveWorkspace,
  onNewWorkspace,
}: Props) {
  const { groups } = useWorkspaces();
  const { store, status, setExtraConversationIds } = useSession();
  const { showFiles } = useRightPane();
  const now = useNow(1_000);
  const [openMap, setOpenMap] = useState<OpenRecord>(() => readWorkspaceOpen());
  const [treeRecorded, setTreeRecorded] = useState<OpenRecord>(() => readSubagentTrees());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dark, setDark] = useState(() => effectiveAppearance() === 'dark');
  const serviceOk = status === 'connected';

  useEffect(() => subscribePrefs(() => {
    setDark(effectiveAppearance() === 'dark');
  }), []);

  const activeWorkspaceId = useMemo(() => {
    if (draftWorkspaceId) return draftWorkspaceId;
    if (!activeConversationId) return null;
    for (const group of groups) {
      if (group.conversations.some((conv) => conv.id === activeConversationId)) {
        return group.workspace.id;
      }
    }
    return null;
  }, [groups, activeConversationId, draftWorkspaceId]);

  useEffect(() => {
    const extra: string[] = [];
    for (const group of groups) {
      for (const conv of group.conversations) {
        if (conv.id === activeConversationId) continue;
        const live = hasLiveSubagents(conv.subagents, store.subagents(conv.id));
        if (subagentTreeIsOpen(conv.id, treeRecorded, live)) extra.push(conv.id);
      }
    }
    extra.sort();
    setExtraConversationIds((prev) => {
      if (prev.length === extra.length && prev.every((id, i) => id === extra[i])) return prev;
      return extra;
    });
  }, [groups, treeRecorded, activeConversationId, setExtraConversationIds, store]);

  const persistOpen = useCallback((next: OpenRecord) => {
    setOpenMap(next);
    writeWorkspaceOpen(next);
  }, []);

  const persistTrees = useCallback((next: OpenRecord) => {
    setTreeRecorded(next);
    writeSubagentTrees(next);
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

  const treeOpen = useCallback((cid: string, live: boolean) => (
    subagentTreeIsOpen(cid, treeRecorded, live)
  ), [treeRecorded]);

  const toggleTree = useCallback((cid: string) => {
    const group = groups.find((item) => item.conversations.some((conv) => conv.id === cid));
    const conv = group?.conversations.find((item) => item.id === cid);
    const agents = store.subagents(cid);
    const live = hasLiveSubagents(conv?.subagents, agents);
    const currentlyOpen = subagentTreeIsOpen(cid, treeRecorded, live);
    persistTrees(toggleOpenRecord(treeRecorded, cid, currentlyOpen));
  }, [groups, persistTrees, store, treeRecorded]);

  const openSubagent = useCallback((cid: string, agentId: string) => {
    const group = groups.find((item) => item.conversations.some((conv) => conv.id === cid));
    if (group) writeActiveWorkspace(group.workspace.id);
    navigate(subagentPath(cid, agentId));
  }, [groups]);

  const isOpen = useCallback((wsId: string, isActive: boolean) => (
    workspaceIsOpen(wsId, isActive, openMap)
  ), [openMap]);

  const toggleProject = useCallback((wsId: string, isActive: boolean) => {
    const currentlyOpen = workspaceIsOpen(wsId, isActive, openMap);
    persistOpen(toggleOpenRecord(openMap, wsId, currentlyOpen));
  }, [openMap, persistOpen]);

  const startDraft = useCallback((wsId: string) => {
    persistOpen(setOpenRecord(openMap, wsId, true));
    writeActiveWorkspace(wsId);
    navigate(draftPath(wsId));
  }, [openMap, persistOpen]);

  const openConversation = useCallback((wsId: string, cid: string) => {
    writeActiveWorkspace(wsId);
    navigate(conversationPath(cid));
  }, []);

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

  const projectItems = useCallback((ws: Workspace): CtxMenuItem[] => [
    { label: t(lang, 'new_workspace'), action: 'new-workspace', run: () => onNewWorkspace() },
    { label: t(lang, 'new_conversation'), action: 'new-conversation', run: () => startDraft(ws.id) },
    { label: t(lang, 'copy_path'), action: 'copy-path', run: () => { void copy(ws.path || ''); } },
    {
      label: t(lang, 'show_files'),
      action: 'show-files',
      run: () => {
        writeActiveWorkspace(ws.id);
        if (ws.id !== activeWorkspaceId) {
          const latest = groups.find((group) => group.workspace.id === ws.id)?.conversations[0];
          if (latest) navigate(conversationPath(latest.id));
          else navigate(draftPath(ws.id));
        }
        showFiles();
      },
    },
    { sep: true },
    {
      label: t(lang, 'ws_remove'),
      action: 'remove-workspace',
      danger: true,
      run: () => { void removeWorkspace(ws); },
    },
  ], [activeWorkspaceId, copy, groups, lang, onNewWorkspace, removeWorkspace, showFiles, startDraft]);

  const conversationItems = useCallback((wsId: string, conv: ConversationSummary): CtxMenuItem[] => {
    const items: CtxMenuItem[] = [];
    if (conv.status === 'running') {
      items.push({
        label: t(lang, 'ctx_stop'),
        action: 'stop',
        run: () => { void stopApi(conv.id); },
      });
      items.push({ sep: true });
    }
    items.push({
      label: t(lang, 'open_conversation'),
      action: 'open',
      run: () => openConversation(wsId, conv.id),
    });
    items.push({
      label: t(lang, 'copy_conversation_id'),
      action: 'copy-id',
      run: () => { void copy(conv.id); },
    });
    return items;
  }, [copy, lang, openConversation]);

  const openMenu = useCallback((ev: MouseEvent, items: CtxMenuItem[], title: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    const fromClick = ev.type === 'click';
    const target = ev.currentTarget as HTMLElement;
    const rect = fromClick ? target.getBoundingClientRect() : null;
    const x = rect ? rect.left : ev.clientX;
    const y = rect ? rect.bottom + 4 : ev.clientY;
    setMenu({ x, y, title, items });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const subagentItems = useCallback((cid: string, agent: Subagent): CtxMenuItem[] => {
    const output = store.lastAssistantText(subagentTopic(cid, agent.id));
    return [
      {
        label: t(lang, 'subagent_open'),
        action: 'open-subagent',
        run: () => openSubagent(cid, agent.id),
      },
      {
        label: t(lang, 'copy_output'),
        action: 'copy-output',
        disabled: !output,
        run: () => { void copy(output); },
      },
    ];
  }, [copy, lang, openSubagent, store]);

  const newChatTarget = activeWorkspaceId || groups[0]?.workspace.id || null;

  return (
    <aside
      className="col-left"
      data-testid="next-sidebar"
      inert={collapsed || undefined}
      aria-hidden={collapsed || undefined}
    >
      <div className="col-panel-inner">
      <div className="left-top">
        <button
          type="button"
          className="new-chat-btn"
          data-testid="next-new-chat"
          disabled={!newChatTarget}
          onClick={() => { if (newChatTarget) startDraft(newChatTarget); }}
        >
          <span>{t(lang, 'new_conversation')}</span>
        </button>
        <button
          type="button"
          className="icon-btn"
          data-testid="next-left-collapse"
          title={t(lang, 'collapse_sidebar')}
          aria-label={t(lang, 'collapse_sidebar')}
          onClick={onCollapse}
        >
          <span className="ico-panel ico-panel-left" aria-hidden="true" />
        </button>
      </div>
      <div className="left-body">
        <div className="left-section-label">
          <span>{t(lang, 'projects_label')}</span>
          <button
            type="button"
            className="btn-icon-xs"
            data-testid="next-ws-new"
            title={t(lang, 'new_workspace')}
            aria-label={t(lang, 'new_workspace')}
            onClick={onNewWorkspace}
          >
            +
          </button>
        </div>
        <div className="tree-root">
          {groups.map((group) => {
            const ws = group.workspace;
            const isActive = ws.id === activeWorkspaceId;
            const open = isOpen(ws.id, isActive);
            const runN = runningCount(group.conversations);
            const count = open
              ? ''
              : (runN ? t(lang, 'running_count', { n: runN }) : (group.conversations.length ? String(group.conversations.length) : ''));
            return (
              <div
                key={ws.id}
                className={`ws-tree-node${isActive ? ' ws-active' : ''}${open ? ' is-open' : ''}`}
                data-testid="next-ws-node"
                data-id={ws.id}
              >
                <div
                  className="ws-node-header"
                  data-testid="next-ws-toggle"
                  title={ws.path}
                  aria-expanded={open ? 'true' : 'false'}
                  onClick={() => toggleProject(ws.id, isActive)}
                  onContextMenu={(ev) => openMenu(ev, projectItems(ws), ws.name)}
                >
                  {CHEV}
                  <span className="ws-node-title">{ws.name}</span>
                  <span className={`ws-node-count${runN ? ' is-running' : ''}`}>{count}</span>
                  <button
                    type="button"
                    className="btn-icon-xs ws-node-more"
                    title={t(lang, 'more_actions')}
                    aria-label={t(lang, 'more_actions')}
                    onClick={(ev) => openMenu(ev, projectItems(ws), ws.name)}
                  >
                    ⋯
                  </button>
                  <button
                    type="button"
                    className="btn-icon-xs ws-node-add"
                    data-testid="next-ws-add"
                    data-ws-id={ws.id}
                    title={t(lang, 'new_conversation_in', { name: ws.name })}
                    aria-label={t(lang, 'new_conversation')}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      startDraft(ws.id);
                    }}
                  >
                    +
                  </button>
                </div>
                <div className="ws-node-children">
                  {group.conversations.map((conv) => {
                    const isCurrent = conv.id === activeConversationId;
                    const meta = conversationMeta(conv, lang, now);
                    const kind = conversationStatusKind(conv.status);
                    const counts = conv.subagents;
                    const agents = store.subagents(conv.id);
                    const live = hasLiveSubagents(counts, agents);
                    const openTree = treeOpen(conv.id, live);
                    const collapsed = !openTree;
                    const hasChip = Boolean(counts && counts.total > 0) || agents.length > 0;
                    const chipLive = counts?.live ?? agents.filter((agent) => (
                      agent.status === 'running' || agent.status === 'stuck' || agent.status === 'waiting'
                    )).length;
                    const chipTotal = counts?.total ?? agents.length;
                    const loadingOther = !isCurrent && openTree && !store.hasTopic(conversationTopic(conv.id));
                    const showTree = hasChip && (openTree || isCurrent || agents.length > 0);
                    const viewingChild = Boolean(isCurrent && activeAgentId);
                    return (
                      <div
                        key={conv.id}
                        className={[
                          'conv-tree-node',
                          isCurrent && !viewingChild ? 'conv-active' : '',
                          viewingChild ? 'conv-child-active' : '',
                        ].filter(Boolean).join(' ')}
                      >
                        <div
                          className={`conv-node-header${viewingChild ? ' is-child-active' : ''}`}
                          data-testid="next-conv-row"
                          data-id={conv.id}
                          data-status={conv.status}
                          data-ws-id={ws.id}
                          title={conv.title || ''}
                          onClick={() => openConversation(ws.id, conv.id)}
                          onContextMenu={(ev) => openMenu(ev, conversationItems(ws.id, conv), conv.title || '')}
                        >
                          <span className="conv-status-slot">
                            {kind ? (
                              <span
                                className={`conv-status-dot is-${kind}`}
                                data-testid="next-conv-dot"
                                data-kind={kind}
                              />
                            ) : null}
                          </span>
                          <span className="conv-node-title">
                            {conv.title || t(lang, 'default_conversation_title')}
                          </span>
                          {hasChip ? (
                            <SubagentChip
                              convId={conv.id}
                              live={chipLive}
                              total={chipTotal}
                              collapsed={collapsed}
                              lang={lang}
                              onToggle={toggleTree}
                            />
                          ) : null}
                          <span
                            className={`conv-node-meta ${meta.cls}`.trim()}
                            data-testid="next-conv-meta"
                            data-rel-time={meta.ts ? 'true' : undefined}
                            data-ts={meta.ts ? String(meta.ts) : undefined}
                          >
                            {meta.text}
                          </span>
                        </div>
                        {showTree ? (
                          <SubagentTree
                            convId={conv.id}
                            agents={openTree || isCurrent ? agents : []}
                            collapsed={collapsed}
                            loading={loadingOther}
                            activeAgentId={isCurrent ? activeAgentId : null}
                            lang={lang}
                            now={now}
                            onOpen={openSubagent}
                            onMenu={(ev, agent) => openMenu(ev, subagentItems(conv.id, agent), agent.title || agent.name)}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                  {!group.conversations.length ? (
                    <div className="ws-empty-note">{t(lang, 'ws_no_conversations')}</div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="left-footer">
        <button
          type="button"
          className="foot-link"
          data-testid="next-open-settings"
          title={t(lang, 'settings_title')}
          onClick={() => openSettings('general')}
        >
          {t(lang, 'settings_short')}
        </button>
        <span className="foot-right">
          <span
            className={`foot-status-dot${serviceOk ? ' is-ok' : ''}`}
            data-testid="next-service-dot"
            data-ok={serviceOk ? 'true' : 'false'}
            title={t(lang, serviceOk ? 'service_ok' : 'service_reconnecting')}
            aria-label={t(lang, serviceOk ? 'service_ok' : 'service_reconnecting')}
          />
          <button
            type="button"
            className="foot-appearance"
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
