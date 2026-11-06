// Recognize legacy auto-continue user messages. Continuation of a cut-off
// answer is Pi Durable's continue submission, not a host-written user message.
export {
  AUTO_CONTINUE_PREFIX,
  isAutoContinueText,
  isPromptUserMessage,
} from './continuation-text.mjs';
