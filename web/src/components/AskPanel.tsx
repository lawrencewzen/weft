import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  getSnapshot,
  sendAnswer,
  type AskQuestion,
  type AskSelection,
} from '../data/api';
import { askDraftStorageKey, type ToolCall } from '../data/ask';
import type { Lang } from '../data/lang';
import { useSession } from '../data/session';
import { conversationTopic } from '../data/store';
import { t } from '../i18n';

type Props = {
  cid: string;
  tool: ToolCall;
  lang: Lang;
  canStop?: boolean;
  onStop?: () => void;
  onAnswered?: () => void;
  onDismiss?: () => void;
};

export type QuestionState = {
  selected: string[];
  otherText: string;
  mode: 'preset' | 'custom' | null;
};

export function isQuestionAnswered(q: AskQuestion, state: QuestionState | undefined): boolean {
  if (!state) return false;
  if (q.multiSelect) {
    return state.selected.length > 0 || state.otherText.trim().length > 0;
  }
  if (state.mode === 'custom') {
    return state.otherText.trim().length > 0;
  }
  if (state.mode === 'preset') {
    return state.selected.length > 0;
  }
  return state.selected.length > 0 || state.otherText.trim().length > 0;
}

export function AskPanel({
  cid,
  tool,
  lang,
  canStop,
  onStop,
  onAnswered,
  onDismiss,
}: Props) {
  const { store } = useSession();
  const questions: AskQuestion[] = useMemo(() => tool.ask?.questions ?? [], [tool.ask?.questions]);
  const [activeTab, setActiveTab] = useState(0);
  const [focusedOptionIdx, setFocusedOptionIdx] = useState(0);
  const [isKeyboard, setIsKeyboard] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const submitBtnRef = useRef<HTMLButtonElement | null>(null);
  const jumpTimerRef = useRef<number | null>(null);
  const hasFocusedRef = useRef(false);

  // Initialize selections from sessionStorage draft if available
  const [selections, setSelections] = useState<QuestionState[]>(() => {
    try {
      const saved = sessionStorage.getItem(askDraftStorageKey(cid, tool.id));
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === questions.length) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return questions.map(() => ({
      selected: [],
      otherText: '',
      mode: null,
    }));
  });

  // Save draft to sessionStorage on change
  useEffect(() => {
    try {
      sessionStorage.setItem(askDraftStorageKey(cid, tool.id), JSON.stringify(selections));
    } catch {
      // ignore
    }
  }, [cid, tool.id, selections]);

  // Clear jump timer on unmount
  useEffect(() => {
    return () => {
      if (jumpTimerRef.current) {
        window.clearTimeout(jumpTimerRef.current);
      }
    };
  }, []);

  const currentQuestion: AskQuestion | undefined = questions[activeTab];
  const currentSel: QuestionState = selections[activeTab] || { selected: [], otherText: '', mode: null };

  const allAnswered = questions.length > 0 && questions.every((q, idx) =>
    isQuestionAnswered(q, selections[idx]),
  );

  // Question tab switch: focus first option or selected option (Req 12)
  useEffect(() => {
    if (!currentQuestion) return;
    const selIdx = currentQuestion.options.findIndex((opt) => currentSel.selected.includes(opt.label));
    const targetIdx = selIdx >= 0 ? selIdx : 0;
    setFocusedOptionIdx(targetIdx);
    optionRefs.current[targetIdx]?.focus();
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-grow textarea
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const minHeight = 44;
    const maxHeight = 132;
    const targetHeight = Math.max(minHeight, Math.min(el.scrollHeight, maxHeight));
    el.style.height = `${targetHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [activeTab, currentSel.otherText, adjustTextareaHeight]);

  // Initial focus management: focus first or selected option once ready (without keyboard focus ring)
  useEffect(() => {
    if (hasFocusedRef.current) return;
    if (!currentQuestion || currentQuestion.options.length === 0) return;
    const active = document.activeElement;
    const isOtherInput = Boolean(
      active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && !panelRef.current?.contains(active),
    );
    if (!isOtherInput) {
      const selIdx = currentQuestion.options.findIndex((opt) => currentSel.selected.includes(opt.label));
      const targetIdx = selIdx >= 0 ? selIdx : 0;
      setFocusedOptionIdx(targetIdx);
      optionRefs.current[targetIdx]?.focus({ preventScroll: true });
      hasFocusedRef.current = true;
    }
  }, [currentQuestion, currentSel.selected]);

  const changeTab = useCallback((nextTab: number) => {
    if (jumpTimerRef.current) window.clearTimeout(jumpTimerRef.current);
    setActiveTab(nextTab);
    const q = questions[nextTab];
    const sel = selections[nextTab];
    const selIdx = q && sel ? q.options.findIndex((opt) => sel.selected.includes(opt.label)) : -1;
    const targetIdx = selIdx >= 0 ? selIdx : 0;
    setFocusedOptionIdx(targetIdx);
  }, [questions, selections]);

  const scheduleAdvanceIfSingle = useCallback((fromTab: number, nextSelections: QuestionState[]) => {
    if (questions.length <= 1) return;
    if (jumpTimerRef.current) window.clearTimeout(jumpTimerRef.current);

    jumpTimerRef.current = window.setTimeout(() => {
      // Find next unanswered question forward, then wrap around
      let nextUnanswered = -1;
      for (let i = fromTab + 1; i < questions.length; i++) {
        if (!isQuestionAnswered(questions[i], nextSelections[i])) {
          nextUnanswered = i;
          break;
        }
      }
      if (nextUnanswered === -1) {
        for (let i = 0; i < fromTab; i++) {
          if (!isQuestionAnswered(questions[i], nextSelections[i])) {
            nextUnanswered = i;
            break;
          }
        }
      }

      if (nextUnanswered !== -1) {
        changeTab(nextUnanswered);
      } else {
        // Last question or no unanswered question left: focus submit button
        submitBtnRef.current?.focus();
      }
    }, 150);
  }, [changeTab, questions]);

  const applyOptionSelect = useCallback((
    qIdx: number,
    label: string,
    currentSelections: QuestionState[],
    mode: 'toggle' | 'select' = 'toggle',
  ): QuestionState[] => {
    const q = questions[qIdx];
    if (!q) return currentSelections;
    const next = [...currentSelections];
    const cur = next[qIdx] || { selected: [], otherText: '', mode: null };

    if (q.multiSelect) {
      const exists = cur.selected.includes(label);
      if (mode === 'select') {
        next[qIdx] = {
          ...cur,
          selected: exists ? cur.selected : [...cur.selected, label],
        };
      } else {
        next[qIdx] = {
          ...cur,
          selected: exists ? cur.selected.filter((l) => l !== label) : [...cur.selected, label],
        };
      }
    } else {
      next[qIdx] = {
        selected: [label],
        otherText: cur.otherText,
        mode: 'preset',
      };
    }
    return next;
  }, [questions]);

  const handleSelectOption = (label: string, mode: 'toggle' | 'select' = 'toggle') => {
    if (!currentQuestion) return;
    const qIdx = activeTab;

    setSelections((prev) => {
      const next = applyOptionSelect(qIdx, label, prev, mode);
      if (!currentQuestion.multiSelect) {
        scheduleAdvanceIfSingle(qIdx, next);
      }
      return next;
    });
  };

  const handleTextareaChange = (text: string) => {
    if (!currentQuestion) return;
    const qIdx = activeTab;

    setSelections((prev) => {
      const next = [...prev];
      const cur = next[qIdx] || { selected: [], otherText: '', mode: null };

      if (currentQuestion.multiSelect) {
        next[qIdx] = {
          ...cur,
          otherText: text,
        };
      } else {
        // Single-select: typing non-empty clears selected options
        const hasText = text.trim().length > 0;
        next[qIdx] = {
          selected: hasText ? [] : cur.selected,
          otherText: text,
          mode: hasText ? 'custom' : (cur.selected.length > 0 ? 'preset' : null),
        };
      }
      return next;
    });
  };

  const advanceToNextStep = () => {
    if (jumpTimerRef.current) {
      window.clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = null;
    }

    if (questions.length > 1) {
      if (activeTab < questions.length - 1) {
        changeTab(activeTab + 1);
        return;
      }
      // On last tab: if any earlier tab is unanswered, jump to it
      const firstUnanswered = questions.findIndex((q, i) => !isQuestionAnswered(q, selections[i]));
      if (firstUnanswered !== -1 && firstUnanswered !== activeTab) {
        changeTab(firstUnanswered);
        return;
      }
    }

    if (allAnswered && !submitting) {
      handleSubmit();
    } else {
      submitBtnRef.current?.focus();
    }
  };

  const handleOptionsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!currentQuestion) return;

    // Any modifier keys (Cmd, Ctrl, Alt) are ignored by option-level keybindings:
    // allows global shortcuts (Cmd+Enter to submit, browser Cmd+1..9, etc.) without mutating selections
    if (e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }

    setIsKeyboard(true);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = (focusedOptionIdx + 1) % currentQuestion.options.length;
      setFocusedOptionIdx(nextIdx);
      optionRefs.current[nextIdx]?.focus();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const nextIdx = (focusedOptionIdx - 1 + currentQuestion.options.length) % currentQuestion.options.length;
      setFocusedOptionIdx(nextIdx);
      optionRefs.current[nextIdx]?.focus();
      return;
    }

    if (e.key === 'ArrowLeft') {
      if (questions.length > 1 && activeTab > 0) {
        e.preventDefault();
        changeTab(activeTab - 1);
      }
      return;
    }

    if (e.key === 'ArrowRight') {
      if (questions.length > 1 && activeTab < questions.length - 1) {
        e.preventDefault();
        changeTab(activeTab + 1);
      }
      return;
    }

    if (['1', '2', '3', '4'].includes(e.key)) {
      const digitIdx = parseInt(e.key, 10) - 1;
      if (digitIdx >= 0 && digitIdx < currentQuestion.options.length) {
        e.preventDefault();
        setFocusedOptionIdx(digitIdx);
        optionRefs.current[digitIdx]?.focus();
        handleSelectOption(currentQuestion.options[digitIdx].label, 'select');
      }
      return;
    }

    if (e.key === ' ') {
      e.preventDefault();
      if (focusedOptionIdx >= 0 && focusedOptionIdx < currentQuestion.options.length) {
        handleSelectOption(currentQuestion.options[focusedOptionIdx].label, 'toggle');
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (focusedOptionIdx >= 0 && focusedOptionIdx < currentQuestion.options.length) {
        if (jumpTimerRef.current) {
          window.clearTimeout(jumpTimerRef.current);
          jumpTimerRef.current = null;
        }

        const opt = currentQuestion.options[focusedOptionIdx];
        const nextSelections = applyOptionSelect(activeTab, opt.label, selections, 'select');
        setSelections(nextSelections);

        const isEverythingAnswered = questions.length > 0 && questions.every((q, idx) =>
          isQuestionAnswered(q, nextSelections[idx]),
        );

        if (questions.length > 1) {
          if (activeTab < questions.length - 1) {
            changeTab(activeTab + 1);
            return;
          }
          // On last tab:
          if (isEverythingAnswered) {
            submitWithSelections(nextSelections);
          } else {
            const firstUnanswered = questions.findIndex((q, i) => !isQuestionAnswered(q, nextSelections[i]));
            if (firstUnanswered !== -1 && firstUnanswered !== activeTab) {
              changeTab(firstUnanswered);
            } else {
              submitBtnRef.current?.focus();
            }
          }
        } else {
          // Single question:
          if (isEverythingAnswered) {
            submitWithSelections(nextSelections);
          } else {
            submitBtnRef.current?.focus();
          }
        }
      }
      return;
    }

    if (e.key === 'Escape') {
      // Esc in options does nothing (never skip)
      e.preventDefault();
      return;
    }
  };

  const handleTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setIsKeyboard(true);
      // Return focus to options area: focus the selected option or first option
      if (currentQuestion) {
        const selIdx = currentQuestion.options.findIndex((opt) => currentSel.selected.includes(opt.label));
        const targetIdx = selIdx >= 0 ? selIdx : 0;
        setFocusedOptionIdx(targetIdx);
        optionRefs.current[targetIdx]?.focus();
      }
      return;
    }

    // Ignore Chinese IME composition Enter
    if (e.nativeEvent.isComposing || (e as unknown as { isComposing?: boolean }).isComposing) {
      return;
    }

    // Cmd/Ctrl+Enter submits without inserting newline or toggling options
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      return;
    }

    if (e.key === 'Enter') {
      if (e.shiftKey) {
        // Shift+Enter creates a new line
        return;
      }
      // Enter without Shift advances to next step
      e.preventDefault();
      advanceToNextStep();
      return;
    }
  };

  const refreshAndDismiss = useCallback(async () => {
    try {
      const snap = await getSnapshot(cid, lang);
      const topic = conversationTopic(cid);
      store.applySnapshot({
        protocolVersion: '1',
        topics: [topic],
        entities: [
          { topic, entity: 'conversation', id: cid, value: snap.conversation as unknown as Record<string, unknown> },
          ...snap.items.map((item) => ({ topic, entity: 'item', id: item.id, value: item as unknown as Record<string, unknown> })),
          ...snap.tools.map((t) => ({ topic, entity: 'tool', id: t.id, value: t as unknown as Record<string, unknown> })),
        ],
      });
    } catch {
      // ignore
    } finally {
      onDismiss?.();
    }
  }, [cid, lang, onDismiss, store]);

  const handleError = useCallback(async (err: unknown) => {
    const status = typeof err === 'object' && err !== null && 'status' in err
      ? (err as { status: number }).status
      : 0;
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code: string }).code
      : '';

    if (status === 409 || code === 'E_ASK_ANSWERED') {
      await refreshAndDismiss();
    } else {
      const msg = (err instanceof Error && err.message) || t(lang, 'ask_submit_failed');
      setError(msg);
      setSubmitting(false);
    }
  }, [lang, refreshAndDismiss]);

  const submitWithSelections = useCallback(async (targetSelections: QuestionState[]) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const answers: AskSelection[] = questions.map((q, idx) => {
      const sel = targetSelections[idx];
      if (!sel) return { questionIndex: idx, selected: [] };

      if (q.multiSelect) {
        const row: AskSelection = { questionIndex: idx, selected: sel.selected };
        if (sel.otherText.trim()) row.other = sel.otherText.trim();
        return row;
      }

      // Single select: mutual exclusivity! Never submit both selected and other
      if (sel.mode === 'custom' && sel.otherText.trim()) {
        return { questionIndex: idx, selected: [], other: sel.otherText.trim() };
      }
      if (sel.selected.length > 0) {
        return { questionIndex: idx, selected: sel.selected };
      }
      if (sel.otherText.trim()) {
        return { questionIndex: idx, selected: [], other: sel.otherText.trim() };
      }
      return { questionIndex: idx, selected: [] };
    });

    try {
      await sendAnswer(cid, { toolCallId: tool.id, answers });
      try {
        sessionStorage.removeItem(askDraftStorageKey(cid, tool.id));
      } catch {
        // ignore
      }
      // Optimistically update tool in store for immediate record update
      const topic = conversationTopic(cid);
      const updatedTool = {
        ...tool,
        ask: {
          ...tool.ask,
          answer: {
            answers,
            skipped: false,
          },
        },
      };
      store.applyUpsert({
        topic,
        entity: 'tool',
        id: tool.id,
        value: updatedTool as unknown as Record<string, unknown>,
      });
      // Immediately collapse panel and restore composer
      onDismiss?.();
      onAnswered?.();
    } catch (err: unknown) {
      await handleError(err);
    }
  }, [cid, handleError, onAnswered, onDismiss, questions, store, submitting, tool]);

  const handleSubmit = useCallback(() => {
    if (!allAnswered || submitting) return;
    submitWithSelections(selections);
  }, [allAnswered, selections, submitWithSelections, submitting]);

  const handleSkip = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      await sendAnswer(cid, { toolCallId: tool.id, answers: [], skipped: true });
      try {
        sessionStorage.removeItem(askDraftStorageKey(cid, tool.id));
      } catch {
        // ignore
      }
      // Optimistically update tool in store for immediate record update
      const topic = conversationTopic(cid);
      const updatedTool = {
        ...tool,
        ask: {
          ...tool.ask,
          answer: {
            answers: [],
            skipped: true,
          },
        },
      };
      store.applyUpsert({
        topic,
        entity: 'tool',
        id: tool.id,
        value: updatedTool as unknown as Record<string, unknown>,
      });
      onDismiss?.();
      onAnswered?.();
    } catch (err: unknown) {
      await handleError(err);
    }
  };

  // Global keydown: Cmd/Ctrl+Enter submits from anywhere when valid
  const handlePanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (allAnswered && !submitting) {
        e.preventDefault();
        handleSubmit();
      }
    }
  };

  const isTextareaMuted = Boolean(
    currentQuestion &&
    !currentQuestion.multiSelect &&
    currentSel.mode === 'preset' &&
    currentSel.otherText.length > 0,
  );

  return (
    <div
      ref={panelRef}
      className="ask-panel"
      data-testid="next-ask-panel"
      onKeyDown={handlePanelKeyDown}
      onPointerDown={() => setIsKeyboard(false)}
    >
      {questions.length > 1 ? (
        <div className="ask-header">
          <div className="ask-tabs" role="tablist">
            {questions.map((q, idx) => {
              const answered = isQuestionAnswered(q, selections[idx]);
              return (
                <button
                  key={idx}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === idx}
                  className={`ask-tab${activeTab === idx ? ' is-active' : ''}${answered ? ' is-answered' : ''}`}
                  data-testid="next-ask-tab"
                  onClick={() => {
                    setIsKeyboard(false);
                    changeTab(idx);
                  }}
                >
                  <span>{q.header || `${idx + 1}`}</span>
                  {answered ? (
                    <span className="ask-tab-badge" aria-label="answered">✓</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="ask-progress" data-testid="next-ask-progress">
            {`${activeTab + 1} / ${questions.length}`}
          </div>
        </div>
      ) : null}

      {currentQuestion ? (
        <div className="ask-body">
          <div className="ask-question-title" data-testid="next-ask-question">
            {currentQuestion.question}
          </div>

          <div
            className={`ask-options${isKeyboard ? ' is-keyboard' : ''}`}
            role={currentQuestion.multiSelect ? 'group' : 'radiogroup'}
            onKeyDown={handleOptionsKeyDown}
          >
            {currentQuestion.options.map((opt, optIdx) => {
              const isSelected = currentSel.selected.includes(opt.label);
              const isFocused = isKeyboard && focusedOptionIdx === optIdx;
              return (
                <div
                  key={opt.label}
                  ref={(el) => { optionRefs.current[optIdx] = el; }}
                  role={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={isSelected}
                  tabIndex={focusedOptionIdx === optIdx ? 0 : -1}
                  className={`ask-option${isSelected ? ' is-selected' : ''}${isFocused ? ' is-focused' : ''}`}
                  data-testid="next-ask-option"
                  onClick={() => {
                    setIsKeyboard(false);
                    setFocusedOptionIdx(optIdx);
                    handleSelectOption(opt.label);
                  }}
                  onFocus={() => setFocusedOptionIdx(optIdx)}
                >
                  <span className="ask-option-check" />
                  <span className="ask-option-num">{optIdx + 1}</span>
                  <div className="ask-option-content">
                    <span className="ask-option-label">{opt.label}</span>
                    {opt.description ? (
                      <span className="ask-option-desc">{opt.description}</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="ask-other-wrap">
            <textarea
              ref={textareaRef}
              rows={2}
              className={`ask-other-textarea${isTextareaMuted ? ' is-muted' : ''}`}
              data-testid="next-ask-other-input"
              placeholder={t(lang, 'ask_other_placeholder')}
              value={currentSel.otherText}
              onChange={(e) => handleTextareaChange(e.target.value)}
              onKeyDown={handleTextareaKeyDown}
            />
          </div>
        </div>
      ) : null}

      <div className="ask-footer">
        <div className="ask-footer-left">
          <button
            type="button"
            className="ask-btn ask-btn-skip"
            data-testid="next-ask-skip"
            disabled={submitting}
            onClick={handleSkip}
          >
            {t(lang, 'ask_btn_skip')}
          </button>
          {canStop ? (
            <button
              type="button"
              className="ask-btn ask-btn-stop"
              data-testid="next-ask-stop"
              onClick={onStop}
            >
              {t(lang, 'ask_btn_stop')}
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="ask-panel-error" data-testid="next-ask-error">
            {error}
          </div>
        ) : null}

        <div className="ask-footer-right">
          {questions.length > 1 && activeTab > 0 ? (
            <button
              type="button"
              className="ask-btn ask-btn-prev"
              data-testid="next-ask-prev"
              onClick={() => {
                changeTab(activeTab - 1);
              }}
            >
              {t(lang, 'ask_btn_prev')}
            </button>
          ) : null}

          {questions.length > 1 && activeTab < questions.length - 1 ? (
            <button
              type="button"
              className="ask-btn ask-btn-next"
              data-testid="next-ask-next"
              onClick={() => {
                changeTab(activeTab + 1);
              }}
            >
              {t(lang, 'ask_btn_next')}
            </button>
          ) : (
            <button
              ref={submitBtnRef}
              type="button"
              className="ask-btn ask-btn-submit"
              data-testid="next-ask-submit"
              disabled={!allAnswered || submitting}
              onClick={handleSubmit}
            >
              {t(lang, 'ask_btn_submit')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
