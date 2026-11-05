import { useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { getLanguageExtension } from './codeEditorLanguages';
import { editorSyntaxHighlighting, editorTheme } from './codeEditorTheme';

export const setTargetLineEffect = StateEffect.define<number | null>();
export const externalSyncAnnotation = Annotation.define<boolean>();

export const targetLineField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setTargetLineEffect)) {
        const lineNum = effect.value;
        if (lineNum != null && lineNum >= 1 && lineNum <= tr.state.doc.lines) {
          const line = tr.state.doc.line(lineNum);
          const deco = Decoration.line({
            attributes: {
              class: 'cm-target-line file-line is-target',
              'data-line': String(lineNum),
            },
          });
          decorations = Decoration.set([deco.range(line.from)]);
        } else {
          decorations = Decoration.none;
        }
      }
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export type CodeEditorProps = {
  filePath: string;
  value: string;
  onChange: (value: string) => void;
  targetLine?: number | null;
  onSave?: (overwrite?: boolean) => void | Promise<void>;
  readOnly?: boolean;
};

export function CodeEditor({
  filePath,
  value,
  onChange,
  targetLine,
  onSave,
  readOnly = false,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const historyCompartmentRef = useRef<Compartment | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const langCompartment = new Compartment();
    const readOnlyCompartment = new Compartment();
    const historyCompartment = new Compartment();
    historyCompartmentRef.current = historyCompartment;

    const initialExtensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      historyCompartment.of(history()),
      search({ top: true }),
      keymap.of([
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      editorTheme,
      editorSyntaxHighlighting,
      targetLineField,
      langCompartment.of([]),
      readOnlyCompartment.of(readOnly ? EditorState.readOnly.of(true) : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const isExternalSync = update.transactions.some((tr) => tr.annotation(externalSyncAnnotation));
          if (!isExternalSync) {
            const docString = update.state.doc.toString();
            onChangeRef.current(docString);
          }
        }
      }),
    ];

    const state = EditorState.create({
      doc: value,
      extensions: initialExtensions,
    });

    const view = new EditorView({
      state,
      parent: container,
    });
    viewRef.current = view;

    // Scroll to and highlight targetLine if present
    if (targetLine != null && targetLine >= 1 && targetLine <= view.state.doc.lines) {
      const line = view.state.doc.line(targetLine);
      view.dispatch({
        effects: [
          setTargetLineEffect.of(targetLine),
          EditorView.scrollIntoView(line.from, { y: 'center' }),
        ],
      });
    }

    // Load language extension asynchronously
    let cancelled = false;
    void getLanguageExtension(filePath).then((langExt) => {
      if (cancelled || !viewRef.current) return;
      if (langExt) {
        viewRef.current.dispatch({
          effects: langCompartment.reconfigure(langExt),
        });
      }
    });

    // Request measure to adapt to zoom / layout
    view.requestMeasure();
    const resizeObserver = new ResizeObserver(() => {
      view.requestMeasure();
    });
    resizeObserver.observe(container);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      view.destroy();
      viewRef.current = null;
      historyCompartmentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recreate editor when filePath changes
  }, [filePath]);

  // Sync external value updates (e.g. reload from server)
  useEffect(() => {
    const view = viewRef.current;
    const historyCompartment = historyCompartmentRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (value !== currentDoc) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
        effects: historyCompartment ? historyCompartment.reconfigure([]) : [],
        annotations: [
          externalSyncAnnotation.of(true),
          Transaction.addToHistory.of(false),
          isolateHistory.of('full'),
        ],
      });
      if (historyCompartment) {
        view.dispatch({
          effects: historyCompartment.reconfigure(history()),
        });
      }
    }
  }, [value]);

  // Update targetLine dynamically
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentLines = view.state.doc.lines;
    const valid = targetLine != null && targetLine >= 1 && targetLine <= currentLines ? targetLine : null;
    const effects: StateEffect<unknown>[] = [setTargetLineEffect.of(valid)];
    if (valid != null) {
      const line = view.state.doc.line(valid);
      effects.push(EditorView.scrollIntoView(line.from, { y: 'center' }));
    }
    view.dispatch({ effects });
  }, [targetLine]);

  // Global Cmd+S / Ctrl+S shortcut handler
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        void onSaveRef.current?.();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      ref={containerRef}
      className="code-editor-container file-view-content"
      data-testid="code-editor"
    />
  );
}
