/**
 * MCP Key Service client (https://mcpkeys.techmavie.digital).
 *
 * Hosted users store their Forgejo instance URL and access token once in the
 * key portal and get a personal key like `usr_0123...`. This module swaps that
 * usr_ key for the real credentials by calling /internal/resolve.
 *
 * Key-service contract (mcp-key-service/src/server.ts):
 *   POST KEY_SERVICE_URL   Authorization: Bearer KEY_SERVICE_TOKEN
 *   body { key: "usr_...", server_id: "forgejo" }
 *   200 { valid: true, credentials: { forgejo_url, forgejo_token }, label, connector_id }
 *   401 → the user's key is invalid, revoked or suspended        → invalid_key
 *   403 → THIS server's token is wrong / server_id mismatch       → service_unavailable (our misconfiguration)
 *   404 → KEY_SERVICE_URL has the wrong path                      → service_unavailable (logged)
 *   5xx, timeout, network error                                   → service_unavailable
 *   non-JSON or missing url/token                                 → malformed_response
 *
 * Successful lookups are cached for 60s, rejected keys for 10s, and concurrent
 * lookups for the same key share one request. (Same design as mcp-zerobounce.)
 */

import { createHash } from 'node:crypto';
import { maskKey } from './security.js';

export interface ResolvedCredentials {
  /** Forgejo instance base URL exactly as saved in the portal (normalised later). */
  url: string;
  token: string;
}

export type ResolveFailureReason = 'invalid_key' | 'service_unavailable' | 'malformed_response';

export type ResolveResult = { ok: true; credentials: ResolvedCredentials } | { ok: false; reason: ResolveFailureReason };

export const DEFAULT_SERVER_ID = 'forgejo';

const CACHE_TTL_MS = 60_000;
const NEGATIVE_CACHE_TTL_MS = 10_000;
const MAX_NEGATIVE_ENTRIES = 10_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

/** Field names accepted for each credential (the connector uses the first one). */
const URL_FIELDS = ['forgejo_url', 'url', 'baseUrl', 'base_url', 'host', 'FORGEJO_URL'];
const TOKEN_FIELDS = ['forgejo_token', 'token', 'accessToken', 'access_token', 'FORGEJO_ACCESS_TOKEN'];

export interface KeyServiceConfig {
  url: string;
  token: string;
  serverId?: string;
  fetchImpl?: typeof fetch;
}

function firstString(creds: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = creds[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export class KeyServiceClient {
  private readonly cache = new Map<string, { credentials: ResolvedCredentials; expiresAt: number }>();
  /** Keys recently rejected as invalid → time until which we keep rejecting them locally. */
  private readonly invalid = new Map<string, number>();
  private readonly pending = new Map<string, Promise<ResolveResult>>();
  private readonly fetchImpl: typeof fetch;
  private readonly cleanupTimer: NodeJS.Timeout;
  readonly serverId: string;

  constructor(private readonly config: KeyServiceConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.serverId = config.serverId || DEFAULT_SERVER_ID;
    this.cleanupTimer = setInterval(() => this.sweep(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  get enabled(): boolean {
    return Boolean(this.config.url && this.config.token);
  }

  /** Resolve a usr_ key into Forgejo credentials. */
  async resolve(userKey: string): Promise<ResolveResult> {
    if (!this.enabled) return { ok: false, reason: 'service_unavailable' };

    // Cache by hash so raw user keys are never kept as map keys.
    const cacheKey = createHash('sha256').update(userKey).digest('hex');
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return { ok: true, credentials: cached.credentials };
    const invalidUntil = this.invalid.get(cacheKey);
    if (invalidUntil && Date.now() < invalidUntil) return { ok: false, reason: 'invalid_key' };

    const inflight = this.pending.get(cacheKey);
    if (inflight) return inflight;

    const promise = this.doResolve(userKey, cacheKey);
    this.pending.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(cacheKey);
    }
  }

  /** Used by tests and on shutdown. */
  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.cache.clear();
    this.invalid.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) if (now >= entry.expiresAt) this.cache.delete(key);
    for (const [key, until] of this.invalid) if (now >= until) this.invalid.delete(key);
  }

  /**
   * Briefly remember keys the key service rejected, so a client retrying a bad
   * key (or someone probing random usr_ keys) doesn't hit the key service every time.
   */
  private rememberInvalid(cacheKey: string): ResolveResult {
    if (this.invalid.size >= MAX_NEGATIVE_ENTRIES) this.invalid.clear();
    this.invalid.set(cacheKey, Date.now() + NEGATIVE_CACHE_TTL_MS);
    return { ok: false, reason: 'invalid_key' };
  }

  private async doResolve(userKey: string, cacheKey: string): Promise<ResolveResult> {
    const shortKey = maskKey(userKey);
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: userKey, server_id: this.serverId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      console.error(`Key service ${timedOut ? 'timed out' : 'request failed'} for key ${shortKey}`);
      return { ok: false, reason: 'service_unavailable' };
    }

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text().catch(() => '');
    let body: { valid?: boolean; error?: string; credentials?: Record<string, unknown> } | undefined;
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }

    if (!res.ok) {
      // 401 = the user's key is invalid, revoked or suspended (or not a Forgejo connection).
      if (res.status === 401) return this.rememberInvalid(cacheKey);
      // 404 = KEY_SERVICE_URL points at the wrong path (should end in /internal/resolve).
      if (res.status === 404) {
        console.error('Key service returned 404. Check KEY_SERVICE_URL (expected .../internal/resolve).');
        return { ok: false, reason: 'service_unavailable' };
      }
      // 403 = the key service rejected THIS server (wrong KEY_SERVICE_TOKEN or server_id).
      // That's our configuration problem, not the user's, so don't tell them their key is invalid.
      if (res.status === 403) {
        console.error(`Key service rejected this server's credentials (check KEY_SERVICE_TOKEN): ${body?.error ?? res.status}`);
        return { ok: false, reason: 'service_unavailable' };
      }
      console.error(`Key service returned HTTP ${res.status} for key ${shortKey}`);
      return { ok: false, reason: 'service_unavailable' };
    }

    if (!body) {
      console.error(`Key service returned a non-JSON response (${contentType || 'no content-type'}) for key ${shortKey}`);
      return { ok: false, reason: 'malformed_response' };
    }
    if (body.valid !== true) return this.rememberInvalid(cacheKey);

    const creds = body.credentials ?? {};
    const url = firstString(creds, URL_FIELDS);
    const token = firstString(creds, TOKEN_FIELDS);
    if (!url || !token) {
      // Log field names only, never values.
      console.error(
        `Key service credentials for ${shortKey} are missing ${!url ? 'the instance URL' : 'the token'} ` +
          `(fields: ${Object.keys(creds).join(', ') || 'none'})`,
      );
      return { ok: false, reason: 'malformed_response' };
    }

    const credentials: ResolvedCredentials = { url, token };
    this.cache.set(cacheKey, { credentials, expiresAt: Date.now() + CACHE_TTL_MS });
    return { ok: true, credentials };
  }
}
