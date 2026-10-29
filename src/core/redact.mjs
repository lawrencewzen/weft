/** Truncate and strip API keys / JWT-shaped strings from error text. */
export function redactAuthText(text) {
  return String(text ?? '')
    .slice(0, 500)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt-***');
}
