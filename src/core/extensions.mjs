import { buildSkillPrompt, loadSkillBody, unknownSkillError } from './skills.mjs';
import { pluginHandlers } from './plugins.mjs';
import { log } from './log.mjs';

export function createExtensionHost({ skillDirs = [], pluginDirs = [], getSettings } = {}) {
  async function settings() {
    if (typeof getSettings !== 'function') return { skills: {}, plugins: {} };
    const value = await getSettings();
    return value && typeof value === 'object' ? value : { skills: {}, plugins: {} };
  }

  return {
    async skillPrompt() {
      try {
        const current = await settings();
        return await buildSkillPrompt(skillDirs, current.skills || {});
      } catch (err) {
        log.error('WEFT_EXTENSION', '', err);
        return '';
      }
    },
    async loadSkill(name) {
      try {
        const current = await settings();
        return await loadSkillBody(skillDirs, current.skills || {}, name);
      } catch (err) {
        log.error('WEFT_EXTENSION', '', err);
        return { error: unknownSkillError(name, []) };
      }
    },
    async pluginTools() {
      try {
        const current = await settings();
        return await pluginHandlers(pluginDirs, current.plugins || {});
      } catch (err) {
        log.error('WEFT_EXTENSION', '', err);
        return [];
      }
    },
  };
}
