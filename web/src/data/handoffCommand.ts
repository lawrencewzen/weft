/** A composer message that should call POST /handoff instead of sending a user bubble. */
export type HandoffCommand = {
  instructions?: string;
};

/**
 * `/handoff` or `/handoff <focus>`. The rest of the line is the handoff focus.
 * Anything else, including `/handofffoo`, is a normal message.
 */
export function handoffCommandOf(text: string): HandoffCommand | null {
  const match = /^\/handoff(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const instructions = match[1]?.trim();
  return instructions ? { instructions } : {};
}
