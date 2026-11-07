// Read-only skill loader for the main agent. Children never receive this tool.
import { obj, str } from '@earendil-works/pi-schema';
import { defineTool } from '@earendil-works/pi-durable';
import { unknownSkillError } from '../core/skills.mjs';

export const SKILL_TOOL_DESCRIPTION = 'Load the full instructions of a skill listed in the system prompt.';

function reply(text, isError = false) {
  return {
    output: [{ type: 'text', text: String(text ?? '') }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createSkillTool({ loadSkill } = {}) {
  return defineTool({
    name: 'skill',
    description: SKILL_TOOL_DESCRIPTION,
    parameters: obj({
      name: str(),
    }),
    replay: 'safe',
    execute: async (args) => {
      const name = args?.name;
      if (typeof loadSkill !== 'function') {
        return reply(unknownSkillError(name, []), true);
      }
      const result = await loadSkill(name);
      if (result?.error) return reply(result.error, true);
      return reply(result?.body ?? '');
    },
  });
}
