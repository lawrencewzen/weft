/** Holds the requestId for one send/continue attempt so retries stay idempotent. */
export function createSendRequest(generate: () => string = () => crypto.randomUUID()) {
  let id: string | null = null;
  let text: string | null = null;
  return {
    current(): string | null {
      return id;
    },
    begin(nextText: string, extra = ''): string {
      const key = extra ? `${nextText}\n${extra}` : nextText;
      if (id && text === key) return id;
      id = generate();
      text = key;
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
