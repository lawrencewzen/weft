/** Holds the requestId for one send/continue attempt so retries stay idempotent. */
export function createSendRequest(generate: () => string = () => crypto.randomUUID()) {
  let id: string | null = null;
  let text: string | null = null;
  return {
    current(): string | null {
      return id;
    },
    begin(nextText: string): string {
      if (id && text === nextText) return id;
      id = generate();
      text = nextText;
      return id;
    },
    succeed(): void {
      id = null;
      text = null;
    },
  };
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
