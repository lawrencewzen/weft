import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { LeftOpenButton, RightToggle } from './RightToggle';

type ConversationView = components['schemas']['ConversationView'];
type Workspace = components['schemas']['Workspace'];

type Props = {
  conversation: ConversationView;
  lang: Lang;
  demo?: boolean;
  hidePending?: boolean;
  onOpenLeft?: () => void;
  workspace?: Workspace | null;
};

export function StatusBar({
  conversation,
  lang,
  onOpenLeft,
}: Props) {
  const run = conversation.run;
  const failed = run.status === 'failed';
  const isNew = !conversation.id || conversation.title === t(lang, 'new_conversation');

  return (
    <header className="next-status" data-testid="next-status">
      <div className="next-status-inner">
        <div className="top-heading">
          <LeftOpenButton lang={lang} onOpen={onOpenLeft} />
          <span
            className="top-title"
            style={isNew ? { color: 'var(--faint)' } : undefined}
          >
            {isNew ? t(lang, 'new_conversation') : conversation.title}
          </span>
        </div>
        <div className="top-right">
          <RightToggle lang={lang} />
        </div>
      </div>
      {failed && run.error?.message ? (
        <div className="next-status-inner">
          <div className="llm-error" data-testid="next-run-error" role="alert">
            {run.error.code ? <div className="llm-error-code">{run.error.code}</div> : null}
            <div>{run.error.message}</div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
