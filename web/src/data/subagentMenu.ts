import type { CtxMenuItem } from '../components/CtxMenu';
import type { Lang } from './lang';
import { subagentTopic, type EntityStore, type Subagent } from './store';
import { t } from '../i18n';

export function createSubagentMenuItems({
  cid,
  agent,
  lang,
  store,
  onOpen,
  onCopy,
}: {
  cid: string;
  agent: Subagent;
  lang: Lang;
  store: EntityStore;
  onOpen: (cid: string, agentId: string) => void;
  onCopy: (text: string) => void;
}): CtxMenuItem[] {
  const output = store.lastAssistantText(subagentTopic(cid, agent.id));
  return [
    {
      label: t(lang, 'subagent_open'),
      action: 'open-subagent',
      run: () => onOpen(cid, agent.id),
    },
    {
      label: t(lang, 'copy_output'),
      action: 'copy-output',
      disabled: !output,
      run: () => { void onCopy(output); },
    },
  ];
}
