/**
 * Repository Tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgejoClient } from '../forgejo-client.js';

export function registerRepoTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'list_my_repos',
    'List all repositories owned by the authenticated user',
    {
      page: z.number().min(1).default(1).describe('Page number (1-based)'),
      limit: z.number().min(1).default(100).describe('Page size'),
    },
    async ({ page, limit }) => {
      const repos = await client.listMyRepos(page, limit);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: repos }, null, 2) }],
      };
    },
  );

  server.tool(
    'create_repo',
    'Create a new repository',
    {
      name: z.string().describe('Repository name'),
      description: z.string().optional().describe('Description'),
      owner: z.string().optional().describe('Owner/org name (creates under org if provided)'),
      private: z.boolean().optional().describe('Private repository'),
      auto_init: z.boolean().optional().describe('Auto-initialize with README'),
      gitignores: z.string().optional().describe('Gitignore templates'),
      license: z.string().optional().describe('License template'),
      readme: z.string().optional().describe('README template'),
      default_branch: z.string().optional().describe('Default branch name'),
    },
    async (args) => {
      const { owner, ...options } = args;
      const repo = owner
        ? await client.createOrgRepo(owner, options)
        : await client.createRepo(options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: repo }, null, 2) }],
      };
    },
  );

  server.tool(
    'fork_repo',
    'Fork a repository',
    {
      user: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      organization: z.string().optional().describe('Organization to fork to'),
      name: z.string().optional().describe('Name for the fork'),
    },
    async ({ user, repo, organization, name }) => {
      const options: any = {};
      if (organization) options.organization = organization;
      if (name) options.name = name;
      const result = await client.forkRepo(user, repo, options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: result }, null, 2) }],
      };
    },
  );
}
