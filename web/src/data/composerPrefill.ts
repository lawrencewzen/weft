const prefills = new Map<string, string>();

export function setConversationPrefill(conversationId: string, text: string): void {
  prefills.set(conversationId, text);
}

export function consumeConversationPrefill(conversationId?: string | null): string | null {
  if (!conversationId) return null;
  const val = prefills.get(conversationId);
  if (val !== undefined) {
    prefills.delete(conversationId);
    return val;
  }
  return null;
}

export function clearConversationPrefills(): void {
  prefills.clear();
}
