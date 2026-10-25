import { useCallback, useState } from 'react';
import type { Lang } from '../data/lang';
import { useConversation } from '../data/useConversation';
import { t } from '../i18n';
import { Composer } from './Composer';
import { StatusBar } from './StatusBar';
import { Thread } from './Thread';

type Props = {
  cid: string;
  lang: Lang;
};

export function CenterPane({ cid, lang }: Props) {
  const { conversation, items, toolsById, missing, actions } = useConversation(cid, lang);
  const [stickNonce, setStickNonce] = useState(0);
  const bumpStick = useCallback(() => setStickNonce((n) => n + 1), []);

  if (missing) {
    return (
      <div className="next-home" data-testid="next-app">
        <h1>{t(lang, 'home_title')}</h1>
        <p className="next-error" data-testid="next-error">{t(lang, 'missing_conversation')}</p>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="next-home" data-testid="next-app">
        <h1>{t(lang, 'home_title')}</h1>
        <p>{t(lang, 'loading')}</p>
      </div>
    );
  }

  return (
    <div className="next-shell" data-testid="next-app">
      <main className="col-center">
        <StatusBar conversation={conversation} lang={lang} />
        <Thread
          items={items}
          toolsById={toolsById}
          lang={lang}
          running={conversation.run.status === 'running'}
          actions={actions}
          stickNonce={stickNonce}
        />
        <Composer
          lang={lang}
          run={conversation.run}
          onSend={actions.send}
          onStop={actions.stop}
          onSent={bumpStick}
        />
      </main>
    </div>
  );
}
