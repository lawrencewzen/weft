import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ApiError, stop as stopApi } from '../data/api';
import { copyText } from '../data/copyText';
import type { Lang } from '../data/lang';
import {
  readOpenWorkspaces,
  writeActiveWorkspace,
  writeOpenWorkspaces,
} from '../data/layout';
import { conversationPath, draftPath, navigate } from '../data/nav';
import {
  conversationMeta,
  conversationStatusKind,
  runningCount,
} from '../data/sidebarModel';
import type { ConversationSummary, Workspace } from '../data/store';
import { useWorkspaces } from '../data/useWorkspaces';
import { t } from '../i18n';
import { CtxMenu, type CtxMenuItem } from './CtxMenu';
import type { ConfirmOpts } from './ConfirmDialog';

type MenuState = {
  x: number;
  y: number;
  title: string;
  items: CtxMenuItem[];
};

type Props = {
  lang: Lang;
  activeConversationId: string | null;
  draftWorkspaceId: string | null;
  onCollapse: () => void;
  onToast: (message: string) => void;
  onConfirm: (opts: ConfirmOpts) => Promise<boolean>;
  onRemoveWorkspace: (workspaceId: string) => Promise<void>;
};

const CHEV = (
  <svg className="ws-chev" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 3l3 3-3 3" />
  </svg>
);

const CHIP_ICON = (
  <svg
    className="subagent-chip-icon"
    viewBox="0 0 12 12"
    width="11"
    height="11"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="3" cy="2.4" r="1.35" />
    <circle cx="3" cy="9.6" r="1.35" />
    <circle cx="9" cy="6" r="1.35" />
    <path d="M3 3.75v4.5M3 6h4.65" />
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

function SubagentChip({ live, total }: { live: number; total: number }) {
  if (total <= 0) return null;
  const label = live > 0 ? `${live}/${total}` : String(total);
  return (
    <span className={`subagent-chip${live ? ' is-live' : ''}`} data-testid="next-subagent-chip">
      {CHIP_ICON}
      <span className="subagent-chip-count">{label}</span>
    </span>
  );
}

export function Sidebar({
  lang,
  activeConversationId,
  draftWorkspaceId,
  onCollapse,
  onToast,
  onConfirm,
  onRemoveWorkspace,
}: Props) {
  const { groups } = useWorkspaces();
  const now = useNow(60_000);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(readOpenWorkspaces()));
  const [menu, setMenu] = useState<MenuState | null>(null);

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

  const persistOpen = useCallback((next: Set<string>) => {
    setOpenIds(next);
    writeOpenWorkspaces(next);
  }, []);

  const isOpen = useCallback((wsId: string, isActive: boolean) => (
    openIds.has(wsId) || (isActive && openIds.size === 0)
  ), [openIds]);

  const toggleProject = useCallback((wsId: string, isActive: boolean) => {
    const currentlyOpen = isOpen(wsId, isActive);
    const next = new Set(openIds);
    if (currentlyOpen) next.delete(wsId);
    else next.add(wsId);
    persistOpen(next);
  }, [isOpen, openIds, persistOpen]);

  const startDraft = useCallback((wsId: string) => {
    const next = new Set(openIds);
    next.add(wsId);
    persistOpen(next);
    writeActiveWorkspace(wsId);
    navigate(draftPath(wsId));
  }, [openIds, persistOpen]);

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
      const next = new Set(openIds);
      next.delete(ws.id);
      persistOpen(next);
      onToast(t(lang, 'ws_removed', { name: ws.name }));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.code === 'E_WS_BUSY')) {
        onToast(t(lang, 'ws_remove_busy'));
        return;
      }
      onToast(err instanceof Error ? err.message : t(lang, 'ws_remove_busy'));
    }
  }, [lang, onConfirm, onRemoveWorkspace, onToast, openIds, persistOpen]);

  const projectItems = useCallback((ws: Workspace): CtxMenuItem[] => [
    { label: t(lang, 'new_conversation'), action: 'new-conversation', run: () => startDraft(ws.id) },
    { label: t(lang, 'copy_path'), action: 'copy-path', run: () => { void copy(ws.path || ''); } },
    { sep: true },
    {
      label: t(lang, 'ws_remove'),
      action: 'remove-workspace',
      danger: true,
      run: () => { void removeWorkspace(ws); },
    },
  ], [copy, lang, removeWorkspace, startDraft]);

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

  const newChatTarget = activeWorkspaceId || groups[0]?.workspace.id || null;

  return (
    <aside className="col-left" data-testid="next-sidebar">
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
            const showDraft = isActive && Boolean(draftWorkspaceId);
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
                  {showDraft ? (
                    <div className="draft-row is-active" data-testid="next-draft-row">
                      <span className="draft-dot" />
                      <span className="conv-node-title">{t(lang, 'new_conversation')}</span>
                      <span className="conv-node-meta">{t(lang, 'draft_label')}</span>
                    </div>
                  ) : null}
                  {group.conversations.map((conv) => {
                    const isCurrent = conv.id === activeConversationId;
                    const meta = conversationMeta(conv, lang, now);
                    const kind = conversationStatusKind(conv.status);
                    const counts = conv.subagents;
                    return (
                      <div
                        key={conv.id}
                        className={`conv-tree-node${isCurrent ? ' conv-active' : ''}`}
                      >
                        <div
                          className="conv-node-header"
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
                          {counts && counts.total > 0 ? (
                            <SubagentChip live={counts.live} total={counts.total} />
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
                      </div>
                    );
                  })}
                  {!group.conversations.length && !showDraft ? (
                    <div className="ws-empty-note">{t(lang, 'ws_no_conversations')}</div>
                  ) : null}
                </div>
              </div>
            );
          })}
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
