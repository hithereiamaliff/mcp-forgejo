/**
 * repos toolset: list, search, inspect, create, fork, update and migrate repositories.
 */

import { z } from 'zod';
import { projectRepo, type Json } from '../forgejo/projections.js';
import { repoPath } from '../forgejo/url.js';
import { bullets, fmtDate, formatNumber, table } from '../utils/format.js';
import {
  READ_ONLY,
  WRITE,
  WRITE_IDEMPOTENT,
  ToolInputError,
  defineTool,
  formatResult,
  pageFooter,
  pageMeta,
  pagination,
  repoRef,
  responseFormatSchema,
} from './shared.js';

function visibility(r: Json): string {
  const tags = [r.private ? 'private' : 'public'];
  if (r.fork) tags.push('fork');
  if (r.mirror) tags.push('mirror');
  if (r.template) tags.push('template');
  if (r.archived) tags.push('archived');
  return tags.join(', ');
}

export function renderRepoTable(repos: Json[]): string {
  return table(
    ['Repository', 'Description', 'Visibility', 'Stars', 'Updated'],
    repos.map(r => [r.full_name, (r.description ?? '').slice(0, 80), visibility(r), r.stars_count ?? 0, fmtDate(r.updated_at)]),
  );
}

export function renderRepo(r: Json, languages?: Record<string, number>): string {
  const p = projectRepo(r);
  const langTotal = languages ? Object.values(languages).reduce((a, b) => a + b, 0) : 0;
  const langs =
    languages && langTotal
      ? Object.entries(languages)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 6)
          .map(([name, bytes]) => `${name} ${((bytes / langTotal) * 100).toFixed(1)}%`)
          .join(', ')
      : p.language;
  const perms = p.permissions ? Object.entries(p.permissions).filter(([, v]) => v).map(([k]) => k).join(', ') : undefined;
  return [
    `## ${p.full_name}`,
    '',
    bullets([
      ['Description', p.description],
      ['Visibility', visibility(r)],
      ['Forked from', p.parent],
      ['Mirror of', r.mirror ? p.original_url : undefined],
      ['Default branch', p.default_branch],
      ['Languages', langs],
      ['Topics', p.topics],
      ['Stars / forks / watchers', `${p.stars ?? 0} / ${p.forks ?? 0} / ${p.watchers ?? 0}`],
      ['Open issues / PRs', `${p.open_issues ?? 0} / ${p.open_pulls ?? 0}`],
      ['Releases', p.releases],
      ['Size', p.size_kb !== undefined ? `${formatNumber(p.size_kb)} KB` : undefined],
      ['Empty', p.empty ? 'yes (no commits yet)' : undefined],
      [
        'Features',
        [
          r.has_issues && 'issues',
          r.has_pull_requests && 'pull requests',
          r.has_wiki && 'wiki',
          r.has_releases && 'releases',
          r.has_actions && 'actions',
          r.has_packages && 'packages',
        ]
          .filter(Boolean)
          .join(', '),
      ],
      ['Your permissions', perms],
      ['Website', p.website],
      ['Created', fmtDate(p.created_at)],
      ['Updated', fmtDate(p.updated_at)],
      ['Web', p.html_url],
      ['Clone (https)', p.clone_url],
      ['Clone (ssh)', p.ssh_url],
    ]),
  ].join('\n');
}

