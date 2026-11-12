/** A composer message that should call POST /compact instead of sending a user bubble. */
export type CompactCommand = {
  instructions?: string;
};

/**
 * `/compact` or `/compact <instructions>`. The rest of the line is the compaction instructions.
 * Anything else, including `/compactfoo`, is a normal message.
 */
export function compactCommandOf(text: string): CompactCommand | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const instructions = match[1]?.trim();
  return instructions ? { instructions } : {};
}
