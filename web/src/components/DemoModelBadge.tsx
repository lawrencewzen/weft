import type { Lang } from '../data/lang';
import { t } from '../i18n';

type Props = {
  lang: Lang;
  testId: string;
};

export function DemoModelBadge({ lang, testId }: Props) {
  return (
    <span className="demo-model-badge" data-testid={testId}>
      {t(lang, 'demo_model_badge')}
    </span>
  );
}
