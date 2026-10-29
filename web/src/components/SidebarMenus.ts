import type { Lang } from '../data/lang';
import { stop as stopApi } from '../data/api';
import type { ConversationSummary, Workspace } from '../data/store';
import { t } from '../i18n';
import type { CtxMenuItem } from './CtxMenu';

export interface ProjectMenuOpts {
  lang: Lang;
  ws: Workspace;
  onNewWorkspace: () => void;
  startDraft: (wsId: string) => void;
  copy: (text: string) => Promise<void>;
  openInTerminal: (path: string | undefined, wsId: string) => Promise<void>;
  showFiles: (wsId: string) => void;
  removeWorkspace: (ws: Workspace) => Promise<void>;
}

export function buildProjectItems(opts: ProjectMenuOpts): CtxMenuItem[] {
  const { lang, ws, onNewWorkspace, startDraft, copy, openInTerminal, showFiles, removeWorkspace } = opts;
  return [
    { label: t(lang, 'new_workspace'), action: 'new-workspace', run: () => onNewWorkspace() },
    { label: t(lang, 'new_conversation'), action: 'new-conversation', run: () => startDraft(ws.id) },
    { label: t(lang, 'copy_path'), action: 'copy-path', run: () => { void copy(ws.path || ''); } },
    {
      label: t(lang, 'open_in_terminal'),
      action: 'open-terminal',
      run: () => { void openInTerminal(undefined, ws.id); },
    },
    {
      label: t(lang, 'show_files'),
      action: 'show-files',
      run: () => { showFiles(ws.id); },
    },
    { sep: true },
    {
      label: t(lang, 'ws_remove'),
      action: 'remove-workspace',
      danger: true,
      run: () => { void removeWorkspace(ws); },
    },
  ];
}

export interface ConversationMenuOpts {
  lang: Lang;
  wsId: string;
  conv: ConversationSummary;
  openConversation: (wsId: string, convId: string) => void;
  copy: (text: string) => Promise<void>;
}

export function buildConversationItems(opts: ConversationMenuOpts): CtxMenuItem[] {
  const { lang, wsId, conv, openConversation, copy } = opts;
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
}
