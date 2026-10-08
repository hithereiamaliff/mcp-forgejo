/**
 * Forgejo errors, turned into short, actionable messages for the model.
 *
 * Tools throw ForgejoError; src/tools/shared.ts turns it into an `isError`
 * tool result. Stack traces and tokens never reach the client.
 */

export type ForgejoErrorKind =
  | 'auth' // 401: token missing, expired or revoked
  | 'scope' // 403: token lacks a scope
  | 'forbidden' // 403: no permission
  | 'not_found' // 404
  | 'not_allowed' // 405: action disabled / not possible right now
  | 'conflict' // 409
  | 'validation' // 400 / 422
  | 'rate_limited' // 429
  | 'server' // 5xx
  | 'timeout'
  | 'network'
  | 'redirect' // 3xx (never followed: the token must not travel to another URL)
  | 'blocked' // SSRF guard refused the address
  | 'too_large' // response bigger than the configured cap
  | 'unsupported' // instance version too old for this tool
  | 'config' // missing/invalid connection settings
  | 'api_error'; // anything else

export class ForgejoError extends Error {
  constructor(
    public readonly kind: ForgejoErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ForgejoError';
  }
}

/** Remove a secret from a message (e.g. if an upstream error echoes the token). */
export function scrubSecret(message: string, secret: string | undefined): string {
  if (!secret || secret.length < 6) return message;
  return message.split(secret).join('***');
}

/** Pull a human message out of Forgejo's error bodies: {message, errors?, url?}. */
export function extractApiMessage(body: unknown): string {
  if (typeof body === 'string') return body.trim().slice(0, 500);
  if (!body || typeof body !== 'object') return '';
  const obj = body as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj.message === 'string' && obj.message.trim()) parts.push(obj.message.trim());
  if (Array.isArray(obj.errors)) {
    const errs = obj.errors.filter((e): e is string => typeof e === 'string' && e.trim() !== '');
    if (errs.length) parts.push(errs.join('; '));
  }
  if (!parts.length && typeof obj.error === 'string') parts.push(obj.error);
  return parts.join(' — ').slice(0, 500);
}

/** "token does not have at least one of required scope(s): [read:user]" → ["read:user"] */
export function parseMissingScopes(message: string): string[] {
  const match = /required scope\(s\):\s*\[([^\]]*)\]/i.exec(message);
  if (!match) return [];
  return match[1]
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Messages Forgejo uses for "nothing here" that add no information. */
const GENERIC_NOT_FOUND = /^(not found|the target couldn't be found\.?|404 page not found)$/i;

export interface ErrorContext {
  method: string;
  /** API path without the /api/v1 prefix, e.g. /repos/a/b/issues/1 */
  path: string;
  instanceUrl: string;
  /** What the user should update when the token is wrong (depends on how they connected). */
  credentialHint?: string;
  retryAfter?: string | null;
}

/** Build a ForgejoError from an HTTP status and (parsed) error body. */
export function errorFromResponse(status: number, body: unknown, ctx: ErrorContext): ForgejoError {
  const apiMessage = extractApiMessage(body);
  const where = `${ctx.method} ${ctx.path}`;
  const tokenPage = `${ctx.instanceUrl}/user/settings/applications`;
  const hint = ctx.credentialHint ? ` ${ctx.credentialHint}` : '';

  switch (true) {
    case status === 401:
      return new ForgejoError(
        'auth',
        `Forgejo rejected the access token (HTTP 401). It may be expired, revoked or mistyped. ` +
          `Create a new token at ${tokenPage}.${hint}`,
        status,
      );
    case status === 403: {
      const scopes = parseMissingScopes(apiMessage);
      if (scopes.length) {
        return new ForgejoError(
          'scope',
          `Your Forgejo token is missing the scope(s) ${scopes.join(', ')} needed for ${where}. ` +
            `Create a token that includes ${scopes.join(' and ')} at ${tokenPage}.${hint}`,
          status,
        );
      }
      return new ForgejoError(
        'forbidden',
        `Forbidden (HTTP 403) for ${where}${apiMessage ? `: ${apiMessage}` : ''}. ` +
          'Your account may not have permission for this action, or the token is limited to specific repositories.',
        status,
      );
    }
    case status === 404:
      return new ForgejoError(
        'not_found',
        `Not found (HTTP 404): ${where}.` +
          (apiMessage && !GENERIC_NOT_FOUND.test(apiMessage) ? ` ${apiMessage}.` : '') +
          ' Check the owner, repository, number or name. Private resources your token cannot see also return 404.',
        status,
      );
    case status === 405:
      return new ForgejoError(
        'not_allowed',
        `Forgejo refused ${where} (HTTP 405)${apiMessage ? `: ${apiMessage}` : ''}. ` +
          'The action may be disabled for this repository or not possible in its current state.',
        status,
      );
    case status === 409:
      return new ForgejoError('conflict', `Conflict (HTTP 409) for ${where}${apiMessage ? `: ${apiMessage}` : ''}.`, status);
    case status === 400 || status === 422:
      return new ForgejoError(
        'validation',
        `Forgejo rejected the request (HTTP ${status}) for ${where}${apiMessage ? `: ${apiMessage}` : ''}.`,
        status,
      );
    case status === 413:
      return new ForgejoError('validation', `The request is too large for this Forgejo instance (HTTP 413): ${where}.`, status);
    case status === 429:
      return new ForgejoError(
        'rate_limited',
        `The Forgejo instance is rate-limiting requests (HTTP 429)` +
          (ctx.retryAfter ? `; retry after ${ctx.retryAfter} seconds` : '; wait a little before retrying') +
          '.',
        status,
      );
    case status >= 500:
      return new ForgejoError(
        'server',
        `The Forgejo instance returned a server error (HTTP ${status}) for ${where}${apiMessage ? `: ${apiMessage}` : ''}. Try again shortly.`,
        status,
      );
    default:
      return new ForgejoError(
        'api_error',
        `Forgejo returned HTTP ${status} for ${where}${apiMessage ? `: ${apiMessage}` : ''}.`,
        status,
      );
  }
}
