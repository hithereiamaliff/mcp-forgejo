/**
 * SSRF guard: blocked address ranges, guarded DNS lookups and a real
 * connection attempt through the guarded connection pool.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type dns from 'node:dns';
import type { NetworkPolicy } from '../src/config.js';
import { BlockedAddressError, createGuardedLookup, isBlockedAddress } from '../src/forgejo/ssrf.js';
import { ForgejoClient } from '../src/forgejo/client.js';
import { clearCapabilitiesCache } from '../src/forgejo/capabilities.js';

const STRICT: NetworkPolicy = { requireHttps: false, allowPrivate: false, trustedHosts: new Set() };

test('private, local and special-purpose addresses are blocked', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.17.0.2', // Docker bridge
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // same, hex form
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1', // NAT64 of 10.0.0.1
    'not-an-ip',
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  }
});

test('public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '140.82.112.3', '2606:4700:4700::1111', '2a01:4f8:c17::1', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
  }
});

type FakeLookup = (hostname: string, options: dns.LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

function fakeDns(answers: Record<string, string[]>): FakeLookup {
  return (hostname, _options, cb) => {
    const list = answers[hostname];
    if (!list) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
    cb(null, list.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
}

function lookupOnce(lookup: ReturnType<typeof createGuardedLookup>, host: string, all = false) {
  return new Promise<{ err: unknown; address?: unknown; family?: number }>(resolve =>
    lookup(host, { all }, (err, address, family) => resolve({ err, address, family })),
  );
}

test('guarded lookup refuses hosts that resolve to blocked addresses (incl. mixed answers)', async () => {
  const lookup = createGuardedLookup(
    STRICT,
    fakeDns({ 'good.example': ['93.184.216.34'], 'evil.example': ['127.0.0.1'], 'mixed.example': ['93.184.216.34', '10.0.0.1'] }),
  );
  const good = await lookupOnce(lookup, 'good.example');
  assert.equal(good.err, null);
  assert.equal(good.address, '93.184.216.34');
  assert.equal(good.family, 4);

  const goodAll = await lookupOnce(lookup, 'good.example', true);
  assert.deepEqual(goodAll.address, [{ address: '93.184.216.34', family: 4 }]);

  const evil = await lookupOnce(lookup, 'evil.example');
  assert.ok(evil.err instanceof BlockedAddressError);
  const mixed = await lookupOnce(lookup, 'mixed.example');
  assert.ok(mixed.err instanceof BlockedAddressError, 'any private answer blocks the host');
  const missing = await lookupOnce(lookup, 'missing.example');
  assert.equal((missing.err as NodeJS.ErrnoException).code, 'ENOTFOUND');
});

test('trusted hosts and allowPrivate bypass the check', async () => {
  const answers = fakeDns({ 'git.internal': ['172.17.0.1'] });
  const trusted = createGuardedLookup({ ...STRICT, trustedHosts: new Set(['git.internal']) }, answers);
  assert.equal((await lookupOnce(trusted, 'git.internal')).err, null);
  const lan = createGuardedLookup({ ...STRICT, allowPrivate: true }, answers);
  assert.equal((await lookupOnce(lan, 'git.internal')).err, null);
});

test('a real request to a loopback server is refused by the guarded connection pool', async () => {
  clearCapabilitiesCache();
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    // "localhost" goes through DNS, so the guarded lookup must refuse it.
    const client = new ForgejoClient({ baseUrl: `http://localhost:${port}`, token: 't0ken-secret', policy: STRICT, retryDelayMs: 0 });
    await assert.rejects(client.get('/user'), (error: Error & { kind?: string }) => {
      assert.equal(error.kind, 'blocked');
      assert.match(error.message, /private or internal address/);
      return true;
    });
    assert.equal(hits, 0, 'the server must never be contacted');

    // With private addresses allowed (local CLI), the same request goes through.
    const permissive = new ForgejoClient({
      baseUrl: `http://localhost:${port}`,
      policy: { ...STRICT, allowPrivate: true },
      retryDelayMs: 0,
    });
    assert.deepEqual(await permissive.get('/user'), {});
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});
