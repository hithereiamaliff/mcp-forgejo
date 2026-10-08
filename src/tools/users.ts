/**
 * users toolset: user profiles and user search.
 */

import { z } from 'zod';
import { projectUser, type Json } from '../forgejo/projections.js';
import { bullets, fmtDate, table } from '../utils/format.js';
import { READ_ONLY, defineTool, formatResult, pageFooter, pageMeta, pagination, responseFormatSchema } from './shared.js';

function renderUser(u: Json): string {
  const p = projectUser(u);
  return [
    `## ${p.login}${p.full_name ? ` (${p.full_name})` : ''}`,
    '',
    bullets([
      ['ID', p.id],
      ['Email', p.email],
      ['Site admin', p.is_admin ? 'yes' : undefined],
      ['Bio', p.description],
      ['Website', p.website],
      ['Location', p.location],
      ['Visibility', p.visibility],
      ['Followers / following', p.followers !== undefined ? `${p.followers} / ${p.following ?? 0}` : undefined],
      ['Starred repos', p.starred_repos],
      ['Joined', fmtDate(p.created)],
      ['Last login', fmtDate(p.last_login)],
      ['Profile', p.html_url],
    ]),
  ].join('\n');
}

export const getUser = defineTool({
  name: 'forgejo_get_user',
  title: 'Get a user profile',
  toolset: 'users',
  description:
    'Get a Forgejo user profile. Omit `username` to get the authenticated user (needs the read:user token scope). ' +
    'Use forgejo_list_repos with owner=<username> to see their repositories.',
  inputSchema: {
    username: z.string().trim().min(1).max(100).optional().describe('User name. Omit for the authenticated user.'),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ username, response_format }, ctx) {
    const client = ctx.getClient();
    const user = await client.get<Json>(username ? `/users/${encodeURIComponent(username)}` : '/user');
    return formatResult(response_format, () => renderUser(user), () => projectUser(user));
  },
});

export const searchUsers = defineTool({
  name: 'forgejo_search_users',
  title: 'Search users',
  toolset: 'users',
  description: 'Search users on the Forgejo instance by user name or full name. Returns login, name and profile link for each match.',
  inputSchema: {
    query: z.string().trim().min(1).max(100).describe('Text to search for in user names and full names'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ query, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const result = await client.list<Json>('/users/search', { q: query }, { page, limit, extract: b => (b as Json)?.data ?? [] });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              `## Users matching "${query}"`,
              '',
              table(
                ['Login', 'Name', 'Profile'],
                result.items.map(u => [u.login, u.full_name, u.html_url]),
              ),
              '',
              pageFooter(result, 'users'),
            ].join('\n')
          : `No users match "${query}".`,
      () => ({ users: result.items.map(projectUser), ...pageMeta(result) }),
    );
  },
});

export const userTools = [getUser, searchUsers];
