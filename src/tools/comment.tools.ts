/**
 * Issue/PR Comment Tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgejoClient } from '../forgejo-client.js';

export function registerCommentTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'list_issue_comments',
    'List comments on an issue or pull request',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Issue/PR index number'),
      since: z.string().optional().describe('Only show comments updated after this time (RFC3339)'),
      before: z.string().optional().describe('Only show comments updated before this time (RFC3339)'),
      page: z.number().default(1).describe('Page number (1-based)'),
      limit: z.number().default(20).describe('Page size'),
    },
    async ({ owner, repo, index, since, before, page, limit }) => {
      const params: any = { page, limit };
      if (since) params.since = since;
      if (before) params.before = before;
      const comments = await client.listIssueComments(owner, repo, index, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: comments }, null, 2) }],
      };
    },
  );

  server.tool(
    'get_issue_comment',
    'Get a specific comment by its ID',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      comment_id: z.number().describe('Comment ID'),
    },
    async ({ owner, repo, comment_id }) => {
      const comment = await client.getIssueComment(owner, repo, comment_id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: comment }, null, 2) }],
      };
    },
  );

  server.tool(
    'create_issue_comment',
    'Add a comment to an issue or pull request',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Issue/PR index number'),
      body: z.string().describe('Comment body'),
    },
    async ({ owner, repo, index, body }) => {
      const comment = await client.createIssueComment(owner, repo, index, body);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: comment }, null, 2) }],
      };
    },
  );

  server.tool(
    'edit_issue_comment',
    'Edit an existing comment',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      comment_id: z.number().describe('Comment ID'),
      body: z.string().describe('New comment body'),
    },
    async ({ owner, repo, comment_id, body }) => {
      const comment = await client.editIssueComment(owner, repo, comment_id, body);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: comment }, null, 2) }],
      };
    },
  );

  server.tool(
    'delete_issue_comment',
    'Delete a comment from an issue or pull request',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      comment_id: z.number().describe('Comment ID'),
    },
    async ({ owner, repo, comment_id }) => {
      await client.deleteIssueComment(owner, repo, comment_id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: 'Comment deleted successfully' }) }],
      };
    },
  );
}
