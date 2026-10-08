/**
 * orgs toolset: organizations, their members and teams (team members and
 * team repositories).
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ForgejoClient } from '../forgejo/client.js';
import { ForgejoError } from '../forgejo/errors.js';
import { projectOrg, projectTeam, projectUser, type Json } from '../forgejo/projections.js';
import { bullets, table, untrusted } from '../utils/format.js';
import { fetchAllPages } from './lookups.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  WRITE_IDEMPOTENT,
  ToolInputError,
  defineTool,
  errorResult,
  formatResult,
  pageFooter,
  pageMeta,
  pagination,
  responseFormatSchema,
  textResult,
} from './shared.js';

// =============================================================================
// Schema pieces (factories: call per use, never share one instance)
// =============================================================================

const orgSchema = (what = 'Organization name (e.g. "acme")') => z.string().trim().min(1).max(100).describe(what);

const visibilitySchema = () =>
  z
    .enum(['public', 'limited', 'private'])
    .describe('"public": visible to everyone; "limited": signed-in users only; "private": members only');

const teamRefSchema = () =>
  z
    .union([z.number().int().positive(), z.string().trim().min(1).max(100)])
    .describe('The team: its numeric ID, or its name within the organization (e.g. "developers")');

const nameListSchema = (what: string) => z.array(z.string().trim().min(1).max(100)).max(50).optional().describe(what);

/** Repository units a new team gets access to unless told otherwise. */
const DEFAULT_TEAM_UNITS = [
  'repo.code',
  'repo.issues',
  'repo.pulls',
  'repo.releases',
  'repo.wiki',
  'repo.projects',
  'repo.packages',
  'repo.actions',
];

// =============================================================================
// Rendering
// =============================================================================

/** "write: code, issues; read: wiki" from a team's units_map (or its plain units list). */
function teamUnits(t: Json): string {
  const map = t.units_map as Record<string, string> | undefined;
  if (map && Object.keys(map).length) {
    const byAccess = new Map<string, string[]>();
    for (const [unit, access] of Object.entries(map)) {
      if (access === 'none') continue;
      byAccess.set(access, [...(byAccess.get(access) ?? []), unit.replace(/^repo\./, '')]);
    }
    return [...byAccess.entries()].map(([access, units]) => `${access}: ${units.sort().join(', ')}`).join('; ');
  }
  return ((t.units as string[] | undefined) ?? []).map(u => u.replace(/^repo\./, '')).join(', ');
}

function renderTeamTable(teams: Json[]): string {
  return table(
    ['ID', 'Team', 'Permission', 'Units', 'All repos', 'Description'],
    teams.map(t => [t.id, t.name, t.permission, teamUnits(t), t.includes_all_repositories ? 'yes' : 'no', (t.description ?? '').slice(0, 80)]),
  );
}

function renderTeam(t: Json): string {
  return bullets([
    ['ID', t.id],
    ['Permission', t.permission],
    ['Units', teamUnits(t)],
    ['All repositories', t.includes_all_repositories ? 'yes (current and future)' : 'no (add them with forgejo_update_team_repos)'],
    ['Can create org repositories', t.can_create_org_repo ? 'yes' : 'no'],
    ['Description', t.description],
  ]);
}

function renderOrg(o: Json, webUrl: string): string {
  const p = projectOrg(o);
  const lines = [
    `## ${p.name}${p.full_name && p.full_name !== p.name ? ` (${p.full_name})` : ''}`,
    '',
    bullets([
      ['ID', p.id],
      ['Visibility', p.visibility],
      ['Website', p.website],
      ['Location', p.location],
      ['Email', p.email],
      ['Repo admins can change team access', p.repo_admin_change_team_access === undefined ? undefined : p.repo_admin_change_team_access ? 'yes' : 'no'],
      ['Web', webUrl],
    ]),
  ];
  if (p.description) lines.push('', untrusted(p.description, 'Description (written by the organization)'));
  return lines.join('\n');
}

const orgWebUrl = (client: ForgejoClient, o: Json) => client.webUrl(`/${encodeURIComponent(String(o.name ?? o.username ?? ''))}`);

// =============================================================================
// Team helpers
// =============================================================================

interface ResolvedTeam {
  id: number;
  name: string;
  includesAll: boolean;
}

/**
 * Team ID or name → team. Names are matched case-insensitively within `org`;
 * a string of digits that matches no name is treated as an ID. An ID must
 * belong to `org`.
 */
