import { describe, expect, it } from 'vitest';
import { t } from './i18n';

describe('i18n empty home and branding', () => {
  it('translates app_name to Weft in both languages', () => {
    expect(t('zh', 'app_name')).toBe('Weft');
    expect(t('en', 'app_name')).toBe('Weft');
  });

  it('provides no-project chat texts in zh', () => {
    expect(t('zh', 'add_project')).toBe('添加项目');
    expect(t('zh', 'no_project')).toBe('不选项目');
    expect(t('zh', 'chats_label')).toBe('对话');
    expect(t('zh', 'draft_hero_chat')).toBe('想做什么？');
    expect(t('zh', 'draft_hint_chat')).toBe('没有指定项目，可以直接发消息。Agent 会在这个对话自己的目录里工作。');
  });

  it('provides no-project chat texts in en', () => {
    expect(t('en', 'add_project')).toBe('Add project');
    expect(t('en', 'no_project')).toBe('No project');
    expect(t('en', 'chats_label')).toBe('Chats');
    expect(t('en', 'draft_hero_chat')).toBe('What should we do?');
    expect(t('en', 'draft_hint_chat')).toBe('No project selected. Send a message to start. The agent works in this chat’s own folder.');
  });

  it('english unauthenticated copy is English', () => {
    expect(t('en', 'unauthenticated')).toBe('Open the new web UI with weft open');
    expect(t('en', 'unauthenticated')).not.toMatch(/[\u4e00-\u9fff]/);
    expect(t('zh', 'unauthenticated')).toBe('请用 weft open 打开新版网页端');
  });
});
