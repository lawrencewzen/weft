const SK = /sk-[A-Za-z0-9_-]{6,}/g;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTH_HEADER = /(\bauthorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s,;"'}]+/gi;
const KEY_VALUE = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret)(["']?\s*[=:]\s*["']?)[^\s&,;"'}]+/gi;
const URL_USERINFO = /(:\/\/)[^/\s@]+@/g;

/** Strip credentials from free text without truncating it. Used for every log line. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(URL_USERINFO, '$1***@')
    .replace(AUTH_HEADER, '$1***')
    .replace(BEARER, 'Bearer ***')
    .replace(KEY_VALUE, '$1$2***')
    .replace(SK, 'sk-***')
    .replace(JWT, 'jwt-***');
}

/** Truncate and strip API keys / JWT-shaped strings from error text. */
export function redactAuthText(text) {
  return redactSecrets(String(text ?? '').slice(0, 500));
}
