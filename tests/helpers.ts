/**
 * Test helpers: a scriptable fake fetch, a fake Forgejo API router and an
 * in-memory MCP client.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TOOLSETS, type Toolset } from '../src/config.js';
import { clearCapabilitiesCache } from '../src/forgejo/capabilities.js';
import { createForgejoServer, type CreateServerOptions } from '../src/index.js';

export const TEST_INSTANCE = 'https://git.example.com';
export const TEST_TOKEN = 'forgejo-test-token-0123456789';

export interface RecordedRequest {
  url: string;
  method: string;
  /** Path without the /api/v1 prefix, e.g. /repos/a/b */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json?: any;
}

type Responder = (req: RecordedRequest) => Response | Promise<Response>;

function record(input: string | URL | Request, init: RequestInit = {}): RecordedRequest {
  const url = String(input);
  const parsed = new URL(url);
  const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
  const body = typeof init.body === 'string' ? init.body : '';
  let parsedJson: unknown;
  try {
    parsedJson = body ? JSON.parse(body) : undefined;
  } catch {
    parsedJson = undefined;
  }
  return {
    url,
    method: init.method || 'GET',
    path: parsed.pathname.replace(/^\/api\/v1/, ''),
    query: parsed.searchParams,
    headers,
    body,
    json: parsedJson,
  };
}

/** A fetch replacement that records requests and answers from a list of responders (last one repeats). */
export function fakeFetch(...responders: Responder[]) {
  const requests: RecordedRequest[] = [];
  let call = 0;
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const req = record(input, init);
    requests.push(req);
    const responder = responders[Math.min(call, responders.length - 1)];
    call++;
    return responder(req);
  }) as typeof fetch;
  return { fetch: fn, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function text(body: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

/**
 * A fake Forgejo API. Routes are keyed "METHOD /path" (path without /api/v1,
 * no query string). /version and /settings/api have defaults. Unknown routes → 404.
 */
export function fakeForgejo(routes: Record<string, Responder>, options: { version?: string; maxItems?: number } = {}) {
  const requests: RecordedRequest[] = [];
  const all: Record<string, Responder> = {
    'GET /version': () => json({ version: options.version ?? '14.0.3+gitea-1.22.0' }),
    'GET /settings/api': () =>
      json({ max_response_items: options.maxItems ?? 50, default_paging_num: 30, default_git_trees_per_page: 1000, default_max_blob_size: 10485760 }),
    ...routes,
  };
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const req = record(input, init);
    requests.push(req);
    const handler = all[`${req.method} ${decodeURIComponent(req.path)}`] ?? all[`${req.method} ${req.path}`];
    if (!handler) return json({ message: 'The target couldn\'t be found.', url: '' }, 404);
    return handler(req);
  }) as typeof fetch;
  /** Requests other than the capability lookups. */
  const calls = () => requests.filter(r => r.path !== '/version' && r.path !== '/settings/api');
  return { fetch: fn, requests, calls };
}

/** Connect an MCP client to a fresh server over an in-memory transport. All toolsets are enabled by default. */
export async function connect(options: Partial<CreateServerOptions> = {}) {
  clearCapabilitiesCache();
  const server = createForgejoServer({
    credentials: { url: TEST_INSTANCE, token: TEST_TOKEN },
    transport: 'http',
    authMode: 'test',
    toolsets: new Set<Toolset>(TOOLSETS),
    retryDelayMs: 0,
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { text: result.content.map(c => c.text).join('\n'), isError: Boolean(result.isError) };
  }

  return { client, server, call, close: () => client.close() };
}
