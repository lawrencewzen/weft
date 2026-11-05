import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export const customHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.color], color: 'var(--syn-kw)', fontWeight: '600' },
  { tag: [t.atom, t.bool, t.null], color: 'var(--syn-kw)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--syn-fn)' },
  { tag: [t.standard(t.name), t.constant(t.name)], color: 'var(--syn-fn)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.propertyName], color: 'var(--syn-type)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-str)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--syn-num)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-com, var(--syn-comment))', fontStyle: 'italic' },
  { tag: [t.variableName], color: 'var(--ink)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--ink2)' },
  { tag: [t.operator, t.punctuation, t.separator], color: 'var(--ink3)' },
  { tag: [t.heading], color: 'var(--ink)', fontWeight: 'bold' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--drop)', textDecoration: 'underline' },
  { tag: [t.invalid], color: 'var(--fail)' },
]);

export const editorSyntaxHighlighting = syntaxHighlighting(customHighlightStyle, { fallback: true });

export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--panel)',
    color: 'var(--ink)',
    fontFamily: 'var(--font-mono, var(--mono))',
    fontSize: 'var(--fs-sm)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, var(--mono))',
    lineHeight: '1.7',
    overflow: 'auto',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono, var(--mono))',
    padding: '12px 16px',
    caretColor: 'var(--ink)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--ink)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--ink)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--sel) !important',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--panel)',
    color: 'var(--dis)',
    borderRight: '1px solid var(--line3)',
    fontFamily: 'var(--font-mono, var(--mono))',
    fontSize: 'var(--fs-xs)',
    userSelect: 'none',
  },
  '.cm-gutterElement': {
    padding: '0 12px 0 8px',
    minWidth: '32px',
    textAlign: 'right',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--hover-a)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--hover-a)',
    color: 'var(--ink2)',
  },
  '.cm-target-line': {
    backgroundColor: 'var(--sel) !important',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--warn-bg)',
    outline: '1px solid var(--warn-line)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--ok-bg)',
    outline: '1px solid var(--ok-line)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--sub)',
    color: 'var(--ink)',
    borderBottom: '1px solid var(--line)',
  },
  '.cm-panels-top': {
    borderBottom: '1px solid var(--line)',
  },
  '.cm-panels-bottom': {
    borderTop: '1px solid var(--line)',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--field)',
    color: 'var(--ink)',
    border: '1px solid var(--bd2)',
    borderRadius: '4px',
    padding: '2px 6px',
    fontFamily: 'inherit',
    fontSize: 'var(--fs-ui)',
    outline: 'none',
  },
  '.cm-textfield:focus': {
    borderColor: 'var(--border-focus)',
  },
  '.cm-button': {
    backgroundColor: 'var(--sub2)',
    color: 'var(--ink)',
    border: '1px solid var(--bd2)',
    borderRadius: '4px',
    padding: '2px 8px',
    fontSize: 'var(--fs-ui)',
    cursor: 'pointer',
  },
  '.cm-button:hover': {
    backgroundColor: 'var(--hover)',
  },
});
