/**
 * ForgejoClient: auth header, query building, pagination, retries, redirects,
 * error mapping and token scrubbing.
 */

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIVE_POLICY } from '../src/config.js';
import { clearCapabilitiesCache } from '../src/forgejo/capabilities.js';
import { ForgejoClient } from '../src/forgejo/client.js';
import { ForgejoError } from '../src/forgejo/errors.js';
import { fakeFetch, fakeForgejo, json, text, TEST_INSTANCE, TEST_TOKEN } from './helpers.js';

beforeEach(() => clearCapabilitiesCache());

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof ForgejoClient>[0]> = {}) {
  return new ForgejoClient({ baseUrl: TEST_INSTANCE, token: TEST_TOKEN, policy: PERMISSIVE_POLICY, fetchImpl, retryDelayMs: 0, ...extra });
}

test('sends the token header, JSON body and query parameters', async () => {
  const f = fakeFetch(() => json({ number: 1 }, 201));
  const result = await client(f.fetch).post('/repos/o/r/issues', { title: 'x' }, { a: 1, skip: undefined, list: ['p', 'q'] });
  assert.deepEqual(result, { number: 1 });
  const req = f.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, `token ${TEST_TOKEN}`);
  assert.equal(req.headers['content-type'], 'application/json');
  assert.match(req.headers['user-agent'], /^mcp-forgejo\//);
  assert.deepEqual(req.json, { title: 'x' });
  assert.equal(req.url, `${TEST_INSTANCE}/api/v1/repos/o/r/issues?a=1&list=p&list=q`);
});

test('no Authorization header without a token', async () => {
  const f = fakeFetch(() => json({}));
  await client(f.fetch, { token: undefined }).get('/version');
  assert.equal(f.requests[0].headers.authorization, undefined);
});

test('list() caps the page size at the instance limit and reads X-Total-Count', async () => {
  const f = fakeForgejo(
    { 'GET /repos/o/r/issues': req => json(Array.from({ length: Number(req.query.get('limit')) }, (_, i) => ({ number: i })), 200, { 'x-total-count': '97' }) },
    { maxItems: 25 },
  );
  const page = await client(f.fetch).list('/repos/o/r/issues', { state: 'open' }, { page: 2, limit: 100 });
  assert.equal(page.limit, 25);
  assert.equal(page.items.length, 25);
  assert.equal(page.total, 97);
  assert.equal(page.hasMore, true);
  const call = f.calls()[0];
  assert.equal(call.query.get('page'), '2');
  assert.equal(call.query.get('limit'), '25');
  assert.equal(call.query.get('state'), 'open');
});

test('list() without a total uses the Link header / page fullness', async () => {
  const f = fakeForgejo({ 'GET /x': () => json([1, 2]) });
  const page = await client(f.fetch).list('/x', {}, { limit: 5 });
  assert.equal(page.total, null);
  assert.equal(page.hasMore, false);
  const g = fakeForgejo({ 'GET /x': () => json({ ok: true, data: [1, 2] }, 200, { link: '<x?page=2>; rel="next"' }) });
  const wrapped = await client(g.fetch).list('/x', {}, { limit: 5, extract: b => (b as { data: unknown[] }).data });
  assert.deepEqual(wrapped.items, [1, 2]);
  assert.equal(wrapped.hasMore, true);
});

test('GETs are retried once on 502/503/504; writes and 429 are never retried', async () => {
  const flaky = fakeFetch(() => json({}, 503), () => json({ ok: 1 }));
  assert.deepEqual(await client(flaky.fetch).get('/x'), { ok: 1 });
  assert.equal(flaky.requests.length, 2);

  const write = fakeFetch(() => json({}, 503), () => json({ ok: 1 }));
  await assert.rejects(client(write.fetch).post('/x', {}), (e: ForgejoError) => e.kind === 'server');
  assert.equal(write.requests.length, 1);

  const limited = fakeFetch(() => json({ message: 'slow down' }, 429, { 'retry-after': '12' }));
  await assert.rejects(client(limited.fetch).get('/x'), (e: ForgejoError) => e.kind === 'rate_limited' && /12 seconds/.test(e.message));
  assert.equal(limited.requests.length, 1);

  const network = fakeFetch(
    () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    },
    () => json({ ok: 2 }),
  );
  assert.deepEqual(await client(network.fetch).get('/x'), { ok: 2 });
});

