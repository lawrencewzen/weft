import { ASK_WAITING_TEXT, validateAskArgs } from '../../src/kernel/ask.mjs';

export async function ask_user_question(args) {
  const checked = validateAskArgs(args);
  if (!checked.ok) return { output: checked.error, status: 'error' };
  return {
    output: ASK_WAITING_TEXT,
    status: 'completed',
    details: { questions: checked.questions },
    terminate: true,
  };
}
