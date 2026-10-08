/**
 * Minimal Forgejo REST client (fetch-based, no SDK).
 *
 * One ForgejoClient is created per MCP request (see src/index.ts), holding that
 * caller's instance URL and token. Safety rules:
 *   - every request goes through the SSRF-guarded connection pool (ssrf.ts)
 *   - redirects are never followed, so the token can't be forwarded elsewhere
 *   - responses are read with a size cap
 *   - only idempotent GETs are retried (once, on 502/503/504 or a network error);
 *     writes and 429s are never retried
 *   - the token is scrubbed from every error message
 */

import { fetch as undiciFetch } from 'undici';
import type { NetworkPolicy } from '../config.js';
import { SERVER_VERSION } from '../version.js';
import {
  DEFAULT_CAPABILITIES,
  cachedCapabilities,
  meetsVersion,
  parseVersion,
  type InstanceCapabilities,
} from './capabilities.js';
import { ForgejoError, errorFromResponse, scrubSecret } from './errors.js';
import { findBlockedCause, guardedAgent } from './ssrf.js';
import { instanceHost } from './url.js';

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;
export type Query = Record<string, QueryValue>;

export interface ForgejoClientOptions {
  /** Normalised instance base URL (see normalizeInstanceUrl), without /api/v1. */
  baseUrl: string;
  /** Personal access token. Optional: public endpoints work without one. */
  token?: string;
  policy: NetworkPolicy;
  /** Injectable fetch for tests (bypasses the SSRF connection pool). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Appended to 401/403 messages: where the user should update their token. */
  credentialHint?: string;
  /** Delay before the single GET retry (tests set 0). */
  retryDelayMs?: number;
}

export interface RequestOptions {
  query?: Query;
  /** JSON body (objects/arrays are serialised). */
  body?: unknown;
  /** 'json' (default) parses the response; 'text' returns it as a string. */
  responseType?: 'json' | 'text';
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Statuses to return to the caller instead of throwing (e.g. 404 for "does it exist?"). */
  okStatuses?: number[];
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  /** From the X-Total-Count header, when the endpoint sends it. */
  total: number | null;
  hasMore: boolean;
}

