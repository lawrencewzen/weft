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
import { listSkills, type Skill } from '../../data/api';
import {
  filterSlashItems,
  matchSlashTrigger,
  slashCommands,
  slashSkillItems,
  stepSlashIndex,
  type SlashCommandId,
  type SlashContext,
  type SlashItem,
  type SlashSkillRef,
} from '../../data/slashCommand';
import type { Lang } from '../../data/lang';

export type UseSlashCommandOptions = {
  lang: Lang;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  locked: boolean;
  focused: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onResize: () => void;
  context: SlashContext;
  onCommand: (id: Exclude<SlashCommandId, 'handoff' | 'schedule'>) => void;
};

export type UseSlashCommandResult = ReturnType<typeof useSlashCommand>;

export function useSlashCommand({
  lang,
  draft,
  setDraft,
  locked,
  focused,
  textareaRef,
  onResize,
  context,
  onCommand,
}: UseSlashCommandOptions) {
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeRef = useRef(0);
  activeRef.current = activeIndex;
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [skill, setSkill] = useState<SlashSkillRef | null>(null);

  const trigger = useMemo(() => matchSlashTrigger(draft), [draft]);
  const wantOpen = Boolean(trigger && focused && !locked && !dismissed);

  useEffect(() => {
    if (!trigger) setDismissed(false);
  }, [trigger]);

  useEffect(() => {
    if (!focused || locked || skills) return;
    let cancelled = false;
    void listSkills(lang).then(
      (res) => { if (!cancelled) setSkills(res.skills); },
      () => { if (!cancelled) setSkills([]); },
    );
    return () => { cancelled = true; };
  }, [focused, locked, skills, lang]);

  const { hasConversation, running, compacting, handoffRunning } = context;
  const items = useMemo(() => {
    if (!trigger) return [];
    const all: SlashItem[] = [
      ...slashCommands({ hasConversation, running, compacting, handoffRunning }),
      ...slashSkillItems(skills ?? []),
    ];
    return filterSlashItems(all, trigger.query);
  }, [trigger, skills, hasConversation, running, compacting, handoffRunning]);

  // No match: stay closed so Enter sends the text as a normal message.
  const open = wantOpen && items.length > 0;

  const query = trigger?.query ?? '';
  useEffect(() => {
    activeRef.current = 0;
    setActiveIndex(0);
  }, [query, open]);

  const focusEnd = useCallback((text: string) => {
    const el = textareaRef.current;
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      // Only if the user has not typed on since: a stale caret would scramble their text.
      if (el.value === text) el.setSelectionRange(text.length, text.length);
      onResize();
    });
  }, [onResize, textareaRef]);

  const pick = useCallback((item: SlashItem) => {
    if (item.disabled) return;
    if (item.kind === 'skill') {
      setSkill({ id: item.id, name: item.name });
      setDraft('');
      focusEnd('');
      return;
    }
    if (item.id === 'handoff' || item.id === 'schedule') {
      const text = `/${item.id} `;
      setDraft(text);
      focusEnd(text);
      return;
    }
    setDraft('');
    focusEnd('');
    onCommand(item.id);
  }, [focusEnd, onCommand, setDraft]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open) return false;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      const next = stepSlashIndex(activeRef.current, items.length, key === 'ArrowDown' ? 'down' : 'up');
      activeRef.current = next;
      setActiveIndex(next);
      return true;
    }
    if (key === 'Enter' || key === 'Tab') {
      event.preventDefault();
      const picked = items[Math.min(activeRef.current, items.length - 1)];
      if (picked) pick(picked);
      return true;
    }
    return false;
  }

  return {
    open,
    items,
    activeIndex,
    skill,
    setSkill,
    pick,
    handleKeyDown,
  };
}
