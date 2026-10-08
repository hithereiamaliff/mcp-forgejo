/**
 * Settings shared by both entry points (http-server.ts and cli.ts):
 * toolset selection, read-only mode and the outbound network policy.
 */

/** Groups of tools. Clients choose which ones they want with ?toolsets=... or FORGEJO_TOOLSETS. */
export const TOOLSETS = [
  'meta',
  'users',
  'repos',
  'code',
  'issues',
  'pulls',
  'notifications',
  'actions',
  'actions_admin',
  'releases',
  'wiki',
  'labels',
  'orgs',
  'repo_admin',
  'packages',
  'admin',
] as const;

export type Toolset = (typeof TOOLSETS)[number];

/** What "default" expands to. `meta` (forgejo_hello) is always on. */
export const DEFAULT_TOOLSETS: Toolset[] = ['users', 'repos', 'code', 'issues', 'pulls', 'notifications'];

export const TOOLSET_DESCRIPTIONS: Record<Toolset, string> = {
  meta: 'Server and connection info (always on)',
  users: 'User profiles and user search',
  repos: 'List, search, create, fork, update and migrate repositories',
  code: 'Files, trees, branches, commits, comparisons, commit statuses and tags',
  issues: 'Issues, comments, labels on issues, milestones and global issue search',
  pulls: 'Pull requests, diffs, merging and reviews',
  notifications: 'Notification inbox',
  actions: 'Forgejo Actions: workflows, runs, jobs, logs, dispatch',
  actions_admin: 'Forgejo Actions secrets and variables',
  releases: 'Releases and tag deletion',
  wiki: 'Repository wiki pages',
  labels: 'Create, update and delete labels and milestones',
  orgs: 'Organizations, members and teams',
  repo_admin: 'Collaborators, branch protection, webhooks, mirrors and repository deletion',
  packages: 'Package registry',
  admin: 'Site administration (instance admins only)',
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse a toolset list like "default,actions,wiki" or "all".
 * Empty/undefined means the default set. Unknown names throw a ConfigError.
 */
export function parseToolsets(value: string | undefined | null): Set<Toolset> {
  const result = new Set<Toolset>(['meta']);
  const parts = (value ?? '')
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) parts.push('default');

  const unknown: string[] = [];
  for (const part of parts) {
    if (part === 'all') TOOLSETS.forEach(t => result.add(t));
    else if (part === 'default') DEFAULT_TOOLSETS.forEach(t => result.add(t));
    else if ((TOOLSETS as readonly string[]).includes(part)) result.add(part as Toolset);
    else unknown.push(part);
  }
  if (unknown.length) {
    throw new ConfigError(
      `Unknown toolset(s): ${unknown.join(', ')}. Valid values: default, all, ${TOOLSETS.filter(t => t !== 'meta').join(', ')}.`,
    );
  }
  return result;
}

/** "true"/"1"/"yes"/"on" → true; anything else (or empty) → the fallback. */
export function parseBoolean(value: string | undefined | null, fallback = false): boolean {
  if (value === undefined || value === null || value.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Outbound network policy for calls to Forgejo instances.
 * The hosted server fetches URLs that users typed into the key portal, so by
 * default it refuses private/internal addresses (SSRF protection).
 */
export interface NetworkPolicy {
  /** Refuse plain http:// instance URLs. */
  requireHttps: boolean;
  /** Allow loopback / private / link-local addresses (LAN instances). */
  allowPrivate: boolean;
  /** Host names that are exempt from the private-address check. */
  trustedHosts: Set<string>;
}

/** Local CLI: the server runs on the user's own machine, so localhost/LAN/http are fine. */
export const PERMISSIVE_POLICY: NetworkPolicy = { requireHttps: false, allowPrivate: true, trustedHosts: new Set() };

export function networkPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): NetworkPolicy {
  return {
    requireHttps: !parseBoolean(env.FORGEJO_ALLOW_HTTP, false),
    allowPrivate: parseBoolean(env.FORGEJO_ALLOW_PRIVATE_HOSTS, false),
    trustedHosts: new Set(
      (env.FORGEJO_TRUSTED_HOSTS || '')
        .split(',')
        .map(h => h.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}

/** Numeric env var with a fallback and lower bound. */
export function numberFromEnv(value: string | undefined, fallback: number, min = 1): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
