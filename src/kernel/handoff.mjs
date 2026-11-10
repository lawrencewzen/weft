// Handoff to a new context. The tool returns Pi Durable's control.handoff, which
// writes a pi.reset entry and continues the same run. The manual request is an
// input the model sees, stored as weft.handoff-request so the thread does not
// draw it as a user message.
import { obj, str } from '@earendil-works/pi-schema';
import { defineTool } from '@earendil-works/pi-durable';

export const HANDOFF_TOOL_NAME = 'handoff';
/** Custom input entry. Must not start with `pi.`. */
export const HANDOFF_REQUEST_KIND = 'weft.handoff-request';

export const HANDOFF_TOOL_DESCRIPTION = [
  'When the context is nearly full and compaction would not be enough, write a handoff note and call this tool to start a fresh context in the same conversation.',
  'The note is the only memory the next context keeps: the current task, what is already done, what is unfinished, and the next step.',
  'Put the full note in text. The run continues in the new context after this call.',
  '上下文快满、压缩也不够用时，写一份交接说明并调用本工具，开启新上下文。',
].join(' ');

/**
 * Prompt the model sees for a manual handoff. It is not a user bubble.
 * `instructions` is the optional focus; empty means the model decides.
 */
export function handoffRequestText(instructions) {
  const focus = typeof instructions === 'string' ? instructions.trim() : '';
  const lines = [
    '上下文快满了，压缩也不够用。请写一份交接说明，并调用 handoff 工具，把说明全文放在 text 参数里，从而在这个对话里开启新上下文。',
    '交接说明要写清：当前任务、已完成的部分、未完成的部分、下一步。用用户正在使用的语言写。',
  ];
  if (focus) lines.push(`交接说明要侧重这些内容：${focus}`);
  else lines.push('没有额外侧重时，按你对当前任务的判断来写。');
  lines.push('写完并调用工具后，在新上下文里继续把任务做下去。');
  return lines.join('\n');
}

export function createHandoffTool() {
  return defineTool({
    name: HANDOFF_TOOL_NAME,
    description: HANDOFF_TOOL_DESCRIPTION,
    parameters: obj({
      text: str({ description: '交接说明全文。新上下文只从这段文字开始。' }),
    }),
    replay: 'unsafe',
    execute(args) {
      const note = typeof args?.text === 'string' ? args.text.trim() : '';
      if (!note) {
        return {
          output: [{ type: 'text', text: 'handoff requires the handoff note in text' }],
          isError: true,
        };
      }
      return {
        output: [{ type: 'text', text: 'Handed off to a new context.' }],
        control: { handoff: note },
      };
    },
  });
}
