import { describe, expect, it, vi } from 'vitest';
import { buildConversationItems } from './SidebarMenus';
import type { ConversationSummary } from '../data/store';

function makeConv(partial: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: 'c1',
    workspaceId: 'w1',
    title: 'Test conversation',
    updatedAt: Date.now(),
    status: 'idle',
    runningAgents: 0,
    subagents: null,
    archived: false,
    ...partial,
  };
}

describe('SidebarMenus.buildConversationItems', () => {
  it('builds menu items for a normal idle conversation', () => {
    const conv = makeConv({ archived: false, status: 'idle' });
    const openConversation = vi.fn();
    const copy = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();

    const items = buildConversationItems({
      lang: 'zh',
      wsId: 'w1',
      conv,
      openConversation,
      copy,
      onArchive,
      onDelete,
    });

    expect(items.map((it) => it.action ?? 'sep')).toEqual([
      'open',
      'copy-id',
      'sep',
      'archive',
      'delete',
    ]);

    const archiveItem = items.find((it) => it.action === 'archive');
    expect(archiveItem?.label).toBe('归档');
    expect(archiveItem?.disabled).toBe(false);
    expect(archiveItem?.title).toBeUndefined();

    const deleteItem = items.find((it) => it.action === 'delete');
    expect(deleteItem?.label).toBe('删除');
    expect(deleteItem?.danger).toBe(true);
    expect(deleteItem?.disabled).toBe(false);

    archiveItem?.run();
    expect(onArchive).toHaveBeenCalledWith(conv, true);

    deleteItem?.run();
    expect(onDelete).toHaveBeenCalledWith(conv);
  });

  it('builds menu items for an archived conversation with unarchive action', () => {
    const conv = makeConv({ archived: true, status: 'idle' });
    const onArchive = vi.fn();

    const items = buildConversationItems({
      lang: 'zh',
      wsId: 'w1',
      conv,
      openConversation: vi.fn(),
      copy: vi.fn(),
      onArchive,
      onDelete: vi.fn(),
    });

    const unarchiveItem = items.find((it) => it.action === 'unarchive');
    expect(unarchiveItem?.label).toBe('取消归档');
    expect(unarchiveItem?.disabled).toBe(false);

    unarchiveItem?.run();
    expect(onArchive).toHaveBeenCalledWith(conv, false);
  });

  it('disables archive and delete when conversation is running', () => {
    const conv = makeConv({ archived: false, status: 'running' });

    const items = buildConversationItems({
      lang: 'zh',
      wsId: 'w1',
      conv,
      openConversation: vi.fn(),
      copy: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn(),
    });

    expect(items.map((it) => it.action ?? 'sep')).toEqual([
      'stop',
      'sep',
      'open',
      'copy-id',
      'sep',
      'archive',
      'delete',
    ]);

    const archiveItem = items.find((it) => it.action === 'archive');
    expect(archiveItem?.disabled).toBe(true);
    expect(archiveItem?.title).toBe('先停止对话');

    const deleteItem = items.find((it) => it.action === 'delete');
    expect(deleteItem?.disabled).toBe(true);
    expect(deleteItem?.title).toBe('先停止对话');
  });

  it('supports English translations', () => {
    const conv = makeConv({ archived: false, status: 'running' });

    const items = buildConversationItems({
      lang: 'en',
      wsId: 'w1',
      conv,
      openConversation: vi.fn(),
      copy: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn(),
    });

    const archiveItem = items.find((it) => it.action === 'archive');
    expect(archiveItem?.label).toBe('Archive');
    expect(archiveItem?.title).toBe('Stop the conversation first');

    const deleteItem = items.find((it) => it.action === 'delete');
    expect(deleteItem?.label).toBe('Delete');
    expect(deleteItem?.title).toBe('Stop the conversation first');
  });
});
