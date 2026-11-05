/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undo, undoDepth } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CodeEditor, setTargetLineEffect, targetLineField } from './CodeEditor';
import { getFileExtension, getLanguageExtension } from './codeEditorLanguages';

describe('codeEditorLanguages', () => {
  it('extracts extensions correctly', () => {
    expect(getFileExtension('file.ts')).toBe('ts');
    expect(getFileExtension('path/to/component.tsx')).toBe('tsx');
    expect(getFileExtension('script.js')).toBe('js');
    expect(getFileExtension('data.json')).toBe('json');
    expect(getFileExtension('styles.css')).toBe('css');
    expect(getFileExtension('index.html')).toBe('html');
    expect(getFileExtension('doc.md')).toBe('md');
    expect(getFileExtension('run.py')).toBe('py');
    expect(getFileExtension('config.yaml')).toBe('yaml');
    expect(getFileExtension('config.yml')).toBe('yml');
    expect(getFileExtension('no-ext')).toBe('');
    expect(getFileExtension('.gitignore')).toBe('');
  });

  it('loads language extensions for supported languages', async () => {
    const tsExt = await getLanguageExtension('src/test.ts');
    expect(tsExt).not.toBeNull();

    const pyExt = await getLanguageExtension('main.py');
    expect(pyExt).not.toBeNull();

    const jsonExt = await getLanguageExtension('pkg.json');
    expect(jsonExt).not.toBeNull();

    const mdExt = await getLanguageExtension('README.md');
    expect(mdExt).not.toBeNull();

    const txtExt = await getLanguageExtension('notes.txt');
    expect(txtExt).toBeNull();
  });
});

describe('targetLineField', () => {
  it('decorates the target line with cm-target-line and data-line attribute', () => {
    const state = EditorState.create({
      doc: 'line 1\nline 2\nline 3\n',
      extensions: [targetLineField],
    });

    const tr = state.update({
      effects: [setTargetLineEffect.of(2)],
    });

    const deco = tr.state.field(targetLineField);
    let count = 0;
    let dataLine = '';
    deco.between(0, tr.state.doc.length, (_from, _to, value) => {
      count += 1;
      const attrs = (value.spec as { attributes?: Record<string, string> }).attributes;
      dataLine = attrs?.['data-line'] ?? '';
    });

    expect(count).toBe(1);
    expect(dataLine).toBe('2');
  });
});

describe('CodeEditor component', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    // Mock ResizeObserver
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    if (host && host.parentNode) {
      host.parentNode.removeChild(host);
      host = null;
    }
  });

  it('renders without error and mounts CodeMirror container', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root!.render(
        <CodeEditor
          filePath="test.ts"
          value="const a = 1;"
          onChange={onChange}
        />,
      );
    });

    const editorEl = host?.querySelector('[data-testid="code-editor"]');
    expect(editorEl).not.toBeNull();
    const cmEditor = host?.querySelector('.cm-editor');
    expect(cmEditor).not.toBeNull();
  });

  it('destroys EditorView on unmount', async () => {
    const destroySpy = vi.spyOn(EditorView.prototype, 'destroy');
    await act(async () => {
      root!.render(
        <CodeEditor
          filePath="test.ts"
          value="const a = 1;"
          onChange={() => {}}
        />,
      );
    });

    expect(host?.querySelector('.cm-editor')).not.toBeNull();

    await act(async () => {
      root!.unmount();
      root = null;
    });

    expect(destroySpy).toHaveBeenCalled();
    destroySpy.mockRestore();
  });

  it('does not trigger onChange on external value update and isolates/clears undo history', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root!.render(
        <CodeEditor
          filePath="test.ts"
          value="initial text"
          onChange={onChange}
        />,
      );
    });

    const cmEditor = host?.querySelector('.cm-editor') as HTMLElement;
    expect(cmEditor).not.toBeNull();
    const view = EditorView.findFromDOM(cmEditor)!;
    expect(view).not.toBeNull();
    expect(view.state.doc.toString()).toBe('initial text');

    // Simulate user editing the document
    await act(async () => {
      view.dispatch({
        changes: { from: 0, to: 0, insert: 'dirty ' },
      });
    });

    expect(onChange).toHaveBeenCalledWith('dirty initial text');
    expect(view.state.doc.toString()).toBe('dirty initial text');
    expect(undoDepth(view.state)).toBeGreaterThan(0);
    onChange.mockClear();

    // Now simulate external reload (e.g. reloadFile from server)
    await act(async () => {
      root!.render(
        <CodeEditor
          filePath="test.ts"
          value="reloaded from server"
          onChange={onChange}
        />,
      );
    });

    // 1. External sync must NOT trigger onChange
    expect(onChange).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('reloaded from server');

    // 2. Undo history must be cleared/isolated so undo does not revert to old dirty content
    expect(undoDepth(view.state)).toBe(0);
    const undone = undo(view);
    expect(undone).toBe(false);
    expect(view.state.doc.toString()).toBe('reloaded from server');
  });
});
