/** @vitest-environment jsdom */

import { act, createElement, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listSkills } from '../../data/api';
import { resetSkillCatalog } from '../../data/skillCatalog';
import type { SlashContext } from '../../data/slashCommand';
import { InlineChip, chipLabel } from './SlashChip';
import { SlashCommandMenu } from './SlashCommandMenu';
import { useSlashCommand, type UseSlashCommandResult } from './useSlashCommand';

vi.mock('../../data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/api')>();
  return { ...actual, listSkills: vi.fn() };
});

const SKILLS = [
  { id: 'code-review', name: '代码审查', description: 'd', version: '1', source: 'x', enabled: true, deletable: false },
  { id: 'release-notes', name: '发布说明', description: 'd', version: '1', source: 'x', enabled: true, deletable: true },
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: {
  slash: UseSlashCommandResult;
  draft: string;
  setDraft: (v: string) => void;
  commands: string[];
} | null = null;

function Host(props: { context?: Partial<SlashContext>; locked?: boolean }) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commands = useRef<string[]>([]);
  const slash = useSlashCommand({
    draft,
    setDraft,
    locked: props.locked ?? false,
    focused: true,
    textareaRef,
    onResize: () => {},
    context: { hasConversation: true, running: false, compacting: false, handoffRunning: false, ...props.context },
    onCommand: (id) => { commands.current.push(id); },
  });
  latest = { slash, draft, setDraft, commands: commands.current };
  return createElement(
    'div',
    null,
    slash.open
      ? createElement(SlashCommandMenu, { lang: 'zh', items: slash.items, activeIndex: slash.activeIndex, flashId: slash.flashId, onPick: slash.pick })
      : null,
    slash.chip
      ? createElement(InlineChip, { label: chipLabel('zh', slash.chip), kind: slash.chip.kind, testId: 'next-composer-chip' })
      : null,
    createElement('textarea', { ref: textareaRef, value: draft, readOnly: true }),
  );
}

async function renderHost(props: { context?: Partial<SlashContext>; locked?: boolean } = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(Host, props)); });
}

