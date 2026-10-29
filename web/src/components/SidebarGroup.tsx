import type { MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import { formatRelativeTime } from '../data/relativeTime';
import { isConversationUnread } from '../data/sidebarUnread';
import type { ConversationSummary, Workspace } from '../data/store';
import { t } from '../i18n';
import type { CtxMenuItem } from './CtxMenu';
import { FOLDER_ICON, FOLDER_OPEN_ICON, MORE_ICON, PLUS_ICON } from './SidebarIcons';
import { StatusIcon, statusIconFor } from './StatusIcon';

export interface SidebarGroupProps {
  ws: Workspace;
  conversations: ConversationSummary[];
  isActive: boolean;
  isOpen: boolean;
  activeConversationId: string | null;
  lastOpenedMap: Record<string, number>;
  lang: Lang;
  onToggleProject: (wsId: string, isActive: boolean) => void;
  onStartDraft: (wsId: string) => void;
  onOpenConversation: (wsId: string, cid: string) => void;
  onOpenMenu: (ev: MouseEvent, items: CtxMenuItem[], title: string) => void;
  projectItems: (ws: Workspace) => CtxMenuItem[];
  conversationItems: (wsId: string, conv: ConversationSummary) => CtxMenuItem[];
}

export function SidebarGroup({
  ws,
  conversations,
  isActive,
  isOpen,
  activeConversationId,
  lastOpenedMap,
  lang,
  onToggleProject,
  onStartDraft,
  onOpenConversation,
  onOpenMenu,
  projectItems,
  conversationItems,
}: SidebarGroupProps) {
  return (
    <div
      className={`sb-group ws-tree-node${isActive ? ' ws-active' : ''}${isOpen ? ' is-open' : ''}`}
      data-testid="next-ws-node"
      data-id={ws.id}
    >
      <div
        className={`sb-row row sb-proj proj ws-node-header${isOpen ? ' is-open' : ''}`}
        data-testid="next-ws-toggle"
        title={ws.path}
        aria-expanded={isOpen ? 'true' : 'false'}
        onClick={() => onToggleProject(ws.id, isActive)}
        onContextMenu={(ev) => onOpenMenu(ev, projectItems(ws), ws.name)}
      >
        <span className="sb-ic ic" aria-hidden="true">
          {isOpen ? FOLDER_OPEN_ICON : FOLDER_ICON}
        </span>
        <span className="sb-proj-name ws-node-title">{ws.name}</span>
        <span className="sb-acts acts">
          <button
            type="button"
            className="sb-act act ws-node-add"
            data-testid="next-ws-add"
            data-ws-id={ws.id}
            title={t(lang, 'new_conversation_in', { name: ws.name })}
            aria-label={t(lang, 'new_conversation')}
            onClick={(ev) => {
              ev.stopPropagation();
              onStartDraft(ws.id);
            }}
          >
            {PLUS_ICON}
          </button>
          <button
            type="button"
            className="sb-act act ws-node-more"
            title={t(lang, 'more_actions')}
            aria-label={t(lang, 'more_actions')}
            onClick={(ev) => onOpenMenu(ev, projectItems(ws), ws.name)}
          >
            {MORE_ICON}
          </button>
        </span>
      </div>

      <div className="sb-conv-list ws-node-children">
        {conversations.map((conv) => {
          const isCurrent = conv.id === activeConversationId;
          const iconStatus = statusIconFor(conv.status);
          const isUnread = isConversationUnread(conv, activeConversationId, lastOpenedMap);
          return (
            <div
              key={conv.id}
              className={[
                'sb-row',
                'row',
                'sb-conv',
                'conv',
                'conv-node-header',
                isCurrent ? 'sel conv-active' : '',
                isUnread ? 'unread' : '',
              ].filter(Boolean).join(' ')}
              data-testid="next-conv-row"
              data-id={conv.id}
              data-status={conv.status || 'idle'}
              data-ws-id={ws.id}
              aria-current={isCurrent ? 'page' : undefined}
              title={conv.title || ''}
              onClick={() => onOpenConversation(ws.id, conv.id)}
              onContextMenu={(ev) => onOpenMenu(ev, conversationItems(ws.id, conv), conv.title || '')}
            >
              <span className="sb-st st v2 conv-status-slot">
                {iconStatus ? (
                  <StatusIcon status={iconStatus} size={14} lang={lang} />
                ) : null}
              </span>
              <span className="sb-conv-title t conv-node-title">
                {conv.title || t(lang, 'default_conversation_title')}
              </span>
              <span className="sb-conv-meta meta conv-node-meta">
                {formatRelativeTime(lang, conv.updatedAt)}
              </span>
              <button
                type="button"
                className="sb-act act sb-conv-more more"
                data-testid="next-conv-more"
                title={t(lang, 'more_actions')}
                aria-label={t(lang, 'more_actions')}
                onClick={(ev) => onOpenMenu(ev, conversationItems(ws.id, conv), conv.title || '')}
              >
                {MORE_ICON}
              </button>
            </div>
          );
        })}
        {!conversations.length ? (
          <div className="ws-empty-note">{t(lang, 'ws_no_conversations')}</div>
        ) : null}
      </div>
    </div>
  );
}
