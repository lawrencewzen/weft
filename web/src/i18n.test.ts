import { describe, expect, it } from 'vitest';
import { t } from './i18n';

describe('i18n empty home and branding', () => {
  it('translates app_name to Weft in both languages', () => {
    expect(t('zh', 'app_name')).toBe('Weft');
    expect(t('en', 'app_name')).toBe('Weft');
  });

  it('provides empty home texts in zh', () => {
    expect(t('zh', 'no_projects')).toBe('还没有项目');
    expect(t('zh', 'no_projects_desc')).toBe('添加一个本地目录或 Git 仓库后就可以开始对话');
    expect(t('zh', 'add_project')).toBe('添加项目');
    expect(t('zh', 'no_project')).toBe('不选项目');
    expect(t('zh', 'chats_label')).toBe('对话');
  });

  it('provides empty home texts in en', () => {
    expect(t('en', 'no_projects')).toBe('No projects yet');
    expect(t('en', 'no_projects_desc')).toBe('Add a local folder or a Git repository to start chatting');
    expect(t('en', 'add_project')).toBe('Add project');
    expect(t('en', 'no_project')).toBe('No project');
    expect(t('en', 'chats_label')).toBe('Chats');
  });
});