export interface ListOptions {
  page?: number;
  limit?: number;
  /** Name of the page-size query parameter (git trees use per_page). */
  limitParam?: string;
  /** Pull the array out of wrapped responses like {ok, data: [...]}. */
  extract?: (body: unknown) => unknown[];
  /** Total from a field in the body (e.g. total_count) when there's no header. */
  totalFrom?: (body: unknown) => number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const RETRY_STATUSES = new Set([502, 503, 504]);
const TLS_ERROR = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Refuse paths with "." / ".." segments (also percent-encoded, e.g. "%2e%2e")
 * or backslashes. The URL parser resolves dot segments, so a branch named ".."
 * in DELETE /repos/o/r/branches/.. would otherwise become DELETE /repos/o/r —
 * deleting the whole repository. Checked here so every tool is covered.
 */
export function assertSafePath(path: string): void {
  for (const segment of path.split('?')[0].split('/')) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // malformed escapes are left to the server to reject
    }
    if (decoded === '.' || decoded === '..' || segment.includes('\\') || decoded.includes('\\')) {
      throw new ForgejoError(
        'validation',
        `Invalid name in the request path: "${decoded}". Names consisting only of "." or "..", or containing backslashes, are not allowed.`,
      );
    }
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export class ForgejoClient {
  readonly baseUrl: string;
  readonly apiBase: string;
  readonly host: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly credentialHint?: string;
  private readonly retryDelayMs: number;

  constructor(options: ForgejoClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiBase = `${options.baseUrl}/api/v1`;
    this.host = instanceHost(options.baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
    this.credentialHint = options.credentialHint;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    const dispatcher = options.fetchImpl ? undefined : guardedAgent(options.policy);
    this.fetchImpl =
      options.fetchImpl ??
      (((url: string, init: RequestInit) => undiciFetch(url, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch);
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  /** Web (HTML) URL for a path on the instance, e.g. webUrl('/owner/repo/issues/1'). */
  webUrl(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  buildUrl(path: string, query?: Query): string {
    const fullPath = path.startsWith('/') ? path : `/${path}`;
    assertSafePath(fullPath);
    const url = new URL(`${this.apiBase}${fullPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach(v => url.searchParams.append(key, String(v)));
      else url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  // ---------------------------------------------------------------------------
  // Core request
  // ---------------------------------------------------------------------------

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept ?? (options.responseType === 'text' ? 'text/plain, */*' : 'application/json'),
      'User-Agent': `mcp-forgejo/${SERVER_VERSION}`,
    };
    if (this.token) headers.Authorization = `token ${this.token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const attempts = method === 'GET' ? 2 : 1;
    let res: Response | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
        });
      } catch (error) {
        const retryable = attempt < attempts && !isTimeout(error) && !findBlockedCause(error) && !TLS_ERROR.test(errorCode(error) ?? '');
        if (retryable) {
          await sleep(this.retryDelayMs);
          continue;
        }
        throw this.transportError(error);
      }
      if (attempt < attempts && RETRY_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        await sleep(this.retryDelayMs);
        continue;
      }
      break;
    }
    if (!res) throw new ForgejoError('network', `Could not reach ${this.host}.`);

    const apiPath = path.split('?')[0];

    // Never follow redirects: the Authorization header must not go to another URL.
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      throw new ForgejoError(
        'redirect',
        `${this.host} redirected ${method} ${apiPath}${location ? ` to ${location}` : ''}. ` +
          'Check the Forgejo instance URL in your connection (https vs http, www, or a sub-path) and update it.',
        res.status,
      );
    }

    if (!res.ok && !(options.okStatuses ?? []).includes(res.status)) {
      const text = await this.readText(res, MAX_ERROR_BODY_BYTES, true).catch(() => '');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep text (HTML error pages are trimmed below)
        if (/^\s*</.test(text)) parsed = '';
      }
      if (res.status === 401 && !this.token) {
        throw new ForgejoError(
          'auth',
          `${method} ${apiPath} needs a Forgejo access token, but none is configured. ` +
            `Create one at ${this.baseUrl}/user/settings/applications.${this.credentialHint ? ` ${this.credentialHint.replace(/^Then update/, 'Then set')}` : ''}`,
          401,
        );
      }
      const error = errorFromResponse(res.status, parsed, {
        method,
        path: apiPath,
        instanceUrl: this.baseUrl,
        credentialHint: this.credentialHint,
        retryAfter: res.headers.get('retry-after'),
      });
      throw new ForgejoError(error.kind, this.scrub(error.message), error.status);
    }

    if (res.status === 204 || res.status === 205 || method === 'HEAD') {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, headers: res.headers, data: null as T };
    }

    const text = await this.readText(res, options.maxBytes ?? this.maxBytes);
    if (options.responseType === 'text') return { status: res.status, headers: res.headers, data: text as T };
    if (!text.trim()) return { status: res.status, headers: res.headers, data: null as T };
    try {
      return { status: res.status, headers: res.headers, data: JSON.parse(text) as T };
    } catch {
      throw new ForgejoError(
        'api_error',
        `${this.host} returned a non-JSON response for ${method} ${apiPath}. ` +
          'Is the instance URL correct, and does it point at a Forgejo (or Gitea) server?',
        res.status,
      );
    }
  }

  async get<T = unknown>(path: string, query?: Query, options: Omit<RequestOptions, 'query'> = {}): Promise<T> {
    return (await this.request<T>('GET', path, { ...options, query })).data;
  }

  async post<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return (await this.request<T>('POST', path, { body, query })).data;
  }

