import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';

type ConversationView = components['schemas']['ConversationView'];
type Workspace = components['schemas']['Workspace'];

type Props = {
  conversation: ConversationView;
  lang: Lang;
  demo?: boolean;
  hidePending?: boolean;
  workspace?: Workspace | null;
};

export function StatusBar({
  conversation,
  lang,
}: Props) {
  const isNew = !conversation.id || conversation.title === t(lang, 'new_conversation');

  return (
    <header className="next-status" data-testid="next-status">
      <div className="next-status-inner">
        <div className="top-heading">
          <span
            className="top-title"
            style={isNew ? { color: 'var(--faint)' } : undefined}
          >
            {isNew ? t(lang, 'new_conversation') : conversation.title}
          </span>
        </div>
        <div className="top-right" aria-hidden="true" />
      </div>
    </header>
  );
}
