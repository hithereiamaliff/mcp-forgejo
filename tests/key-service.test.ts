/**
 * Key-service client tests: status mapping, credential field mapping, caching, de-duplication.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyServiceClient, DEFAULT_SERVER_ID } from '../src/utils/key-service.js';
import { fakeFetch, json, text } from './helpers.js';

const USER_KEY = 'usr_0123456789abcdef0123456789abcdef';
const CREDS = { forgejo_url: 'https://git.example.com', forgejo_token: 'tok' };

function service(fetchImpl: typeof fetch, serverId?: string) {
  return new KeyServiceClient({ url: 'http://key-service/internal/resolve', token: 'server-token', serverId, fetchImpl });
}

test('a valid key resolves to url + token, sending bearer token and server_id', async () => {
  const f = fakeFetch(() => json({ valid: true, credentials: CREDS, label: 'x', connector_id: 'forgejo' }));
  const ks = service(f.fetch);
  assert.deepEqual(await ks.resolve(USER_KEY), { ok: true, credentials: { url: 'https://git.example.com', token: 'tok' } });
  assert.equal(f.requests[0].headers.authorization, 'Bearer server-token');
  assert.deepEqual(JSON.parse(f.requests[0].body), { key: USER_KEY, server_id: DEFAULT_SERVER_ID });
  assert.equal(DEFAULT_SERVER_ID, 'forgejo');
  ks.dispose();
});

test('alternative credential field names are accepted; server_id is configurable', async () => {
  const f = fakeFetch(() => json({ valid: true, credentials: { url: ' https://codeberg.org ', token: ' t2 ' } }));
  const ks = service(f.fetch, 'forgejo-staging');
  assert.deepEqual(await ks.resolve(USER_KEY), { ok: true, credentials: { url: 'https://codeberg.org', token: 't2' } });
  assert.equal(JSON.parse(f.requests[0].body).server_id, 'forgejo-staging');
  ks.dispose();
});

test('401 from the key service means the user key is invalid', async () => {
  const ks = service(fakeFetch(() => json({ valid: false, error: 'Invalid' }, 401)).fetch);
  assert.deepEqual(await ks.resolve(USER_KEY), { ok: false, reason: 'invalid_key' });
  ks.dispose();
});

test('403 from the key service is OUR misconfiguration, not an invalid user key', async () => {
  const ks = service(fakeFetch(() => json({ valid: false, error: 'Unauthorized' }, 403)).fetch);
  assert.deepEqual(await ks.resolve(USER_KEY), { ok: false, reason: 'service_unavailable' });
  ks.dispose();
});

test('5xx, 404, network errors and bad responses are handled', async () => {
  const cases: Array<[() => Response, string]> = [
    [() => json({ valid: false }, 503), 'service_unavailable'],
    [() => text('Not Found', 404, 'text/html'), 'service_unavailable'],
    [() => text('<html>proxy error</html>', 200, 'text/html'), 'malformed_response'],
    [() => json({ valid: true, credentials: { forgejo_url: 'https://x' } }), 'malformed_response'],
    [() => json({ valid: true, credentials: { forgejo_token: 't' } }), 'malformed_response'],
  ];
  for (const [responder, reason] of cases) {
    const ks = service(fakeFetch(responder).fetch);
    assert.deepEqual(await ks.resolve(USER_KEY), { ok: false, reason });
    ks.dispose();
  }
  const offline = service(
    fakeFetch(() => {
      throw new TypeError('fetch failed');
    }).fetch,
  );
  assert.deepEqual(await offline.resolve(USER_KEY), { ok: false, reason: 'service_unavailable' });
  offline.dispose();
});

test('successful lookups are cached and concurrent lookups share one request', async () => {
  const f = fakeFetch(async () => {
    await new Promise(r => setTimeout(r, 20));
    return json({ valid: true, credentials: CREDS });
  });
  const ks = service(f.fetch);
  const [a, b] = await Promise.all([ks.resolve(USER_KEY), ks.resolve(USER_KEY)]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(f.requests.length, 1);
  await ks.resolve(USER_KEY);
  assert.equal(f.requests.length, 1, 'third call should be served from cache');
  ks.dispose();
});

test('service failures are not cached; rejected keys are remembered briefly', async () => {
  const f = fakeFetch(() => json({ valid: false }, 503), () => json({ valid: true, credentials: CREDS }));
  const ks = service(f.fetch);
  assert.equal((await ks.resolve(USER_KEY)).ok, false);
  assert.equal((await ks.resolve(USER_KEY)).ok, true);
  ks.dispose();

  const bad = fakeFetch(() => json({ valid: false }, 401));
  const ks2 = service(bad.fetch);
  await ks2.resolve(USER_KEY);
  await ks2.resolve(USER_KEY);
  assert.equal(bad.requests.length, 1);
  ks2.dispose();
});