  async put<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return (await this.request<T>('PUT', path, { body, query })).data;
  }

  async patch<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return (await this.request<T>('PATCH', path, { body, query })).data;
  }

  async delete<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return (await this.request<T>('DELETE', path, { body, query })).data;
  }

  /** GET a plain-text resource (diffs, patches, raw files, logs). */
  async getText(path: string, query?: Query, options: Omit<RequestOptions, 'query' | 'responseType'> = {}): Promise<string> {
    return (await this.request<string>('GET', path, { ...options, query, responseType: 'text' })).data;
  }

  /**
   * GET one page of a list endpoint. The page size is capped at the instance's
   * max_response_items (Forgejo silently caps it anyway, which would break paging maths).
   */
  async list<T = unknown>(path: string, query: Query = {}, options: ListOptions = {}): Promise<Page<T>> {
    const caps = await this.capabilities();
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 20), caps.maxResponseItems));
    const res = await this.request<unknown>('GET', path, {
      query: { ...query, page, [options.limitParam ?? 'limit']: limit },
    });
    const items = (options.extract ? options.extract(res.data) : Array.isArray(res.data) ? res.data : []) as T[];
    const header = res.headers.get('x-total-count');
    const headerTotal = header !== null && header !== '' && Number.isFinite(Number(header)) ? Number(header) : undefined;
    const total = headerTotal ?? options.totalFrom?.(res.data) ?? null;
    const linkNext = /rel="next"/.test(res.headers.get('link') ?? '');
    const hasMore = total !== null ? page * limit < total : linkNext || items.length >= limit;
    return { items, page, limit, total, hasMore };
  }

  // ---------------------------------------------------------------------------
  // Instance capabilities
  // ---------------------------------------------------------------------------

  /** Version + paging limits for this instance (cached for 10 minutes per instance). */
  capabilities(): Promise<InstanceCapabilities> {
    return cachedCapabilities(this.baseUrl, async () => {
      const caps: InstanceCapabilities = { ...DEFAULT_CAPABILITIES };
      let complete = true;
      try {
        const v = await this.get<{ version?: string }>('/version');
        caps.version = typeof v?.version === 'string' ? v.version : null;
        caps.parsed = parseVersion(caps.version);
      } catch (error) {
        // Not fatal: tools still work, version gating is just skipped.
        if (error instanceof ForgejoError && ['blocked', 'config', 'redirect'].includes(error.kind)) throw error;
        complete = false;
      }
      try {
        const s = await this.get<Record<string, unknown>>('/settings/api');
        const num = (key: string, fallback: number) => (typeof s?.[key] === 'number' && (s[key] as number) > 0 ? (s[key] as number) : fallback);
        caps.maxResponseItems = num('max_response_items', caps.maxResponseItems);
        caps.defaultPagingNum = num('default_paging_num', caps.defaultPagingNum);
        caps.defaultGitTreesPerPage = num('default_git_trees_per_page', caps.defaultGitTreesPerPage);
        caps.maxBlobSize = num('default_max_blob_size', caps.maxBlobSize);
      } catch {
        complete = false;
      }
      return { caps, complete };
    });
  }

  /** Throw a friendly 'unsupported' error if the instance is older than `min` (e.g. "16.0"). */
  async requireVersion(min: string, what: string): Promise<void> {
    const caps = await this.capabilities();
    if (!meetsVersion(caps, min)) {
      throw new ForgejoError(
        'unsupported',
        `${what} needs Forgejo ${min} or newer, but ${this.host} runs ${caps.version}. Ask the instance admin to upgrade.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private scrub(message: string): string {
    return scrubSecret(message, this.token);
  }

  private transportError(error: unknown): ForgejoError {
    if (error instanceof ForgejoError) return error;
    const blocked = findBlockedCause(error);
    if (blocked) {
      return new ForgejoError(
        'blocked',
        `${this.host} resolves to a private or internal address (${blocked.address}), which this server is not allowed to contact. ` +
          'Use a publicly reachable Forgejo URL.',
      );
    }
    if (isTimeout(error)) {
      return new ForgejoError('timeout', `${this.host} did not respond in time. The instance may be slow or unreachable; try again.`);
    }
    const code = errorCode(error) ?? '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new ForgejoError('network', `Could not resolve ${this.host}. Check the Forgejo instance URL in your connection.`);
    }
    if (code === 'ECONNREFUSED') {
      return new ForgejoError('network', `${this.host} refused the connection. Is the Forgejo instance running and reachable from the internet?`);
    }
    if (TLS_ERROR.test(code)) {
      return new ForgejoError('network', `TLS/certificate problem talking to ${this.host} (${code}). The instance needs a valid HTTPS certificate.`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new ForgejoError('network', `Could not reach ${this.host}: ${this.scrub(detail)}${code ? ` (${code})` : ''}`);
  }

  /** Read a response body as UTF-8 text with a byte cap. */
  private async readText(res: Response, maxBytes: number, truncateInstead = false): Promise<string> {
    try {
      if (!res.body) return await res.text();
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          if (truncateInstead) break;
          throw new ForgejoError(
            'too_large',
            `The response from ${this.host} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. Narrow the request (smaller page, a path filter or a specific file).`,
          );
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf-8');
    } catch (error) {
      throw this.transportError(error);
    }
  }
}
