/**
 * SSRF guard for outbound requests to user-supplied Forgejo URLs.
 *
 * The hosted server calls whatever instance URL a user saved in the key portal.
 * Without this guard, someone could point it at http://169.254.169.254 (cloud
 * metadata), http://mcp-key-service:8090 or other services on the VPS.
 *
 * Two layers:
 *   1. isBlockedAddress() for IP-literal hosts (checked in url.ts — Node never
 *      runs a DNS lookup for those).
 *   2. A guarded DNS lookup used by the undici connection pool, so every
 *      connection is checked at connect time. This also defeats DNS rebinding
 *      (resolve-to-public-then-private tricks), because there is no gap between
 *      the check and the connection.
 */

import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';
import type { NetworkPolicy } from '../config.js';

const BLOCKED_V4 = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata)
  ['172.16.0.0', 12], // private (Docker networks live here)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
}

const BLOCKED_V6 = new net.BlockList();
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

/** Expand an IPv6 address into 8 numeric groups (handles "::" and a trailing dotted IPv4). */
function ipv6Groups(address: string): number[] | null {
  let ip = address.split('%')[0].toLowerCase();
  // Trailing dotted quad, e.g. ::ffff:127.0.0.1
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    if (octets.some(o => o > 255)) return null;
    ip = ip.slice(0, -dotted[1].length) + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const [head, tail] = ip.split('::');
  if (ip.split('::').length > 2) return null;
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined ? headGroups.length !== 8 : missing < 0) return null;
  const groups = [...headGroups, ...Array(tail === undefined ? 0 : missing).fill('0'), ...tailGroups].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible or NAT64 IPv6 address. */
function embeddedIpv4(groups: number[]): string | null {
  const v4 = () => `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  const zeros = (from: number, to: number) => groups.slice(from, to).every(g => g === 0);
  if (zeros(0, 5) && groups[5] === 0xffff) return v4(); // ::ffff:0:0/96 mapped
  if (zeros(0, 6) && (groups[6] !== 0 || groups[7] > 1)) return v4(); // ::a.b.c.d (deprecated compatible)
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) return v4(); // 64:ff9b::/96 NAT64
  return null;
}

/** True if connecting to this IP would reach a private, local or otherwise internal address. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address.split('%')[0]);
  if (family === 4) return BLOCKED_V4.check(address, 'ipv4');
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return true; // unparseable → refuse
    const v4 = embeddedIpv4(groups);
    if (v4) return BLOCKED_V4.check(v4, 'ipv4');
    return BLOCKED_V6.check(address.split('%')[0], 'ipv6');
  }
  return true; // not an IP at all → refuse
}

/** Raised (inside the connection attempt) when a host resolves to a blocked address. */
export class BlockedAddressError extends Error {
  readonly code = 'EFORGEJOBLOCKED';
  constructor(
    public readonly hostname: string,
    public readonly address: string,
  ) {
    super(`${hostname} resolves to ${address}, which is a private or internal address`);
    this.name = 'BlockedAddressError';
  }
}

export function isHostTrusted(hostname: string, policy: NetworkPolicy): boolean {
  return policy.allowPrivate || policy.trustedHosts.has(hostname.toLowerCase().replace(/^\[|\]$/g, ''));
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;
type LookupFn = (hostname: string, options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

/**
 * A dns.lookup replacement that refuses hosts resolving to blocked addresses.
 * Compatible with net/tls `lookup` (both the single-address and `all: true` forms).
 */
export function createGuardedLookup(policy: NetworkPolicy, lookupImpl: LookupFn = dns.lookup as unknown as LookupFn) {
  return (hostname: string, options: dns.LookupOptions | number | undefined, callback: LookupCallback): void => {
    const opts: dns.LookupOptions = typeof options === 'number' ? { family: options } : { ...(options ?? {}) };
    lookupImpl(hostname, { ...opts, all: true } as dns.LookupAllOptions, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses?.length) {
        const notFound: NodeJS.ErrnoException = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
        return callback(notFound);
      }
      if (!isHostTrusted(hostname, policy)) {
        const bad = addresses.find(a => isBlockedAddress(a.address));
        if (bad) return callback(new BlockedAddressError(hostname, bad.address) as unknown as NodeJS.ErrnoException);
      }
      if (opts.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

const agents = new Map<string, Agent>();

/** One shared connection pool per network policy (credentials are never part of the pool). */
export function guardedAgent(policy: NetworkPolicy): Agent {
  const key = JSON.stringify({ p: policy.allowPrivate, t: [...policy.trustedHosts].sort() });
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: createGuardedLookup(policy) as never, timeout: 15_000 },
      keepAliveTimeout: 10_000,
    });
    agents.set(key, agent);
  }
  return agent;
}

/** Find a BlockedAddressError anywhere in an error's cause chain (undici wraps it in "fetch failed"). */
export function findBlockedCause(error: unknown): BlockedAddressError | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    if (current instanceof BlockedAddressError) return current;
    if (typeof current === 'object' && (current as { code?: string }).code === 'EFORGEJOBLOCKED') return current as BlockedAddressError;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
