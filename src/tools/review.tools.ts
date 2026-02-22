/**
 * Pull Request Review Write Tools
 * (Create, Submit, Dismiss, Delete reviews; Request/Delete review requests)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgejoClient } from '../forgejo-client.js';

function splitCSV(s: string): string[] {
  return s.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
}

export function registerReviewTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'create_pull_review',
    'Create a pull request review with optional inline comments',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      body: z.string().optional().describe('Review body/message'),
      state: z.string().describe('Review state (APPROVED, REQUEST_CHANGES, COMMENT)'),
      comments: z.string().optional().describe('Inline comments as JSON array, e.g. [{"path":"file.go","body":"Fix this","new_position":10}]'),
    },
    async ({ owner, repo, index, body, state, comments }) => {
      const options: any = { event: state, body };
      if (comments) {
        try {
          options.comments = JSON.parse(comments);
        } catch {
          throw new Error('Invalid comments JSON format');
        }
      }
      const review = await client.createPullReview(owner, repo, index, options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: review }, null, 2) }],
      };
    },
  );

  server.tool(
    'submit_pull_review',
    'Submit a pending pull request review',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      id: z.number().describe('Review ID'),
      body: z.string().optional().describe('Review body/message'),
      state: z.string().describe('Review state (APPROVED, REQUEST_CHANGES, COMMENT)'),
    },
    async ({ owner, repo, index, id, body, state }) => {
      const review = await client.submitPullReview(owner, repo, index, id, { event: state, body });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: review }, null, 2) }],
      };
    },
  );

  server.tool(
    'dismiss_pull_review',
    'Dismiss a pull request review',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      id: z.number().describe('Review ID'),
      message: z.string().describe('Dismissal message'),
    },
    async ({ owner, repo, index, id, message }) => {
      await client.dismissPullReview(owner, repo, index, id, message);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: 'Review dismissed successfully' }) }],
      };
    },
  );

  server.tool(
    'delete_pull_review',
    'Delete a pending pull request review',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      id: z.number().describe('Review ID'),
    },
    async ({ owner, repo, index, id }) => {
      await client.deletePullReview(owner, repo, index, id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: 'Review deleted successfully' }) }],
      };
    },
  );

  server.tool(
    'create_review_requests',
    'Request reviews from specific users or teams',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      reviewers: z.string().optional().describe('Reviewer usernames (comma-separated)'),
      team_reviewers: z.string().optional().describe('Team reviewer names (comma-separated)'),
    },
    async ({ owner, repo, index, reviewers, team_reviewers }) => {
      const options: any = {};
      if (reviewers) options.reviewers = splitCSV(reviewers);
      if (team_reviewers) options.team_reviewers = splitCSV(team_reviewers);
      await client.createReviewRequests(owner, repo, index, options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: 'Review requests created successfully' }) }],
      };
    },
  );

  server.tool(
    'delete_review_requests',
    'Cancel pending review requests',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.number().describe('Pull request index number'),
      reviewers: z.string().optional().describe('Reviewer usernames (comma-separated)'),
      team_reviewers: z.string().optional().describe('Team reviewer names (comma-separated)'),
    },
    async ({ owner, repo, index, reviewers, team_reviewers }) => {
      const options: any = {};
      if (reviewers) options.reviewers = splitCSV(reviewers);
      if (team_reviewers) options.team_reviewers = splitCSV(team_reviewers);
      await client.deleteReviewRequests(owner, repo, index, options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: 'Review requests deleted successfully' }) }],
      };
    },
  );
}
