import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import { getWorkspaceTree } from '../../data/api';
import {
  applyAtSelection,
  filterAtFiles,
  matchAtTrigger,
  resolveAtSelection,
  shouldResetAtActiveIndex,
  stepAtActiveIndex,
} from '../../data/attachments';

export type UseAtMentionOptions = {
  workspaceId: string | null;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  locked: boolean;
  focused: boolean;
  setFocused: Dispatch<SetStateAction<boolean>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onResize: () => void;
  addFileRef: (relPath: string) => void;
  addProjectFile: (relPath: string) => void;
};

export type UseAtMentionResult = ReturnType<typeof useAtMention>;

export function useAtMention({
  workspaceId,
  draft,
  setDraft,
  locked,
  focused,
  setFocused,
  textareaRef,
  onResize,
  addFileRef,
  addProjectFile,
}: UseAtMentionOptions) {
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const atActiveIndexRef = useRef(0);
  atActiveIndexRef.current = atActiveIndex;
  const prevQueryRef = useRef<string | null>(null);
  const prevOpenRef = useRef(false);
  const [atDismissed, setAtDismissed] = useState(false);
  const [treeCache, setTreeCache] = useState<Record<string, { files: string[]; error: boolean }>>({});
  const [cursorPos, setCursorPos] = useState<number | null>(null);

  const activeCursor = cursorPos !== null
    ? Math.min(cursorPos, draft.length)
    : (textareaRef.current?.selectionStart ?? draft.length);
  const atTrigger = useMemo(() => {
    return matchAtTrigger(draft, activeCursor);
  }, [draft, activeCursor]);

  const atOpen = Boolean(atTrigger && focused && !locked && !atDismissed);

  useEffect(() => {
    if (!atTrigger) {
      setAtDismissed(false);
    }
  }, [atTrigger]);

  useEffect(() => {
    if (!atOpen || !workspaceId) return;
    if (treeCache[workspaceId]) return;
    let cancelled = false;
    void (async () => {
      try {
        const tree = await getWorkspaceTree(workspaceId);
        if (cancelled) return;
        const files = tree.entries.filter((e) => e.type === 'file').map((e) => e.path);
        setTreeCache((prev) => ({ ...prev, [workspaceId]: { files, error: false } }));
      } catch {
        if (cancelled) return;
        setTreeCache((prev) => ({ ...prev, [workspaceId]: { files: [], error: true } }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [atOpen, workspaceId, treeCache]);

  const cachedTree = workspaceId ? treeCache[workspaceId] : null;
  const treeError = Boolean(cachedTree?.error);
  const treeLoading = atOpen && Boolean(workspaceId && !cachedTree);

  const matchedFiles = useMemo(() => {
    if (!atTrigger || treeError) return [];
    const files = cachedTree?.files || [];
    return filterAtFiles(files, atTrigger.query, 6);
  }, [atTrigger, treeError, cachedTree]);

  useEffect(() => {
    if (atOpen) {
      const currentQuery = atTrigger?.query ?? '';
      const isOpening = !prevOpenRef.current;
      if (shouldResetAtActiveIndex(prevQueryRef.current, currentQuery, isOpening)) {
        atActiveIndexRef.current = 0;
        setAtActiveIndex(0);
      }
      prevQueryRef.current = currentQuery;
    } else {
      prevQueryRef.current = null;
    }
    prevOpenRef.current = atOpen;
  }, [atOpen, atTrigger?.query]);

  const pickAtFile = useCallback((relPath: string) => {
    const el = textareaRef.current;
    const cur = el ? (el.selectionStart ?? activeCursor) : activeCursor;
    const trigger = matchAtTrigger(draft, cur) || atTrigger;
    if (!trigger) {
      addProjectFile(relPath);
      return;
    }
    const applied = applyAtSelection(draft, relPath, trigger);
    addFileRef(relPath);
    setDraft(applied.text);
    setCursorPos(applied.nextCursor);
    if (el) {
      el.focus();
      el.setSelectionRange(applied.nextCursor, applied.nextCursor);
    }
    requestAnimationFrame(() => {
      if (el) {
        if (el.value === applied.text) {
          el.focus();
          el.setSelectionRange(applied.nextCursor, applied.nextCursor);
          setCursorPos(applied.nextCursor);
        }
        onResize();
      }
    });
  }, [activeCursor, addFileRef, addProjectFile, atTrigger, draft, onResize, setDraft, textareaRef]);

  const insertFileAt = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      const start = el.selectionStart ?? draft.length;
      const end = el.selectionEnd ?? draft.length;
      const next = draft.slice(0, start) + '@' + draft.slice(end);
      const nextPos = start + 1;
      setDraft(next);
      setCursorPos(nextPos);
      setFocused(true);
      el.focus();
      el.setSelectionRange(nextPos, nextPos);
      requestAnimationFrame(() => {
        if (el.value === next) {
          el.focus();
          el.setSelectionRange(nextPos, nextPos);
        }
        onResize();
      });
    } else {
      setDraft((cur) => cur + '@');
      setCursorPos(draft.length + 1);
      setFocused(true);
    }
  }, [draft, onResize, setDraft, setFocused, textareaRef]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!atOpen) return false;
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Enter' ||
      event.key === 'Tab' ||
      event.key === 'Escape'
    ) {
      event.preventDefault();
    }
    if (event.key === 'Escape') {
      setAtDismissed(true);
      return true;
    }
    if (event.key === 'ArrowDown') {
      if (matchedFiles.length > 0) {
        const next = stepAtActiveIndex(atActiveIndexRef.current, matchedFiles.length, 'down');
        atActiveIndexRef.current = next;
        setAtActiveIndex(next);
      }
      return true;
    }
    if (event.key === 'ArrowUp') {
      if (matchedFiles.length > 0) {
        const next = stepAtActiveIndex(atActiveIndexRef.current, matchedFiles.length, 'up');
        atActiveIndexRef.current = next;
        setAtActiveIndex(next);
      }
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (!event.nativeEvent.isComposing && event.keyCode !== 229) {
        if (matchedFiles.length > 0) {
          const picked = resolveAtSelection(matchedFiles, atActiveIndexRef.current);
          if (picked) {
            pickAtFile(picked);
          }
        }
      }
      return true;
    }
    return false;
  }

  return {
    atOpen,
    atActiveIndex,
    treeError,
    treeLoading,
    matchedFiles,
    cursorPos,
    setCursorPos,
    setAtDismissed,
    pickAtFile,
    insertFileAt,
    handleKeyDown,
  };
}