test('redirects are never followed', async () => {
  const f = fakeFetch(() => new Response(null, { status: 301, headers: { location: 'https://evil.example/api/v1/user' } }));
  await assert.rejects(client(f.fetch).get('/user'), (e: ForgejoError) => {
    assert.equal(e.kind, 'redirect');
    assert.match(e.message, /evil\.example/);
    return true;
  });
  assert.equal(f.requests.length, 1);
});

test('errors are mapped and never contain the token', async () => {
  const echo = fakeFetch(() => json({ message: `bad token ${TEST_TOKEN}` }, 422));
  await assert.rejects(client(echo.fetch).post('/x', {}), (e: ForgejoError) => {
    assert.equal(e.kind, 'validation');
    assert.ok(!e.message.includes(TEST_TOKEN));
    return true;
  });

  const html = fakeFetch(() => text('<html>login page</html>', 200, 'text/html'));
  await assert.rejects(client(html.fetch).get('/user'), /non-JSON response/);

  const notFound = fakeFetch(() => json({ message: 'not found' }, 404));
  await assert.rejects(client(notFound.fetch).get('/repos/a/b'), (e: ForgejoError) => e.kind === 'not_found');

  const okStatus = fakeFetch(() => json({ message: 'not found' }, 404));
  const res = await client(okStatus.fetch).request('GET', '/repos/a/b', { okStatuses: [404] });
  assert.equal(res.status, 404);

  const timeout = fakeFetch(() => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  });
  await assert.rejects(client(timeout.fetch).get('/x'), (e: ForgejoError) => e.kind === 'timeout');
  assert.equal(timeout.requests.length, 1, 'timeouts are not retried');

  const dnsFail = fakeFetch(() => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  });
  await assert.rejects(client(dnsFail.fetch).get('/x'), /Could not resolve git\.example\.com/);
});

test('responses larger than the cap are refused', async () => {
  const f = fakeFetch(() => text('x'.repeat(5000)));
  await assert.rejects(client(f.fetch, { maxResponseBytes: 1000 }).getText('/raw'), (e: ForgejoError) => e.kind === 'too_large');
});

test('requireVersion() gives a clear message on old instances; capabilities are cached', async () => {
  const f = fakeForgejo({}, { version: '14.0.3+gitea-1.22.0' });
  const c = client(f.fetch);
  await assert.rejects(c.requireVersion('16.0', 'forgejo_get_job_logs'), (e: ForgejoError) => {
    assert.equal(e.kind, 'unsupported');
    assert.match(e.message, /needs Forgejo 16\.0 or newer.*14\.0\.3/);
    return true;
  });
  await c.requireVersion('14.0', 'x');
  await client(f.fetch).capabilities();
  assert.equal(f.requests.filter(r => r.path === '/version').length, 1, 'cached per instance');
});

test('dot segments and backslashes in paths are refused before any request (no path traversal)', async () => {
  const f = fakeFetch(() => json({}));
  const c = client(f.fetch);
  for (const path of ['/repos/o/r/branches/..', '/repos/../r/branches/x', '/repos/o/r/tags/%2e%2e', '/repos/o/r/tags/.%2E', '/repos/o/./branches', '/repos/o/r/contents/a%5C..%5Cb']) {
    await assert.rejects(c.delete(path), (e: ForgejoError) => e.kind === 'validation', path);
  }
  assert.equal(f.requests.length, 0);
  // Ordinary names containing dots are fine.
  await c.get('/repos/o/r/branches/release/v1.2..3');
  await c.get('/repos/o/.github/contents/a.b/.env');
  assert.equal(f.requests.length, 2);
});

test('a branch named ".." can never reach the delete-repository route', async () => {
  const { connect } = await import('./helpers.js');
  const f = fakeFetch(() => new Response(null, { status: 204 }));
  const { call, close } = await connect({ fetchImpl: f.fetch });
  const res = await call('forgejo_delete_branch', { owner: 'o', repo: 'r', branch: '..' });
  assert.equal(res.isError, true);
  assert.match(res.text, /Invalid name/);
  assert.ok(!f.requests.some(r => r.method === 'DELETE'), 'no DELETE request may be sent');
  const owner = await call('forgejo_delete_repo', { owner: '..', repo: 'r', confirm_full_name: '../r' });
  assert.equal(owner.isError, true);
  assert.ok(!f.requests.some(r => r.method === 'DELETE'));
  await close();
});

test('204 responses resolve to null', async () => {
  const f = fakeFetch(() => new Response(null, { status: 204 }));
  assert.equal(await client(f.fetch).delete('/x'), null);
});
