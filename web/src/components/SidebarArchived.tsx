import type { MouseEvent } from 'react';
import type { Lang } from '../data/lang';
import { formatRelativeTime } from '../data/relativeTime';
import type { ConversationSummary } from '../data/store';
import { t } from '../i18n';
import type { CtxMenuItem } from './CtxMenu';
import { MORE_ICON } from './SidebarIcons';
import { ArchiveIcon } from './StatusIcon';

export interface SidebarArchivedProps {
  lang: Lang;
  archived: ConversationSummary[];
  activeConversationId: string | null;
  open: boolean;
  onToggle: () => void;
  onOpenConversation: (wsId: string, cid: string) => void;
  onOpenMenu: (ev: MouseEvent, items: CtxMenuItem[], title: string) => void;
  conversationItems: (wsId: string, conv: ConversationSummary) => CtxMenuItem[];
}

export function SidebarArchived({
  lang,
  archived,
  activeConversationId,
  open,
  onToggle,
  onOpenConversation,
  onOpenMenu,
  conversationItems,
}: SidebarArchivedProps) {
  return (
    <div className="sb-archived-section sidebar-archived-section" data-testid="next-sidebar-archived-section">
      <div
        className="sb-row row sb-archived-row sidebar-archived-header tproj"
        data-testid="next-archived-toggle"
        onClick={onToggle}
      >
        <span className="sb-ic ic" aria-hidden="true">
          <ArchiveIcon className="sidebar-archived-icon" size={14} />
        </span>
        <span className="sb-row-text sidebar-archived-title">{t(lang, 'archived_label')}</span>
        <span className="sb-cnt cnt sidebar-archived-count" data-testid="next-archived-count">
          {archived.length}
        </span>
      </div>
      {open ? (
        <div className="sb-archived-list sidebar-archived-list" data-testid="next-archived-list">
          {archived.map((conv) => {
            const isCurrent = conv.id === activeConversationId;
            return (
              <div
                key={conv.id}
                className={`sb-row row sb-conv conv conv-node-header sidebar-archived-row${isCurrent ? ' sel conv-active' : ''}`}
                data-testid="next-conv-row"
                data-id={conv.id}
                data-status={conv.status || 'idle'}
                data-ws-id={conv.workspaceId}
                title={conv.title || ''}
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
          })}
        </div>
      ) : null}
    </div>
  );
}
