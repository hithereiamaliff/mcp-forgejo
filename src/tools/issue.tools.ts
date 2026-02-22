/**
 * Issue Tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgejoClient } from '../forgejo-client.js';

export function registerIssueTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'get_issue_by_index',
    'Get a specific issue by its index number',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Issue index number'),
    },
    async ({ owner, repo, index }) => {
      const issue = await client.getIssue(owner, repo, index);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: issue }, null, 2) }],
      };
    },
  );

  server.tool(
    'list_repo_issues',
    'List issues in a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      state: z.string().default('open').describe('State filter (open|closed|all)'),
      type: z.string().optional().describe('Type filter (issues|pulls)'),
      milestones: z.string().optional().describe('Milestone names/IDs (comma-separated)'),
      labels: z.string().optional().describe('Labels (comma-separated)'),
      page: z.number().default(1).describe('Page number (1-based)'),
      limit: z.number().default(20).describe('Page size'),
    },
    async ({ owner, repo, state, type: issueType, milestones, labels, page, limit }) => {
      const params: any = { state, page, limit };
      if (issueType) params.type = issueType;
      if (milestones) params.milestones = milestones;
      if (labels) params.labels = labels;
      const issues = await client.listIssues(owner, repo, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: issues }, null, 2) }],
      };
    },
  );

  server.tool(
    'create_issue',
    'Create a new issue in a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      title: z.string().describe('Issue title'),
      body: z.string().optional().describe('Issue body'),
    },
    async ({ owner, repo, title, body }) => {
      const issue = await client.createIssue(owner, repo, { title, body });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: issue }, null, 2) }],
      };
    },
  );

  server.tool(
    'update_issue',
    'Update an existing issue',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Issue index number'),
      title: z.string().optional().describe('New title'),
      body: z.string().optional().describe('New body'),
      assignee: z.string().optional().describe('Assignee username'),
      milestone: z.string().optional().describe('Milestone ID'),
    },
    async ({ owner, repo, index, title, body, assignee, milestone }) => {
      const options: any = {};
      if (title) options.title = title;
      if (body) options.body = body;
      if (assignee) options.assignee = assignee;
      if (milestone) options.milestone = parseInt(milestone, 10);
      const issue = await client.editIssue(owner, repo, index, options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: issue }, null, 2) }],
      };
    },
  );

  server.tool(
    'add_issue_labels',
    'Add labels to an issue',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Issue index number'),
      labels: z.string().describe('Label IDs (comma-separated numeric IDs)'),
    },
    async ({ owner, repo, index, labels }) => {
      const labelIds = labels.split(',').map((l: string) => parseInt(l.trim(), 10));
      await client.addIssueLabels(owner, repo, index, labelIds);
      const issue = await client.getIssue(owner, repo, index);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: issue }, null, 2) }],
      };
    },
  );

  server.tool(
    'issue_state_change',
    'Change the state of an issue (open or close)',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Issue index number'),
      state: z.string().describe('New state (open|closed)'),
    },
    async ({ owner, repo, index, state }) => {
      if (state !== 'open' && state !== 'closed') {
        throw new Error(`Invalid state: ${state}. Must be 'open' or 'closed'`);
      }
      const issue = await client.editIssue(owner, repo, index, { state });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: issue }, null, 2) }],
      };
    },
  );
}