export const listRepos = defineTool({
  name: 'forgejo_list_repos',
  title: 'List repositories',
  toolset: 'repos',
  description:
    'List repositories. Without `owner`: repositories of the authenticated user (including ones they can access through ' +
    'organizations and collaborations). With `owner`: repositories of that organization or user. ' +
    'Use forgejo_search_repos to search by keyword or topic.',
  inputSchema: {
    owner: z.string().trim().min(1).max(100).optional().describe('Organization or user name. Omit for your own repositories.'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    let result;
    if (!owner) {
      result = await client.list<Json>('/user/repos', {}, { page, limit });
    } else {
      // Try as an organization first; fall back to a user.
      const org = await client.request<Json[]>('GET', `/orgs/${encodeURIComponent(owner)}/repos`, {
        query: { page: 1, limit: 1 },
        okStatuses: [404],
      });
      const path = org.status === 404 ? `/users/${encodeURIComponent(owner)}/repos` : `/orgs/${encodeURIComponent(owner)}/repos`;
      result = await client.list<Json>(path, {}, { page, limit });
    }
    const title = owner ? `Repositories of ${owner}` : 'Your repositories';
    return formatResult(
      response_format,
      () => (result.items.length ? [`## ${title}`, '', renderRepoTable(result.items), '', pageFooter(result, 'repositories')].join('\n') : `${title}: none found.`),
      () => ({ repositories: result.items.map(projectRepo), ...pageMeta(result) }),
    );
  },
});

export const searchRepos = defineTool({
  name: 'forgejo_search_repos',
  title: 'Search repositories',
  toolset: 'repos',
  description:
    'Search repositories on the instance by keyword (name, optionally description) or topic. ' +
    'Includes private repositories you can access. Filter by type (fork/source/mirror/collaborative), archived state and sort order.',
  inputSchema: {
    query: z.string().trim().max(200).optional().describe('Keyword to search for (omit to list everything visible)'),
    topic: z.boolean().default(false).describe('Match the keyword against topics only'),
    include_description: z.boolean().default(true).describe('Also search in repository descriptions'),
    mode: z.enum(['fork', 'source', 'mirror', 'collaborative']).optional().describe('Only this type of repository'),
    archived: z.boolean().optional().describe('true: only archived; false: only non-archived; omit: both'),
    private_only: z.boolean().optional().describe('true: only private; false: only public; omit: both'),
    sort: z.enum(['alpha', 'created', 'updated', 'size', 'id', 'stars', 'forks']).default('updated').describe('Sort field (default "updated")'),
    order: z.enum(['asc', 'desc']).default('desc').describe('Sort order (default "desc")'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const client = ctx.getClient();
    const result = await client.list<Json>(
      '/repos/search',
      {
        q: args.query,
        topic: args.topic || undefined,
        includeDesc: args.include_description,
        mode: args.mode,
        archived: args.archived,
        is_private: args.private_only,
        sort: args.sort,
        order: args.order,
      },
      { page: args.page, limit: args.limit, extract: b => (b as Json)?.data ?? [] },
    );
    return formatResult(
      args.response_format,
      () =>
        result.items.length
          ? [`## Repositories${args.query ? ` matching "${args.query}"` : ''}`, '', renderRepoTable(result.items), '', pageFooter(result, 'repositories')].join('\n')
          : `No repositories found${args.query ? ` for "${args.query}"` : ''}.`,
      () => ({ repositories: result.items.map(projectRepo), ...pageMeta(result) }),
    );
  },
});

export const getRepo = defineTool({
  name: 'forgejo_get_repo',
  title: 'Get repository details',
  toolset: 'repos',
  description:
    'Get details of one repository: description, visibility, default branch, languages, topics, counts of stars/forks/open issues/PRs, ' +
    'enabled features, your permissions and clone URLs.',
  inputSchema: { ...repoRef(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, response_format }, ctx) {
    const client = ctx.getClient();
    const [r, languages] = await Promise.all([
      client.get<Json>(repoPath(owner, repo)),
      client.get<Record<string, number>>(repoPath(owner, repo, 'languages')).catch(() => undefined),
    ]);
    return formatResult(response_format, () => renderRepo(r, languages ?? undefined), () => ({ ...projectRepo(r), languages: languages ?? undefined }));
  },
});

export const createRepo = defineTool({
  name: 'forgejo_create_repo',
  title: 'Create a repository',
  toolset: 'repos',
  description:
    'Create a repository in your account, or in an organization with `owner`. Optionally initialise it with a README, .gitignore and license, ' +
    'or generate it from a template repository with `template` ("owner/repo").',
  inputSchema: {
    name: z.string().trim().min(1).max(100).describe('Repository name'),
    owner: z.string().trim().min(1).max(100).optional().describe('Organization to create it in. Omit for your own account.'),
    description: z.string().max(2048).optional().describe('Short description'),
    private: z.boolean().default(false).describe('Make the repository private (default false)'),
    auto_init: z.boolean().default(false).describe('Create an initial commit with README (and gitignore/license if given)'),
    default_branch: z.string().trim().max(100).optional().describe('Default branch name (e.g. "main")'),
    gitignores: z.string().max(200).optional().describe('Comma-separated .gitignore templates, e.g. "Node,VisualStudioCode" (needs auto_init)'),
    license: z.string().max(100).optional().describe('License template, e.g. "MIT" (needs auto_init)'),
    template: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, 'Use the form owner/repo')
      .optional()
      .describe('Generate from this template repository ("owner/repo"); copies its files, labels and topics'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler(args, ctx) {
    const client = ctx.getClient();
    let created: Json;
    if (args.template) {
      const [tOwner, tRepo] = args.template.split('/');
      const owner = args.owner ?? String((await client.get<Json>('/user')).login);
      created = await client.post<Json>(repoPath(tOwner, tRepo, 'generate'), {
        owner,
        name: args.name,
        description: args.description,
        private: args.private,
        default_branch: args.default_branch,
        git_content: true,
        labels: true,
        topics: true,
      });
    } else {
      const body = {
        name: args.name,
        description: args.description,
        private: args.private,
        auto_init: args.auto_init,
        default_branch: args.default_branch,
        gitignores: args.gitignores,
        license: args.license,
        readme: args.auto_init ? 'Default' : undefined,
      };
      if (args.owner) {
        const res = await client.request<Json>('POST', `/orgs/${encodeURIComponent(args.owner)}/repos`, { body, okStatuses: [404] });
        if (res.status === 404) {
          throw new ToolInputError(`There is no organization named "${args.owner}" (or you can't create repositories in it). Omit owner to create the repository in your own account.`);
        }
        created = res.data;
      } else {
        created = await client.post<Json>('/user/repos', body);
      }
    }
    return formatResult(args.response_format, () => `Created repository **${created.full_name}**.\n\n${renderRepo(created)}`, () => projectRepo(created));
  },
});

export const forkRepo = defineTool({
  name: 'forgejo_fork_repo',
  title: 'Fork a repository',
  toolset: 'repos',
  description: 'Fork a repository into your account, or into an organization with `organization`. Optionally give the fork a different name.',
  inputSchema: {
    ...repoRef(),
    organization: z.string().trim().min(1).max(100).optional().describe('Organization to fork into. Omit for your own account.'),
    name: z.string().trim().min(1).max(100).optional().describe('Name for the fork (default: same as the original)'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler({ owner, repo, organization, name, response_format }, ctx) {
    const client = ctx.getClient();
    const fork = await client.post<Json>(repoPath(owner, repo, 'forks'), { organization, name });
    return formatResult(response_format, () => `Forked ${owner}/${repo} → **${fork.full_name}** (${fork.html_url}).`, () => projectRepo(fork));
  },
});

export const updateRepo = defineTool({
  name: 'forgejo_update_repo',
  title: 'Update repository settings',
  toolset: 'repos',
  description:
    'Change repository settings: name, description, website, visibility, default branch, archived state, enabled features ' +
    '(issues, wiki, pull requests, releases, actions) and topics. Only the fields you pass are changed.',
  inputSchema: {
    ...repoRef(),
    name: z.string().trim().min(1).max(100).optional().describe('Rename the repository'),
    description: z.string().max(2048).optional().describe('New description'),
    website: z.string().max(1024).optional().describe('Project website URL'),
    private: z.boolean().optional().describe('true: make private; false: make public'),
    archived: z.boolean().optional().describe('Archive (read-only) or unarchive the repository'),
    template: z.boolean().optional().describe('Mark as a template repository'),
    default_branch: z.string().trim().max(250).optional().describe('Change the default branch (must exist)'),
    has_issues: z.boolean().optional().describe('Enable or disable the issue tracker'),
    has_wiki: z.boolean().optional().describe('Enable or disable the wiki'),
    has_pull_requests: z.boolean().optional().describe('Enable or disable pull requests'),
    has_releases: z.boolean().optional().describe('Enable or disable releases'),
    has_actions: z.boolean().optional().describe('Enable or disable Forgejo Actions'),
    has_projects: z.boolean().optional().describe('Enable or disable projects (kanban boards)'),
    topics: z.array(z.string().trim().min(1).max(50)).max(25).optional().describe('Replace the topic list (lowercase, letters/numbers/dashes)'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ owner, repo, topics, response_format, ...fields }, ctx) {
    const client = ctx.getClient();
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (!Object.keys(patch).length && !topics) throw new ToolInputError('Pass at least one setting to change.');
    let updated: Json | undefined;
    if (Object.keys(patch).length) updated = await client.patch<Json>(repoPath(owner, repo), patch);
    const finalName = (patch.name as string | undefined) ?? repo;
    if (topics) await client.put(repoPath(owner, finalName, 'topics'), { topics });
    updated = await client.get<Json>(repoPath(owner, finalName));
    return formatResult(response_format, () => `Updated **${updated!.full_name}**.\n\n${renderRepo(updated!)}`, () => projectRepo(updated!));
  },
});

export const migrateRepo = defineTool({
  name: 'forgejo_migrate_repo',
  title: 'Import or mirror a repository',
  toolset: 'repos',
  description:
    'Import a repository from another Git host into Forgejo (GitHub, GitLab, Gitea, Forgejo, Gogs, OneDev, GitBucket, Codebase or any plain Git URL). ' +
    'With `mirror: true` it becomes a pull mirror that Forgejo keeps in sync. For GitHub/GitLab/Gitea services it can also copy issues, labels, ' +
    'milestones, pull requests, releases and the wiki (not available for mirrors). Private sources need `auth_token` — only pass a token the user ' +
    'explicitly gave you. Large repositories can take a few minutes.',
  inputSchema: {
    clone_addr: z.string().trim().url().describe('Source repository URL, e.g. https://github.com/owner/repo.git'),
    repo_name: z.string().trim().min(1).max(100).describe('Name of the new repository on Forgejo'),
    repo_owner: z.string().trim().min(1).max(100).optional().describe('User or organization to own it. Omit for your own account.'),
    service: z
      .enum(['git', 'github', 'gitlab', 'gitea', 'forgejo', 'gogs', 'onedev', 'gitbucket', 'codebase'])
      .default('git')
      .describe('Source type: "git" for code only; a forge type to also copy issues/PRs/etc.'),
    mirror: z.boolean().default(false).describe('Keep it as a pull mirror that syncs periodically'),
    mirror_interval: z.string().max(20).optional().describe('Mirror sync interval, e.g. "8h0m0s" (mirrors only)'),
    private: z.boolean().default(false).describe('Make the new repository private (default false)'),
    description: z.string().max(2048).optional().describe('Description for the new repository'),
    auth_token: z.string().max(500).optional().describe('Access token for a private source (GitHub/GitLab/Gitea token)'),
    auth_username: z.string().max(200).optional().describe('Username for a private plain-Git source'),
    auth_password: z.string().max(500).optional().describe('Password for a private plain-Git source'),
    issues: z.boolean().default(false).describe('Copy issues (forge services only)'),
    labels: z.boolean().default(false).describe('Copy labels'),
    milestones: z.boolean().default(false).describe('Copy milestones'),
    pull_requests: z.boolean().default(false).describe('Copy pull requests'),
    releases: z.boolean().default(false).describe('Copy releases'),
    wiki: z.boolean().default(false).describe('Copy the wiki'),
    lfs: z.boolean().default(false).describe('Copy Git LFS objects'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler({ response_format, service, ...args }, ctx) {
    const client = ctx.getClient();
    const body = { ...args, service: service === 'forgejo' ? 'gitea' : service };
    const res = await client.request<Json>('POST', '/repos/migrate', { body, timeoutMs: 300_000 });
    const r = res.data;
    return formatResult(
      response_format,
      () => `${args.mirror ? 'Mirrored' : 'Imported'} ${args.clone_addr} → **${r.full_name}** (${r.html_url}).\n\n${renderRepo(r)}`,
      () => projectRepo(r),
    );
  },
});

export const repoTools = [listRepos, searchRepos, getRepo, createRepo, forkRepo, updateRepo, migrateRepo];
