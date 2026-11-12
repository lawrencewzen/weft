import type { MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import { formatRelativeTime } from '../data/relativeTime';
import type { ConversationSummary } from '../data/store';
import { t } from '../i18n';
import type { CtxMenuItem } from './CtxMenu';
import { MORE_ICON } from './SidebarIcons';

export interface SidebarArchivedProps {
  lang: Lang;
  archived: ConversationSummary[];
  activeConversationId: string | null;
  onOpenConversation: (wsId: string, cid: string) => void;
  onOpenMenu: (ev: MouseEvent, items: CtxMenuItem[], title: string) => void;
  conversationItems: (wsId: string, conv: ConversationSummary) => CtxMenuItem[];
}

export function SidebarArchived({
  lang,
  archived,
  activeConversationId,
  onOpenConversation,
  onOpenMenu,
  conversationItems,
}: SidebarArchivedProps) {
  return (
    <div className="sb-archived-section sidebar-archived-section" data-testid="next-sidebar-archived-section">
      <div className="sb-archived-list sidebar-archived-list" data-testid="next-archived-list">
        {archived.length === 0 ? (
          <div
            className="sb-archived-empty sidebar-archived-empty"
            data-testid="next-archived-empty"
          >
            {t(lang, 'no_archived_chats')}
          </div>
        ) : (
          archived.map((conv) => {
            const isCurrent = conv.id === activeConversationId;
            return (
              <div
                key={conv.id}
                className={`sb-row row sb-conv conv conv-node-header sidebar-archived-row${isCurrent ? ' sel conv-active' : ''}`}
                data-testid="next-conv-row"
                data-id={conv.id}
                data-status={conv.status || 'idle'}
                data-ws-id={conv.workspaceId}
                aria-current={isCurrent ? 'page' : undefined}
                onClick={() => onOpenConversation(conv.workspaceId, conv.id)}
                onContextMenu={(ev) => onOpenMenu(ev, conversationItems(conv.workspaceId, conv), conv.title || '')}
              >
                <span className="sb-st st v2 conv-status-slot" />
                <span className="sb-conv-title t conv-node-title">
                  {conv.title || t(lang, 'default_conversation_title')}
                </span>
                <span className="sb-conv-meta meta conv-node-meta">
                  {formatRelativeTime(lang, conv.updatedAt)}
                </span>
                <button
                  type="button"
                  className="sb-act act sb-conv-more more"
                  title={t(lang, 'more_actions')}
                  aria-label={t(lang, 'more_actions')}
                  onClick={(ev) => onOpenMenu(ev, conversationItems(conv.workspaceId, conv), conv.title || '')}
                >
                  {MORE_ICON}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
