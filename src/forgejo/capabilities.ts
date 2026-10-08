/**
 * What a Forgejo instance can do: its version and API paging limits.
 *
 * Fetched from the public /api/v1/version and /api/v1/settings/api endpoints and
 * cached per instance URL (not per user: the data is the same for everyone).
 * Tools declare a `minVersion` (e.g. job logs need Forgejo 16) and get a clear
 * error on older instances instead of a confusing 404.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface InstanceCapabilities {
  /** Raw version string, e.g. "14.0.3+gitea-1.22.0", or null if unknown. */
  version: string | null;
  parsed: ParsedVersion | null;
  /** Largest page the API returns (requests for more are silently capped). */
  maxResponseItems: number;
  defaultPagingNum: number;
  defaultGitTreesPerPage: number;
  /** Largest blob the contents API returns inline. */
  maxBlobSize: number;
}

export const DEFAULT_CAPABILITIES: InstanceCapabilities = {
  version: null,
  parsed: null,
  maxResponseItems: 50,
  defaultPagingNum: 30,
  defaultGitTreesPerPage: 1000,
  maxBlobSize: 10 * 1024 * 1024,
};

/**
 * "14.0.3+gitea-1.22.0" → {14,0,3}; "v17.0.0-dev-123" → {17,0,0}; "1.21.11-1" → {1,21,11}.
 * Returns null for anything that doesn't start with a number.
 */
export function parseVersion(version: string | null | undefined): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec((version ?? '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

/** Negative if a < b, 0 if equal, positive if a > b (major.minor.patch). */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * True if the instance is at least `min` ("16.0"). Unknown versions are assumed
 * to be new enough — the API itself will answer if not.
 */
export function meetsVersion(caps: InstanceCapabilities, min: string): boolean {
  const required = parseVersion(min);
  if (!required || !caps.parsed) return true;
  return compareVersions(caps.parsed, required) >= 0;
}

const CACHE_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;
const MAX_ENTRIES = 1000;
const cache = new Map<string, { caps: InstanceCapabilities; expiresAt: number }>();
const pending = new Map<string, Promise<InstanceCapabilities>>();

/**
 * Cached capabilities for an instance. `load` performs the actual requests
 * (supplied by ForgejoClient so the SSRF guard and timeouts apply).
 */
export async function cachedCapabilities(
  baseUrl: string,
  load: () => Promise<{ caps: InstanceCapabilities; complete: boolean }>,
): Promise<InstanceCapabilities> {
  const hit = cache.get(baseUrl);
  if (hit && Date.now() < hit.expiresAt) return hit.caps;
  const inflight = pending.get(baseUrl);
  if (inflight) return inflight;

  const promise = (async () => {
    const { caps, complete } = await load();
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(baseUrl, { caps, expiresAt: Date.now() + (complete ? CACHE_TTL_MS : FAILURE_TTL_MS) });
    return caps;
  })();
  pending.set(baseUrl, promise);
  try {
    return await promise;
  } finally {
    pending.delete(baseUrl);
  }
}

/** For tests. */
export function clearCapabilitiesCache(): void {
  cache.clear();
  pending.clear();
}
