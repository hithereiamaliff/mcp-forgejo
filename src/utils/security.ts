/**
 * Small security helpers: masking secrets in logs, hashing IPs for analytics,
 * and constant-time comparison for API keys.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** "usr_0123456789abcdef..." → "usr_01234567..." (first 12 chars, like the other MCPs). */
export function maskKey(value: string | undefined): string {
  if (!value) return '(none)';
  if (value.length <= 12) return '***';
  return `${value.slice(0, 12)}...`;
}

/** Replace usr_ keys and api_key values in a URL/path so they never reach logs. */
export function sanitizeUrlForLogs(url: string): string {
  // Case-insensitive: Express also serves /MCP/usr_... and ?API_KEY=...
  return url
    .replace(/\/mcp\/[^/?#]+/gi, '/mcp/:userKey')
    .replace(/([?&](?:api_key|apikey)=)[^&]*/gi, '$1***');
}

/** One-way, truncated hash so analytics can count unique clients without storing IPs. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 12);
}

/** Constant-time string comparison (avoids leaking key length/prefix via timing). */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
