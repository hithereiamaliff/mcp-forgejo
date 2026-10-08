/**
 * HTTP integration tests: starts the real http-server with a fake key service
 * and a fake Forgejo instance, and checks every auth path, toolset selection,
 * read-only mode and the operational endpoints.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseToolsets } from '../src/config.js';
import { ALL_TOOLS, selectTools } from '../src/index.js';

const VALID_USER_KEY = 'usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REVOKED_USER_KEY = 'usr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const INCOMPLETE_USER_KEY = 'usr_cccccccccccccccccccccccccccccccc';
const MCP_API_KEY = 'test-mcp-api-key';
const SERVER_TOKEN = 'internal-token';
const FORGEJO_TOKEN = 'forgejo-token-from-portal';

let keyService: http.Server;
let forgejo: http.Server;
let mcp: ChildProcess;
let baseUrl = '';
let forgejoUrl = '';
let keyServiceCalls = 0;
const forgejoAuthHeaders: string[] = [];

const DEFAULT_COUNT = selectTools(parseToolsets(undefined), false).length;
const ALL_COUNT = ALL_TOOLS.length;
const READ_ONLY_DEFAULT_COUNT = selectTools(parseToolsets(undefined), true).length;

before(async () => {
  // Fake Forgejo instance (just enough for forgejo_hello).
  forgejo = http.createServer((req, res) => {
    forgejoAuthHeaders.push(String(req.headers.authorization ?? ''));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/version') return res.end(JSON.stringify({ version: '15.0.9+gitea-1.22.0' }));
    if (req.url === '/api/v1/settings/api') return res.end(JSON.stringify({ max_response_items: 50 }));
    if (req.url === '/api/v1/user') return res.end(JSON.stringify({ login: 'portal-user' }));
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise<void>(resolve => forgejo.listen(0, '127.0.0.1', resolve));
  forgejoUrl = `http://127.0.0.1:${(forgejo.address() as AddressInfo).port}`;

  // Fake mcp-key-service implementing the real /internal/resolve contract.
  keyService = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      keyServiceCalls++;
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${SERVER_TOKEN}`) {
        res.statusCode = 403;
        res.end(JSON.stringify({ valid: false, error: 'Unauthorized' }));
        return;
      }
      const { key, server_id } = JSON.parse(body);
      assert.equal(server_id, 'forgejo');
      if (key === VALID_USER_KEY) {
        res.end(JSON.stringify({ valid: true, credentials: { forgejo_url: forgejoUrl, forgejo_token: FORGEJO_TOKEN }, connector_id: 'forgejo' }));
      } else if (key === INCOMPLETE_USER_KEY) {
        res.end(JSON.stringify({ valid: true, credentials: { forgejo_url: forgejoUrl } }));
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ valid: false, error: 'Invalid, revoked, or suspended API key, or server not authorized' }));
      }
    });
  });
  await new Promise<void>(resolve => keyService.listen(0, '127.0.0.1', resolve));
  const ksPort = (keyService.address() as AddressInfo).port;

  const port = 20000 + Math.floor(Math.random() * 20000);
  baseUrl = `http://127.0.0.1:${port}`;
  mcp = spawn(process.execPath, ['--import', 'tsx', path.join('src', 'http-server.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      MCP_API_KEY,
      KEY_SERVICE_URL: `http://127.0.0.1:${ksPort}/internal/resolve`,
      KEY_SERVICE_TOKEN: SERVER_TOKEN,
      ANALYTICS_DIR: mkdtempSync(path.join(tmpdir(), 'forgejo-analytics-')),
      PUBLIC_BASE_PATH: '/forgejo',
      // The fake Forgejo runs on http://127.0.0.1, which the SSRF guard would refuse.
      FORGEJO_ALLOW_PRIVATE_HOSTS: 'true',
      FORGEJO_ALLOW_HTTP: 'true',
      FORGEJO_URL: '',
      FORGEJO_ACCESS_TOKEN: '',
      FORGEJO_TOOLSETS: '',
      FORGEJO_READ_ONLY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('http-server did not start');
});

after(async () => {
  mcp?.kill();
  await new Promise<void>(resolve => keyService.close(() => resolve()));
  await new Promise<void>(resolve => forgejo.close(() => resolve()));
});

function rpc(method: string, params: Record<string, unknown> = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
}

async function post(urlPath: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body,
  });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

const hello = rpc('tools/call', { name: 'forgejo_hello', arguments: {} });

test('health, root and server card are public', async () => {
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(health.status, 'healthy');
  assert.equal(health.keyService, 'configured');
  const card = await (await fetch(`${baseUrl}/.well-known/mcp/server-card.json`)).json();
  assert.equal(card.transport.endpoint, '/forgejo/mcp');
  assert.equal(card.tools.length, ALL_COUNT);
  assert.ok(card.tools.every((t: { name: string; toolset: string }) => t.name.startsWith('forgejo_') && t.toolset));
  assert.equal(card.tools.filter((t: { defaultEnabled: boolean }) => t.defaultEnabled).length, DEFAULT_COUNT);
  const root = await (await fetch(`${baseUrl}/`)).json();
  assert.equal(root.endpoints.mcp, '/forgejo/mcp/{usr_key}');
});

test('hosted path key: default toolsets, and hello talks to the user\'s instance with their token', async () => {
  const list = await post(`/mcp/${VALID_USER_KEY}`, rpc('tools/list'));
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.result.tools.length, DEFAULT_COUNT);
  assert.equal(DEFAULT_COUNT, 55);

  forgejoAuthHeaders.length = 0;
  const res = await post(`/mcp/${VALID_USER_KEY}`, hello);
  assert.equal(res.status, 200, res.text);
  const text = res.json.result.content[0].text;
  assert.match(text, /hosted \(mcp-key-service\)/);
  assert.match(text, /15\.0\.9/);
  assert.match(text, /portal-user/);
  assert.ok(forgejoAuthHeaders.includes(`token ${FORGEJO_TOKEN}`));
});

test('toolsets and read-only mode can be chosen per request (query or headers)', async () => {
  const all = await post(`/mcp/${VALID_USER_KEY}?toolsets=all`, rpc('tools/list'));
  assert.equal(all.json.result.tools.length, ALL_COUNT);

  const readOnly = await post(`/mcp/${VALID_USER_KEY}?read_only=true`, rpc('tools/list'));
  assert.equal(readOnly.json.result.tools.length, READ_ONLY_DEFAULT_COUNT);
  assert.ok(readOnly.json.result.tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint));

  const headers = await post(`/mcp/${VALID_USER_KEY}`, rpc('tools/list'), { 'X-Forgejo-Toolsets': 'issues', 'X-Forgejo-Read-Only': 'true' });
  const names = headers.json.result.tools.map((t: { name: string }) => t.name);
  assert.ok(names.includes('forgejo_list_issues') && names.includes('forgejo_hello'));
  assert.ok(!names.includes('forgejo_create_issue') && !names.includes('forgejo_list_repos'));

  const bad = await post(`/mcp/${VALID_USER_KEY}?toolsets=issues,bogus`, rpc('tools/list'));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.data.reason, 'invalid_toolsets');
  assert.match(bad.json.error.message, /bogus/);
});

test('hosted key via query, Bearer header or X-API-Key header', async () => {
  assert.equal((await post(`/mcp?api_key=${VALID_USER_KEY}`, rpc('tools/list'))).status, 200);
  assert.equal((await post('/mcp', rpc('tools/list'), { Authorization: `Bearer ${VALID_USER_KEY}` })).status, 200);
  assert.equal((await post('/mcp', rpc('tools/list'), { 'X-API-Key': VALID_USER_KEY })).status, 200);
  assert.equal((await post('/mcp', rpc('tools/list'), { Authorization: `Bearer ${REVOKED_USER_KEY}` })).status, 403);
});

test('revoked keys are 403; incomplete portal credentials are 502 with a fix', async () => {
  const revoked = await post(`/mcp/${REVOKED_USER_KEY}`, rpc('tools/list'));
  assert.equal(revoked.status, 403);
  assert.equal(revoked.json.error.data.reason, 'invalid_key');
  assert.match(revoked.json.error.message, /mcpkeys\.techmavie\.digital/);
  const incomplete = await post(`/mcp/${INCOMPLETE_USER_KEY}`, rpc('tools/list'));
  assert.equal(incomplete.status, 502);
  assert.match(incomplete.json.error.message, /Re-save your Forgejo connection/);
});

test('raw tokens in the URL and non-usr path keys are refused without calling the key service', async () => {
  const before = keyServiceCalls;
  const raw = await post('/mcp?api_key=raw-forgejo-token', rpc('tools/list'));
  assert.equal(raw.status, 400);
  assert.equal(raw.json.error.data.reason, 'raw_key_not_supported');
  assert.equal((await post('/mcp/not-a-user-key', rpc('tools/list'))).status, 401);
  assert.equal(keyServiceCalls, before);
  const none = await post('/mcp', rpc('tools/list'));
  assert.equal(none.status, 401);
  assert.equal(none.json.error.data.reason, 'missing_auth');
});

test('self-hosted mode needs MCP_API_KEY plus the Forgejo URL and token headers', async () => {
  const wrong = await post('/mcp', rpc('tools/list'), { 'X-API-Key': 'nope', 'X-Forgejo-Url': forgejoUrl, 'X-Forgejo-Token': 't' });
  assert.equal(wrong.status, 401);
  const missing = await post('/mcp', rpc('tools/list'), { 'X-API-Key': MCP_API_KEY });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.data.reason, 'missing_config');

  forgejoAuthHeaders.length = 0;
  const ok = await post('/mcp', hello, { 'X-API-Key': MCP_API_KEY, 'X-Forgejo-Url': forgejoUrl, 'X-Forgejo-Token': 'self-token' });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.json.result.content[0].text, /self-hosted/);
  assert.ok(forgejoAuthHeaders.includes('token self-token'));
});

test('clients that send a minimal Accept header still work', async () => {
  const res = await post(`/mcp/${VALID_USER_KEY}`, rpc('tools/list'), { accept: 'application/json' });
  assert.equal(res.status, 200, res.text);
});

test('GET and DELETE on /mcp return 405 (stateless server)', async () => {
  assert.equal((await fetch(`${baseUrl}/mcp/${VALID_USER_KEY}`)).status, 405);
  assert.equal((await fetch(`${baseUrl}/mcp`, { method: 'DELETE' })).status, 405);
});

test('analytics needs the MCP_API_KEY and never contains user keys or raw paths', async () => {
  const upper = await post(`/MCP/${VALID_USER_KEY}`, rpc('tools/list'));
  assert.equal(upper.status, 200, upper.text);
  await fetch(`${baseUrl}/sse/usr_typo_key_should_not_be_stored`);
  await fetch(`${baseUrl}/wp-login.php`);

  assert.equal((await fetch(`${baseUrl}/analytics`)).status, 401);
  const res = await fetch(`${baseUrl}/analytics`, { headers: { 'X-API-Key': MCP_API_KEY } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes('usr_'), 'analytics must not contain usr_ keys');
  assert.ok(!body.includes('wp-login'), 'unknown paths must not be stored verbatim');
  assert.ok(body.includes('/mcp/:userKey'));
  assert.ok(body.includes('forgejo_hello'), 'tool calls are counted');
  assert.equal((await fetch(`${baseUrl}/analytics/dashboard`)).status, 200);
});

test('OAuth discovery and unknown routes return JSON 404s; invalid JSON is a parse error', async () => {
  const oauth = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/forgejo/mcp`);
  assert.equal(oauth.status, 404);
  assert.equal((await oauth.json()).error, 'oauth_metadata_not_supported');
  assert.equal((await fetch(`${baseUrl}/nope`)).status, 404);
  const parse = await post(`/mcp/${VALID_USER_KEY}`, '{not json');
  assert.equal(parse.status, 400);
  assert.equal(parse.json.error.code, -32700);
});