async function resolveTeam(client: ForgejoClient, org: string, team: string | number): Promise<ResolvedTeam> {
  const toResolved = (t: Json): ResolvedTeam => ({ id: Number(t.id), name: String(t.name), includesAll: Boolean(t.includes_all_repositories) });
  let id: number | undefined = typeof team === 'number' ? team : undefined;
  if (typeof team === 'string') {
    const teams = await fetchAllPages<Json>(client, `/orgs/${encodeURIComponent(org)}/teams`);
    const lower = team.toLowerCase();
    const match = teams.find(t => String(t.name).toLowerCase() === lower);
    if (match) return toResolved(match);
    if (!/^\d+$/.test(team)) {
      const known = teams.map(t => `"${t.name}"`).join(', ') || '(none)';
      throw new ToolInputError(`No team named "${team}" in ${org}. Teams: ${known}.`);
    }
    id = Number(team);
  }
  const found = await client.get<Json>(`/teams/${id}`);
  const teamOrg = found.organization?.name ?? found.organization?.username;
  if (teamOrg && String(teamOrg).toLowerCase() !== org.toLowerCase()) {
    throw new ToolInputError(`Team ${id} ("${found.name}") belongs to ${teamOrg}, not ${org}.`);
  }
  return toResolved(found);
}

interface Change {
  action: 'add' | 'remove';
  target: string;
}

/** Validate add/remove lists: at least one entry, no name in both, duplicates dropped. */
function plannedChanges(add: string[] | undefined, remove: string[] | undefined, noun: string): Change[] {
  const adds = [...new Set(add ?? [])];
  const removes = [...new Set(remove ?? [])];
  if (!adds.length && !removes.length) throw new ToolInputError(`Pass at least one ${noun} in add or remove.`);
  const both = adds.filter(a => removes.some(r => r.toLowerCase() === a.toLowerCase()));
  if (both.length) throw new ToolInputError(`${both.join(', ')} appear in both add and remove.`);
  return [...adds.map(target => ({ action: 'add' as const, target })), ...removes.map(target => ({ action: 'remove' as const, target }))];
}

/**
 * Apply each change in turn, collecting per-item Forgejo errors instead of
 * stopping at the first one. The result is an error only if every change failed.
 */
async function applyChanges(
  heading: string,
  changes: Change[],
  run: (change: Change) => Promise<unknown>,
  words: { add: string; remove: string },
  note?: string,
): Promise<CallToolResult> {
  const done: Change[] = [];
  const failed: Array<Change & { error: string }> = [];
  for (const change of changes) {
    try {
      await run(change);
      done.push(change);
    } catch (error) {
      if (!(error instanceof ForgejoError)) throw error;
      failed.push({ ...change, error: error.message });
    }
  }
  const lines = [heading, ''];
  if (failed.length && done.length) lines.push(`Partially done: ${done.length} of ${changes.length} changes succeeded.`, '');
  lines.push(
    bullets([
      [words.add, done.filter(c => c.action === 'add').map(c => c.target)],
      [words.remove, done.filter(c => c.action === 'remove').map(c => c.target)],
    ]),
  );
  if (failed.length) {
    lines.push(`- **Failed (${failed.length}):**`, ...failed.map(f => `  - ${f.action} ${f.target}: ${f.error}`));
  }
  if (note) lines.push('', note);
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return done.length ? textResult(text) : errorResult(`All ${changes.length} changes failed.\n\n${text}`);
}

// =============================================================================
// Organizations
// =============================================================================

export const listOrgs = defineTool({
  name: 'forgejo_list_orgs',
  title: 'List organizations',
  toolset: 'orgs',
  description:
    'List organizations: the ones you belong to (omit `username`), or the public organizations of another user. ' +
    'Use forgejo_get_org for details of one organization and forgejo_list_repos with owner=<org> for its repositories.',
  inputSchema: {
    username: z.string().trim().min(1).max(100).optional().describe('List this user\'s organizations. Omit for your own.'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ username, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const path = username ? `/users/${encodeURIComponent(username)}/orgs` : '/user/orgs';
    const result = await client.list<Json>(path, {}, { page, limit });
    const title = username ? `Organizations of ${username}` : 'Your organizations';
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              `## ${title}`,
              '',
              table(
                ['Organization', 'Full name', 'Visibility', 'Description'],
                result.items.map(o => [o.name ?? o.username, o.full_name, o.visibility, (o.description ?? '').slice(0, 80)]),
              ),
              '',
              pageFooter(result, 'organizations'),
            ].join('\n')
          : `${title}: none found.`,
      () => ({ organizations: result.items.map(projectOrg), ...pageMeta(result) }),
    );
  },
});

