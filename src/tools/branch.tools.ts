/**
 * Branch Tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgejoClient } from '../forgejo-client.js';

export function registerBranchTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'list_branches',
    'List all branches in a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      page: z.number().min(1).default(1).describe('Page number (1-based)'),
      limit: z.number().min(1).default(100).describe('Page size'),
    },
    async ({ owner, repo, page, limit }) => {
      const branches = await client.listBranches(owner, repo, page, limit);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: branches }, null, 2) }],
      };
    },
  );

  server.tool(
    'create_branch',
    'Create a new branch in a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      branch: z.string().describe('New branch name'),
      old_branch: z.string().describe('Source branch name'),
    },
    async ({ owner, repo, branch, old_branch }) => {
      await client.createBranch(owner, repo, {
        new_branch_name: branch,
        old_branch_name: old_branch,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: 'Branch created successfully' }) }],
      };
    },
  );

  server.tool(
    'delete_branch',
    'Delete a branch from a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      branch: z.string().describe('Branch name to delete'),
    },
    async ({ owner, repo, branch }) => {
      await client.deleteBranch(owner, repo, branch);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: 'Branch deleted successfully' }) }],
      };
    },
  );
}
