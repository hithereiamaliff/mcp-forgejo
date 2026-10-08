/**
 * Normalising and validating Forgejo instance URLs.
 *
 * Users type all sorts of things into the portal: "git.example.com",
 * "https://git.example.com/", "https://git.example.com/api/v1", or an install
 * under a sub-path like "https://example.com/forgejo". All of these become a
 * clean base URL without a trailing slash; API calls append "/api/v1/...".
 */

import net from 'node:net';
import type { NetworkPolicy } from '../config.js';
import { ForgejoError } from './errors.js';
import { isBlockedAddress, isHostTrusted } from './ssrf.js';

/** Turn user input into a normalised instance base URL, or throw a ForgejoError('config'). */
export function normalizeInstanceUrl(raw: string | undefined | null, policy: NetworkPolicy): string {
  let input = (raw ?? '').trim();
  if (!input) {
    throw new ForgejoError('config', 'No Forgejo instance URL is configured.');
  }
  // "git.example.com" → "https://git.example.com"
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `https://${input}`;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ForgejoError('config', `"${raw}" is not a valid URL. Use the base URL of your Forgejo instance, e.g. https://git.example.com`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ForgejoError('config', `Unsupported URL scheme "${url.protocol}". Use https:// for your Forgejo instance.`);
  }
  if (url.protocol === 'http:' && policy.requireHttps) {
    throw new ForgejoError(
      'config',
      `Plain http:// is not allowed for Forgejo instances on this server (your access token would travel unencrypted). Use https://${url.host}${url.pathname === '/' ? '' : url.pathname}`,
    );
  }
  if (url.username || url.password) {
    throw new ForgejoError('config', 'The Forgejo URL must not contain a username or password. Put the access token in the token field instead.');
  }

  // IP-literal hosts never go through DNS, so check them here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host) && !isHostTrusted(host, policy)) {
    throw new ForgejoError('blocked', `The Forgejo URL points at a private or internal address (${host}), which this server does not allow.`);
  }

  // Drop query/fragment, trailing slashes and a trailing /api/v1 (or /api/v1/swagger etc.).
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/api\/v1(\/.*)?$/i, '').replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Host name of an (already normalised) instance URL, for display. */
export function instanceHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Encode each segment of a file path, keeping the slashes. */
export function encodePath(filePath: string): string {
  return filePath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

/** "/repos/{owner}/{repo}" with both parts encoded, plus optional extra segments. */
export function repoPath(owner: string, repo: string, ...rest: Array<string | number>): string {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return rest.length ? `${base}/${rest.map(s => (typeof s === 'number' ? String(s) : s)).join('/')}` : base;
}
