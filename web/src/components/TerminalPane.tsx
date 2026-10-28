import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { agentCommands } from '../data/agentCommands';
import { toolOutput } from '../data/api';
import type { Lang } from '../data/lang';
import { useRightPane } from '../data/rightPaneContext';
import { useSession } from '../data/session';
import { t } from '../i18n';

type Props = {
  lang: Lang;
};

function commandText(
  store: ReturnType<typeof useSession>['store'],
  toolId: string,
): string {
  const live = store.toolLiveText(toolId);
  if (live != null && live !== '') return live;
  const tool = store.tool(toolId);
  if (tool?.output.text) return tool.output.text;
  return tool?.output.preview || '';
}

export function TerminalPane({ lang }: Props) {
  const { selectedCommandId } = useRightPane();
  const { store, conversationId } = useSession();
  const storeVersion = useSyncExternalStore(store.subscribe, store.getVersion);
  const cid = conversationId || '';
  const agents = cid ? store.subagents(cid) : [];
  const commands = useMemo(
    () => (cid ? agentCommands(store, cid, agents) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store is stable; storeVersion tracks writes
    [store, cid, agents, storeVersion],
  );
  const [activeId, setActiveId] = useState<string | null>(selectedCommandId);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    if (selectedCommandId) setActiveId(selectedCommandId);
  }, [selectedCommandId]);

  useEffect(() => {
    setFullText(null);
    stickRef.current = true;
  }, [activeId, cid]);

  const active = commands.find((row) => row.toolId === activeId) || commands[0] || null;
  const toolId = active?.toolId || '';
  const tool = toolId ? store.tool(toolId) : undefined;
  const truncated = Boolean(tool?.output.truncated);
  const body = fullText ?? (toolId ? commandText(store, toolId) : '');

  useEffect(() => {
    const node = bodyRef.current;
    if (!node || !stickRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [body, toolId]);

  function onScroll() {
    const node = bodyRef.current;
    if (!node) return;
    const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickRef.current = gap < 24;
  }

  async function loadFull() {
    if (!cid || !toolId || loadingFull || fullText != null) return;
    setLoadingFull(true);
    try {
      const out = await toolOutput(cid, toolId);
      setFullText(out.text);
      stickRef.current = true;
    } finally {
      setLoadingFull(false);
    }
  }

  const ownerLabel = active?.ownerKind === 'subagent' && active.ownerName
    ? t(lang, 'term_note_sub', { name: active.ownerName })
    : t(lang, 'term_note_main');

  let statusLabel = '';
  if (active && !active.running) {
    if (active.status === 'interrupted') statusLabel = t(lang, 'term_stopped');
    else if (active.exitCode != null) statusLabel = t(lang, 'term_exit', { code: active.exitCode });
  }

  return (
    <div className="term-pane" data-testid="next-term-pane">
      {commands.length ? (
        <div className="term-cmd-tabs" data-testid="next-term-cmds">
          {commands.map((row) => (
            <button
              key={row.toolId}
              type="button"
              className={`term-cmd-tab${row.toolId === (active?.toolId || '') ? ' active' : ''}`}
              data-testid="next-term-cmd"
              data-tool-id={row.toolId}
              data-running={row.running ? 'true' : 'false'}
              title={row.title}
              onClick={() => {
                stickRef.current = true;
                setActiveId(row.toolId);
              }}
            >
              <span className={`term-dot${row.running ? ' is-run' : ''}`} aria-hidden="true" />
              <span className="term-cmd-title">{row.title}</span>
              {!row.running && row.exitCode != null ? (
                <span className="term-cmd-meta">{row.exitCode}</span>
              ) : !row.running && row.status === 'interrupted' ? (
                <span className="term-cmd-meta">{t(lang, 'term_stopped')}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="pane-empty">{t(lang, 'term_empty')}</div>
      )}
      {active ? (
        <>
          <pre
            ref={bodyRef}
            className="term-body"
            data-testid="next-term-body"
            onScroll={onScroll}
          >{body}</pre>
          {truncated && !active.running && fullText == null ? (
            <button
              type="button"
              className="term-full"
              data-testid="next-term-full"
              onClick={() => { void loadFull(); }}
              disabled={loadingFull}
            >
              {t(lang, 'term_view_full')}
            </button>
          ) : null}
          <div className="term-note" data-testid="next-term-note">
            {ownerLabel}
            {statusLabel ? ` · ${statusLabel}` : ''}
          </div>
        </>
      ) : null}
    </div>
  );
}
