import type { Lang } from '../data/lang';
import type { components } from '../../../src/v2/contract.gen';
import { t } from '../i18n';
import { Markdown } from './Markdown';

type Item = components['schemas']['ThreadItemUser'];

export function UserMessage({ item, lang }: { item: Item; lang: Lang }) {
  return (
    <div
      className="msg-group msg-side-user"
      data-testid="next-item-user"
      data-role="user"
      data-id={item.id}
    >
      <Markdown
        text={item.text}
        pathRefs={item.pathRefs}
        copyLabel={t(lang, 'copy_code')}
        copiedLabel={t(lang, 'copied')}
      />
    </div>
  );
}
