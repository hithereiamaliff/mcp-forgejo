/**
 * Search Tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgejoClient } from '../forgejo-client.js';

export function registerSearchTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'search_users',
    'Search for users on the Forgejo instance',
    {
      keyword: z.string().optional().describe('Search keyword'),
      page: z.number().default(1).describe('Page number (1-based)'),
      limit: z.number().default(100).describe('Page size'),
    },
    async ({ keyword, page, limit }) => {
      const result = await client.searchUsers(keyword || '', page, limit);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: result }, null, 2) }],
      };
    },
  );

  server.tool(
    'search_repos',
    'Search for repositories on the Forgejo instance',
    {
      keyword: z.string().optional().describe('Search keyword'),
      sort: z.string().default('updated').describe('Sort order'),
      order: z.string().default('desc').describe('Order direction (asc|desc)'),
      page: z.number().default(1).describe('Page number (1-based)'),
      limit: z.number().default(100).describe('Page size'),
    },
    async ({ keyword, sort, order, page, limit }) => {
      const result = await client.searchRepos(keyword || '', { sort, order, page, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: result }, null, 2) }],
      };
    },
  );

  server.tool(
    'search_org_teams',
    'Search for teams in an organization',
    {
      org: z.string().describe('Organization name'),
      keyword: z.string().optional().describe('Search keyword'),
      page: z.number().default(1).describe('Page number (1-based)'),
      limit: z.number().default(100).describe('Page size'),
    },
    async ({ org, keyword, page, limit }) => {
      const result = await client.searchOrgTeams(org, keyword, page, limit);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: result }, null, 2) }],
      };
    },
  );
}
