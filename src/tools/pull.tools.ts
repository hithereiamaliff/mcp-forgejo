/**
 * Pull Request Tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgejoClient } from '../forgejo-client.js';

export function registerPullTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'get_pull_request_by_index',
    'Get a specific pull request by its index number',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
    },
    async ({ owner, repo, index }) => {
      const pr = await client.getPullRequest(owner, repo, index);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: pr }, null, 2) }],
      };
    },
  );

  server.tool(
    'list_repo_pull_requests',
    'List pull requests in a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      state: z.string().default('open').describe('State filter (open|closed|all)'),
      sort: z.string().optional().describe('Sort order (oldest|recentupdate|leastupdate|mostcomment)'),
      milestone: z.string().optional().describe('Milestone ID'),
      labels: z.string().optional().describe('Label IDs (comma-separated)'),
      page: z.number().default(1).describe('Page number (1-based)'),
      limit: z.number().default(20).describe('Page size'),
    },
    async ({ owner, repo, state, sort, milestone, labels, page, limit }) => {
      const params: any = { state, page, limit };
      if (sort) params.sort = sort;
      if (milestone) params.milestone = milestone;
      if (labels) params.labels = labels;
      const prs = await client.listPullRequests(owner, repo, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: prs }, null, 2) }],
      };
    },
  );

  server.tool(
    'create_pull_request',
    'Create a new pull request',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      head: z.string().describe('Head branch (source)'),
      base: z.string().describe('Base branch (target)'),
      title: z.string().describe('Pull request title'),
      body: z.string().optional().describe('Pull request body'),
    },
    async ({ owner, repo, head, base, title, body }) => {
      const pr = await client.createPullRequest(owner, repo, { head, base, title, body });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: pr }, null, 2) }],
      };
    },
  );

  server.tool(
    'update_pull_request',
    'Update an existing pull request',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      title: z.string().optional().describe('New title'),
      body: z.string().optional().describe('New body'),
      base: z.string().optional().describe('New base branch'),
      assignee: z.string().optional().describe('Assignee username'),
      milestone: z.string().optional().describe('Milestone ID'),
    },
    async ({ owner, repo, index, title, body, base, assignee, milestone }) => {
      const options: any = {};
      if (title) options.title = title;
      if (body) options.body = body;
      if (base) options.base = base;
      if (assignee) options.assignee = assignee;
      if (milestone) options.milestone = parseInt(milestone, 10);
      const pr = await client.editPullRequest(owner, repo, index, options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: pr }, null, 2) }],
      };
    },
  );

  server.tool(
    'merge_pull_request',
    'Merge a pull request',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      style: z.string().describe('Merge style (merge, rebase, rebase-merge, squash)'),
      title: z.string().optional().describe('Merge commit title'),
      message: z.string().optional().describe('Merge commit message'),
      delete_branch_after_merge: z.boolean().optional().describe('Delete head branch after merge'),
      force_merge: z.boolean().optional().describe('Force merge even if checks have not passed'),
      merge_when_checks_succeed: z.boolean().optional().describe('Schedule merge for when all checks succeed'),
    },
    async ({ owner, repo, index, style, title, message, delete_branch_after_merge, force_merge, merge_when_checks_succeed }) => {
      const options: any = { Do: style };
      if (title) options.MergeTitleField = title;
      if (message) options.MergeMessageField = message;
      if (delete_branch_after_merge) options.delete_branch_after_merge = delete_branch_after_merge;
      if (force_merge) options.force_merge = force_merge;
      if (merge_when_checks_succeed) options.merge_when_checks_succeed = merge_when_checks_succeed;
      await client.mergePullRequest(owner, repo, index, options);
      const result = merge_when_checks_succeed
        ? 'Pull request scheduled to merge when all checks succeed'
        : 'Pull request merged successfully';
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: result }) }],
      };
    },
  );

  server.tool(
    'list_pull_reviews',
    'List reviews for a pull request',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      page: z.number().default(1).describe('Page number (1-based)'),
      limit: z.number().default(20).describe('Page size'),
    },
    async ({ owner, repo, index, page, limit }) => {
      const reviews = await client.listPullReviews(owner, repo, index, { page, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: reviews }, null, 2) }],
      };
    },
  );

  server.tool(
    'get_pull_review',
    'Get a specific pull request review',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      id: z.number().describe('Review ID'),
    },
    async ({ owner, repo, index, id }) => {
      const review = await client.getPullReview(owner, repo, index, id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: review }, null, 2) }],
      };
    },
  );

  server.tool(
    'list_pull_review_comments',
    'List comments on a pull request review',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      id: z.number().describe('Review ID'),
    },
    async ({ owner, repo, index, id }) => {
      const comments = await client.listPullReviewComments(owner, repo, index, id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: comments }, null, 2) }],
      };
    },
  );
}