export const getOrg = defineTool({
  name: 'forgejo_get_org',
  title: 'Get organization details',
  toolset: 'orgs',
  description:
    'Get details of one organization: full name, description, website, location, email and visibility. ' +
    'Use forgejo_list_org_members and forgejo_list_teams for its people, and forgejo_list_repos with owner=<org> for its repositories.',
  inputSchema: { org: orgSchema(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ org, response_format }, ctx) {
    const client = ctx.getClient();
    const o = await client.get<Json>(`/orgs/${encodeURIComponent(org)}`);
    return formatResult(response_format, () => renderOrg(o, orgWebUrl(client, o)), () => projectOrg(o));
  },
});

export const createOrg = defineTool({
  name: 'forgejo_create_org',
  title: 'Create an organization',
  toolset: 'orgs',
  description:
    'Create a new organization owned by the authenticated user (who becomes a member of its Owners team). ' +
    'Afterwards, create teams with forgejo_create_team and repositories with forgejo_create_repo (owner=<org>). ' +
    'Some instances only let admins create organizations.',
  inputSchema: {
    name: z.string().trim().min(1).max(40).describe('Organization name, used in URLs (letters, digits, "-", "_" and ".")'),
    full_name: z.string().max(100).optional().describe('Display name'),
    description: z.string().max(255).optional().describe('Short description'),
    website: z.string().max(255).optional().describe('Website URL'),
    location: z.string().max(50).optional().describe('Location'),
    email: z.string().max(255).optional().describe('Public contact email'),
    visibility: visibilitySchema().optional(),
    repo_admin_change_team_access: z.boolean().optional().describe('Let repository admins add or remove team access to their repositories'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler({ name, response_format, ...fields }, ctx) {
    const client = ctx.getClient();
    const created = await client.post<Json>('/orgs', { username: name, ...fields });
    return formatResult(
      response_format,
      () => `Created organization **${created.name ?? created.username}**.\n\n${renderOrg(created, orgWebUrl(client, created))}`,
      () => projectOrg(created),
    );
  },
});

export const updateOrg = defineTool({
  name: 'forgejo_update_org',
  title: 'Update organization settings',
  toolset: 'orgs',
  description:
    'Change an organization\'s profile and settings: full name, description, website, location, email, visibility and whether ' +
    'repository admins can change team access. Only the fields you pass are changed. Requires organization owner rights.',
  inputSchema: {
    org: orgSchema(),
    full_name: z.string().max(100).optional().describe('Display name'),
    description: z.string().max(255).optional().describe('Short description (an empty string clears it)'),
    website: z.string().max(255).optional().describe('Website URL'),
    location: z.string().max(50).optional().describe('Location'),
    email: z.string().max(255).optional().describe('Public contact email'),
    visibility: visibilitySchema().optional(),
    repo_admin_change_team_access: z.boolean().optional().describe('Let repository admins add or remove team access to their repositories'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ org, response_format, ...fields }, ctx) {
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (!Object.keys(patch).length) {
      throw new ToolInputError('Nothing to change: pass at least one setting (full_name, description, website, location, email, visibility, ...).');
    }
    const client = ctx.getClient();
    const updated = await client.patch<Json>(`/orgs/${encodeURIComponent(org)}`, patch);
    return formatResult(
      response_format,
      () => `Updated organization **${updated.name ?? org}**.\n\n${renderOrg(updated, orgWebUrl(client, updated))}`,
      () => projectOrg(updated),
    );
  },
});

export const deleteOrg = defineTool({
  name: 'forgejo_delete_org',
  title: 'Delete an organization',
  toolset: 'orgs',
  description:
    'Permanently delete an organization. Forgejo refuses while it still owns repositories or packages (delete or transfer them first). ' +
    'This cannot be undone. As a safety check, `confirm_name` must repeat the organization name exactly; only call this after the user ' +
    'has explicitly confirmed which organization to delete.',
  inputSchema: {
    org: orgSchema('Organization to delete'),
    confirm_name: z.string().trim().min(1).max(100).describe('Must be exactly the same as `org`, to confirm the deletion'),
  },
  annotations: DESTRUCTIVE,
  async handler({ org, confirm_name }, ctx) {
    if (confirm_name !== org) {
      throw new ToolInputError(`confirm_name ("${confirm_name}") must exactly match org ("${org}"). Nothing was deleted.`);
    }
    const client = ctx.getClient();
    await client.delete(`/orgs/${encodeURIComponent(org)}`);
    return textResult(`Deleted organization **${org}**.`);
  },
});

// =============================================================================
// Members
// =============================================================================

export const listOrgMembers = defineTool({
  name: 'forgejo_list_org_members',
  title: 'List organization members',
  toolset: 'orgs',
  description:
    'List the members of an organization. If you are not a member yourself, only members who made their membership public are shown. ' +
    'Use forgejo_list_teams to see how members are grouped, and forgejo_update_team_members to change team membership.',
  inputSchema: { org: orgSchema(), ...pagination(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ org, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const result = await client.list<Json>(`/orgs/${encodeURIComponent(org)}/members`, {}, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              `## Members of ${org}`,
              '',
              table(
                ['Login', 'Name', 'Profile'],
                result.items.map(u => [u.login, u.full_name, u.html_url]),
              ),
              '',
              pageFooter(result, 'members'),
            ].join('\n')
          : `${org} has no members visible to you.`,
      () => ({ members: result.items.map(projectUser), ...pageMeta(result) }),
    );
  },
});

export const removeOrgMember = defineTool({
  name: 'forgejo_remove_org_member',
  title: 'Remove an organization member',
  toolset: 'orgs',
  description:
    'Remove a user from an organization: they leave every team in it and lose access to its private repositories. ' +
    'Requires organization owner rights. To only take someone out of one team, use forgejo_update_team_members instead.',
  inputSchema: {
    org: orgSchema(),
    username: z.string().trim().min(1).max(100).describe('User to remove'),
  },
  annotations: DESTRUCTIVE,
  async handler({ org, username }, ctx) {
    const client = ctx.getClient();
    await client.delete(`/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`);
    return textResult(`Removed **${username}** from organization ${org}.`);
  },
});

// =============================================================================
// Teams
// =============================================================================

export const listTeams = defineTool({
  name: 'forgejo_list_teams',
  title: 'List organization teams',
  toolset: 'orgs',
  description:
    'List the teams of an organization with their ID, permission level, repository units and whether they cover all repositories. ' +
    'Pass `query` to search team names (and descriptions). Team IDs and names are used by forgejo_update_team_members and ' +
    'forgejo_update_team_repos; create teams with forgejo_create_team.',
  inputSchema: {
    org: orgSchema(),
    query: z.string().trim().min(1).max(100).optional().describe('Only teams whose name (or description) contains this text'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ org, query, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const base = `/orgs/${encodeURIComponent(org)}/teams`;
    const result = query
      ? await client.list<Json>(`${base}/search`, { q: query, include_desc: true }, { page, limit, extract: b => (b as Json)?.data ?? [] })
      : await client.list<Json>(base, {}, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [`## Teams of ${org}${query ? ` matching "${query}"` : ''}`, '', renderTeamTable(result.items), '', pageFooter(result, 'teams')].join('\n')
          : `No teams found in ${org}${query ? ` matching "${query}"` : ''}.`,
      () => ({ teams: result.items.map(projectTeam), ...pageMeta(result) }),
    );
  },
});

export const createTeam = defineTool({
  name: 'forgejo_create_team',
  title: 'Create a team',
  toolset: 'orgs',
  description:
    'Create a team in an organization with a permission level ("read", "write" or "admin") applied to a set of repository units. ' +
    `By default the team gets that permission on ${DEFAULT_TEAM_UNITS.map(u => u.replace('repo.', '')).join(', ')}; ` +
    'pass `units` to choose others, or `units_map` for a different level per unit. Then add people with forgejo_update_team_members ' +
    'and (unless includes_all_repositories) repositories with forgejo_update_team_repos.',
  inputSchema: {
    org: orgSchema(),
    name: z.string().trim().min(1).max(255).describe('Team name, e.g. "developers"'),
    description: z.string().max(255).optional().describe('Short description'),
    permission: z
      .enum(['read', 'write', 'admin'])
      .default('read')
      .describe('Access level on the team\'s repositories (default "read"). "admin" grants full access to every unit and ignores units/units_map.'),
    units: z
      .array(z.string().trim().regex(/^repo\.[a-z_]+$/, 'Unit names look like "repo.code"'))
      .min(1)
      .max(20)
      .optional()
      .describe(
        'Repository units the permission applies to: repo.code, repo.issues, repo.pulls, repo.releases, repo.wiki, repo.projects, ' +
          'repo.packages, repo.actions, repo.ext_issues, repo.ext_wiki (default: all of these except the two ext_ ones)',
      ),
    units_map: z
      .record(z.enum(['none', 'read', 'write', 'admin']))
      .optional()
      .describe('Per-unit access instead of one level, e.g. {"repo.code": "read", "repo.issues": "write"}. Overrides permission and units.'),
    includes_all_repositories: z.boolean().default(false).describe('Give the team access to all current and future repositories of the organization'),
    can_create_org_repo: z.boolean().default(false).describe('Let team members create repositories in the organization'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler(args, ctx) {
    if (args.units_map && !Object.keys(args.units_map).length) throw new ToolInputError('units_map is empty; omit it or list at least one unit.');
    const units = args.units_map ? Object.keys(args.units_map) : (args.units ?? DEFAULT_TEAM_UNITS);
    // Newer Forgejo prefers units_map (units is deprecated), so send both: the per-unit map and the plain list.
    const unitsMap = args.units_map ?? Object.fromEntries(units.map(u => [u, args.permission]));
    const client = ctx.getClient();
    const created = await client.post<Json>(`/orgs/${encodeURIComponent(args.org)}/teams`, {
      name: args.name,
      description: args.description,
      permission: args.permission,
      units,
      units_map: unitsMap,
      includes_all_repositories: args.includes_all_repositories,
      can_create_org_repo: args.can_create_org_repo,
    });
    return formatResult(
      args.response_format,
      () => `Created team **${created.name}** in ${args.org}.\n\n${renderTeam(created)}`,
      () => projectTeam(created),
    );
  },
});

export const updateTeamMembers = defineTool({
  name: 'forgejo_update_team_members',
  title: 'Add or remove team members',
  toolset: 'orgs',
  description:
    'Add users to and/or remove users from an organization team (given by ID or name). Adding someone to a team also makes them ' +
    'a member of the organization. Each user is processed separately and the result lists what succeeded and what failed. ' +
    'Use forgejo_list_teams to find teams and forgejo_remove_org_member to remove someone from the whole organization.',
  inputSchema: {
    org: orgSchema('Organization that owns the team'),
    team: teamRefSchema(),
    add: nameListSchema('Usernames to add to the team'),
    remove: nameListSchema('Usernames to remove from the team'),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ org, team, add, remove }, ctx) {
    const changes = plannedChanges(add, remove, 'username');
    const client = ctx.getClient();
    const t = await resolveTeam(client, org, team);
    return applyChanges(
      `## Team ${t.name} (ID ${t.id}) in ${org}: members`,
      changes,
      c => {
        const path = `/teams/${t.id}/members/${encodeURIComponent(c.target)}`;
        return c.action === 'add' ? client.put(path) : client.delete(path);
      },
      { add: 'Added', remove: 'Removed' },
    );
  },
});

export const updateTeamRepos = defineTool({
  name: 'forgejo_update_team_repos',
  title: 'Add or remove team repositories',
  toolset: 'orgs',
  description:
    'Give an organization team access to repositories, or take it away (team by ID or name; repositories by name, all in the same ' +
    'organization). Each repository is processed separately and the result lists what succeeded and what failed. Not needed for ' +
    'teams created with includes_all_repositories. Use forgejo_list_teams to find teams.',
  inputSchema: {
    org: orgSchema('Organization that owns the team and the repositories'),
    team: teamRefSchema(),
    add: nameListSchema('Repository names to give the team access to (e.g. "website" or "acme/website")'),
    remove: nameListSchema('Repository names to remove from the team'),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ org, team, add, remove }, ctx) {
    // Accept "repo" or "org/repo"; repositories must belong to the team's organization.
    const bare = (names: string[] | undefined) =>
      names?.map(name => {
        const parts = name.split('/');
        if (parts.length === 1) return name;
        if (parts.length === 2 && parts[0].toLowerCase() === org.toLowerCase() && parts[1]) return parts[1];
        throw new ToolInputError(`"${name}" is not a repository of ${org}. Teams can only get access to their own organization's repositories.`);
      });
    const changes = plannedChanges(bare(add), bare(remove), 'repository');
    const client = ctx.getClient();
    const t = await resolveTeam(client, org, team);
    return applyChanges(
      `## Team ${t.name} (ID ${t.id}) in ${org}: repositories`,
      changes,
      c => {
        const path = `/teams/${t.id}/repos/${encodeURIComponent(org)}/${encodeURIComponent(c.target)}`;
        return c.action === 'add' ? client.put(path) : client.delete(path);
      },
      { add: 'Added', remove: 'Removed' },
      t.includesAll ? '_Note: this team already has access to all repositories of the organization (includes_all_repositories)._' : undefined,
    );
  },
});

export const orgTools = [
  listOrgs,
  getOrg,
  createOrg,
  updateOrg,
  deleteOrg,
  listOrgMembers,
  removeOrgMember,
  listTeams,
  createTeam,
  updateTeamMembers,
  updateTeamRepos,
];