async function cleanup() {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  latest = null;
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function keyEvent(key: string, composing = false): KeyboardEvent<HTMLTextAreaElement> {
  const native = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(native, 'nativeEvent', { value: { isComposing: composing } });
  Object.defineProperty(native, 'keyCode', { value: key === 'Enter' ? 13 : 0 });
  return native as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

async function type(text: string) {
  await act(async () => { latest!.setDraft(text); });
  await flush();
}

async function backspace(composing = false) {
  let handled = false;
  await act(async () => { handled = latest!.slash.handleBackspace(keyEvent('Backspace', composing)); });
  return handled;
}

async function press(key: string, composing = false) {
  let handled = false;
  await act(async () => { handled = latest!.slash.handleKeyDown(keyEvent(key, composing)); });
  return handled;
}

function ids() {
  return [...document.querySelectorAll('[data-testid="next-slash-item"]')].map((el) => el.getAttribute('data-id'));
}

describe('useSlashCommand', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetSkillCatalog();
    vi.mocked(listSkills).mockReset();
    vi.mocked(listSkills).mockResolvedValue({ skills: SKILLS });
  });
  afterEach(cleanup);

  it('opens only for a leading slash; groups commands before skills', async () => {
    await renderHost();
    await type('hello /');
    expect(latest!.slash.open).toBe(false);
    await type('a/b');
    expect(latest!.slash.open).toBe(false);
    await type('/');
    expect(latest!.slash.open).toBe(true);
    expect(ids()).toEqual(['compact', 'handoff', 'schedule', 'new', 'code-review', 'release-notes']);
    const headers = [...document.querySelectorAll('.composer-at-header')].map((e) => e.textContent);
    expect(headers).toEqual(['命令', '技能']);
  });

  it('filters while typing and closes when nothing matches', async () => {
    await renderHost();
    await type('/rev');
    expect(ids()).toEqual(['code-review']);
    await type('/zzz');
    expect(latest!.slash.open).toBe(false);
  });

  it('moves with arrows and confirms with Enter', async () => {
    await renderHost();
    await type('/');
    await press('ArrowDown');
    expect(latest!.slash.activeIndex).toBe(1);
    await press('ArrowUp');
    await press('ArrowUp');
    expect(latest!.slash.activeIndex).toBe(5);
    await press('ArrowDown');
    await press('ArrowDown');
    await press('ArrowDown');
    await press('ArrowDown');
    expect(latest!.slash.activeIndex).toBe(3);
    await press('Tab');
    expect(latest!.commands).toEqual(['new']);
  });

  it('Enter on /new runs the command and clears the draft', async () => {
    await renderHost();
    await type('/new');
    await press('Enter');
    expect(latest!.commands).toEqual(['new']);
    expect(latest!.draft).toBe('');
  });

  it('Esc dismisses until the slash is gone', async () => {
    await renderHost();
    await type('/c');
    expect(latest!.slash.open).toBe(true);
    await press('Escape');
    expect(latest!.slash.open).toBe(false);
    await type('/co');
    expect(latest!.slash.open).toBe(false);
    await type('');
    await type('/');
    expect(latest!.slash.open).toBe(true);
  });

  it('ignores keys while composing (IME)', async () => {
    await renderHost();
    await type('/');
    expect(await press('Enter', true)).toBe(false);
    expect(await press('ArrowDown', true)).toBe(false);
    expect(latest!.slash.activeIndex).toBe(0);
  });

  it('does not open when locked', async () => {
    await renderHost({ locked: true });
    await type('/');
    expect(latest!.slash.open).toBe(false);
  });

  it('draft: compact and handoff are absent', async () => {
    await renderHost({ context: { hasConversation: false } });
    await type('/');
    expect(ids().slice(0, 2)).toEqual(['schedule', 'new']);
    expect(ids()).not.toContain('compact');
  });

  it('running: compact is greyed with explanation, flashes on Enter and does not pick', async () => {
    await renderHost({ context: { running: true } });
    await type('/comp');
    const row = document.querySelector('[data-id="compact"]') as HTMLElement;
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(row?.querySelector('.composer-at-dir')?.textContent).toBe('运行中，结束后可用');
    await press('Enter');
    expect(latest!.commands).toEqual([]);
    expect(latest!.slash.chip).toBeNull();
    expect(latest!.slash.flashId).toBe('compact');
    expect(row?.getAttribute('data-flash')).toBe('true');
    expect(row?.querySelector('.composer-at-dir')?.classList.contains('is-flash')).toBe(true);
  });

  it('picking a skill shows a block with the skill name, clears the draft; Backspace at the start removes it', async () => {
    await renderHost();
    await type('/code');
    await press('Enter');
    expect(latest!.slash.chip).toEqual({ kind: 'skill', id: 'code-review', name: '代码审查' });
    expect(latest!.draft).toBe('');
    const chip = document.querySelector('[data-testid="next-composer-chip"]');
    expect(chip?.textContent).toBe('代码审查');
    // Caret not at the start: Backspace is left to the textarea.
    await type('abc');
    const ta = document.querySelector('textarea')!;
    ta.setSelectionRange(2, 2);
    expect(await backspace()).toBe(false);
    expect(latest!.slash.chip).not.toBeNull();
    ta.setSelectionRange(0, 0);
    expect(await backspace()).toBe(true);
    expect(latest!.slash.chip).toBeNull();
    expect(latest!.draft).toBe('abc');
    expect(document.querySelector('[data-testid="next-composer-chip"]')).toBeNull();
  });

  it('/compact, /handoff and /schedule become blocks named 压缩 / 交接 / 定时, with no slash text in the draft', async () => {
    await renderHost();
    await type('/comp');
    await press('Enter');
    expect(latest!.slash.chip).toEqual({ kind: 'compact' });
    expect(latest!.draft).toBe('');
    expect(document.querySelector('[data-testid="next-composer-chip"]')?.textContent).toBe('压缩');
    await type('/hand');
    await press('Enter');
    expect(latest!.slash.chip).toEqual({ kind: 'handoff' });
    expect(latest!.draft).toBe('');
    expect(document.querySelector('[data-testid="next-composer-chip"]')?.textContent).toBe('交接');
    await type('/sch');
    await press('Tab');
    expect(latest!.slash.chip).toEqual({ kind: 'schedule' });
    expect(document.querySelector('[data-testid="next-composer-chip"]')?.textContent).toBe('定时');
  });

  it('/new runs at once and leaves no block', async () => {
    await renderHost();
    await type('/new');
    await press('Enter');
    expect(latest!.commands).toEqual(['new']);
    expect(latest!.slash.chip).toBeNull();
  });

  it('Backspace is ignored while composing and without a block', async () => {
    await renderHost();
    expect(await backspace()).toBe(false);
    await type('/code');
    await press('Enter');
    expect(await backspace(true)).toBe(false);
    expect(latest!.slash.chip).not.toBeNull();
  });

  it('commands still work when listing skills fails', async () => {
    vi.mocked(listSkills).mockRejectedValue(new Error('x'));
    await renderHost();
    await type('/');
    expect(ids()).toEqual(['compact', 'handoff', 'schedule', 'new']);
  });
});
