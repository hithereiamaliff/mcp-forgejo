/**
 * Lookups shared by several tools: label/milestone names → IDs, current user,
 * file SHAs, and "fetch every page" for small lists.
 */

import type { ForgejoClient, Query } from '../forgejo/client.js';
import { ForgejoError } from '../forgejo/errors.js';
import type { Json } from '../forgejo/projections.js';
import { encodePath, repoPath } from '../forgejo/url.js';
import { ToolInputError } from './shared.js';

/** Fetch up to `maxPages` pages of a list endpoint (for small lists like labels). */
export async function fetchAllPages<T = Json>(client: ForgejoClient, path: string, query: Query = {}, maxPages = 10): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await client.list<T>(path, query, { page, limit: 50 });
    all.push(...result.items);
    if (!result.hasMore) break;
  }
  return all;
}

/** All labels usable in a repo: its own labels plus its organization's labels (if the owner is an org). */
export async function repoAndOrgLabels(client: ForgejoClient, owner: string, repo: string): Promise<Json[]> {
  const repoLabels = await fetchAllPages(client, repoPath(owner, repo, 'labels'));
  const orgRes = await client.request<Json[]>('GET', `/orgs/${encodeURIComponent(owner)}/labels`, {
    query: { limit: 50 },
    okStatuses: [403, 404],
  });
  const orgLabels = orgRes.status === 200 && Array.isArray(orgRes.data) ? orgRes.data : [];
  return [...repoLabels, ...orgLabels];
}

/**
 * Turn label names or IDs into numeric IDs (names are matched case-insensitively
 * against repo and org labels). Unknown names produce a helpful error.
 */
export async function resolveLabelIds(client: ForgejoClient, owner: string, repo: string, labels: Array<string | number>): Promise<number[]> {
  if (!labels.length) return [];
  const names = labels.filter((l): l is string => typeof l === 'string' && !/^\d+$/.test(l));
  const ids = labels.filter(l => typeof l === 'number' || /^\d+$/.test(String(l))).map(Number);
  if (!names.length) return ids;

  const available = await repoAndOrgLabels(client, owner, repo);
  const missing: string[] = [];
  for (const name of names) {
    const match = available.find(l => String(l.name).toLowerCase() === name.toLowerCase());
    if (match) ids.push(Number(match.id));
    else missing.push(name);
  }
  if (missing.length) {
    const known = available.map(l => `"${l.name}"`).join(', ') || '(none)';
    throw new ToolInputError(
      `Unknown label(s) in ${owner}/${repo}: ${missing.map(m => `"${m}"`).join(', ')}. Available labels: ${known}. ` +
        'Create missing labels first (forgejo_create_label, labels toolset).',
    );
  }
  return [...new Set(ids)];
}

/** Milestone title or ID → ID (the API accepts a name in place of the ID). */
export async function resolveMilestoneId(client: ForgejoClient, owner: string, repo: string, milestone: string | number): Promise<number> {
  if (typeof milestone === 'number' || /^\d+$/.test(milestone)) return Number(milestone);
  try {
    const found = await client.get<Json>(repoPath(owner, repo, 'milestones', encodeURIComponent(milestone)));
    return Number(found.id);
  } catch (error) {
    if (error instanceof ForgejoError && error.kind === 'not_found') {
      throw new ToolInputError(`No milestone titled "${milestone}" in ${owner}/${repo}. Use forgejo_list_milestones to see the available ones.`);
    }
    throw error;
  }
}

/**
 * Turn a branch/tag name (or nothing = default branch) into a commit SHA.
 * Needed for endpoints whose ref is a single path segment (git/trees/{sha},
 * git/commits/{sha}, commits/{ref}/status), which break on names like "feature/x".
 */
export async function resolveCommitSha(client: ForgejoClient, owner: string, repo: string, ref?: string): Promise<string> {
  if (ref && /^[0-9a-f]{7,64}$/i.test(ref)) return ref;
  const commits = await client.get<Json[]>(repoPath(owner, repo, 'commits'), {
    sha: ref,
    limit: 1,
    stat: false,
    verification: false,
    files: false,
  });
  const sha = Array.isArray(commits) && typeof commits[0]?.sha === 'string' ? commits[0].sha : undefined;
  if (!sha) throw new ToolInputError(`Could not find ${ref ? `"${ref}"` : 'the default branch'} in ${owner}/${repo} (is the repository empty?).`);
  return sha;
}

/** The authenticated user's login (needs read:user). */
export async function currentLogin(client: ForgejoClient): Promise<string> {
  const me = await client.get<Json>('/user');
  return String(me.login ?? me.username ?? '');
}

/**
 * SHA of an existing file (for updates/deletes), or undefined if it doesn't exist.
 * Throws if the path is a directory.
 */
export async function fileSha(client: ForgejoClient, owner: string, repo: string, path: string, ref?: string): Promise<string | undefined> {
  const res = await client.request<Json | Json[]>('GET', repoPath(owner, repo, 'contents', encodePath(path)), {
    query: { ref },
    okStatuses: [404],
  });
  if (res.status === 404) return undefined;
  if (Array.isArray(res.data)) throw new ToolInputError(`"${path}" is a directory, not a file.`);
  return typeof res.data?.sha === 'string' ? res.data.sha : undefined;
}
