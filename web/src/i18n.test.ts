import { describe, expect, it } from 'vitest';
import { LANGUAGE_NAMES, t } from './i18n';

describe('i18n empty home and branding', () => {
  it('translates app_name to Weft in both languages', () => {
    expect(t('zh', 'app_name')).toBe('Weft');
    expect(t('en', 'app_name')).toBe('Weft');
  });

  it('provides no-project chat texts in zh', () => {
    expect(t('zh', 'add_project')).toBe('添加项目');
    expect(t('zh', 'no_project')).toBe('不选项目');
    expect(t('zh', 'ws_chip_choose')).toBe('选择项目');
    expect(t('zh', 'ws_chip_no_projects')).toBe('还没有项目');
    expect(t('zh', 'ws_chip_add_project')).toBe('添加项目…');
    expect(t('zh', 'chats_label')).toBe('对话');
    expect(t('zh', 'draft_hero_chat')).toBe('想做什么？');
  });

  it('provides no-project chat texts in en', () => {
    expect(t('en', 'add_project')).toBe('Add project');
    expect(t('en', 'no_project')).toBe('No project');
    expect(t('en', 'ws_chip_choose')).toBe('Choose project');
    expect(t('en', 'ws_chip_no_projects')).toBe('No projects yet');
    expect(t('en', 'ws_chip_add_project')).toBe('Add project…');
    expect(t('en', 'chats_label')).toBe('Chats');
    expect(t('en', 'draft_hero_chat')).toBe('What should we do?');
  });

  it('language option labels are autonyms in both UI languages', () => {
    expect(LANGUAGE_NAMES.zh).toBe('中文');
    expect(LANGUAGE_NAMES.en).toBe('English');
  });

  it('provides change status copy in zh and en', () => {
    expect(t('zh', 'change_status_added')).toBe('新增');
    expect(t('zh', 'change_status_modified')).toBe('修改');
    expect(t('zh', 'change_status_deleted')).toBe('删除');
    expect(t('zh', 'change_status_renamed')).toBe('重命名');
    expect(t('zh', 'diff_renamed_only')).toBe('仅重命名');

    expect(t('en', 'change_status_added')).toBe('Added');
    expect(t('en', 'change_status_modified')).toBe('Modified');
    expect(t('en', 'change_status_deleted')).toBe('Deleted');
    expect(t('en', 'change_status_renamed')).toBe('Renamed');
    expect(t('en', 'diff_renamed_only')).toBe('Renamed only');
    expect(t('en', 'diff_renamed_only')).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('english unauthenticated copy is English', () => {
    expect(t('en', 'unauthenticated')).toBe('Open the new web UI with weft open');
    expect(t('en', 'unauthenticated')).not.toMatch(/[\u4e00-\u9fff]/);
    expect(t('zh', 'unauthenticated')).toBe('请用 weft open 打开新版网页端');
  });
});
