/**
 * Commit Tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgejoClient } from '../forgejo-client.js';

export function registerCommitTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'list_repo_commits',
    'List commits in a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      path: z.string().optional().describe('File/dir path to filter by'),
      sha: z.string().optional().describe('SHA/branch to start from'),
      page: z.number().min(1).default(1).describe('Page number (1-based)'),
      limit: z.number().min(1).default(100).describe('Page size'),
    },
    async ({ owner, repo, path, sha, page, limit }) => {
      const commits = await client.listCommits(owner, repo, { sha, path, page, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: commits }, null, 2) }],
      };
    },
  );
}
