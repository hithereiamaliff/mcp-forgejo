/**
 * Actions / Workflow Tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgejoClient } from '../forgejo-client.js';

export function registerActionsTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'dispatch_workflow',
    'Trigger a workflow run via workflow_dispatch event',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      workflow: z.string().describe('Workflow file or ID (e.g. main.yml)'),
      ref: z.string().describe('Git ref (branch/tag/commit)'),
      inputs: z.string().optional().describe('Workflow inputs as JSON object (e.g. {"key": "value"})'),
    },
    async ({ owner, repo, workflow, ref, inputs }) => {
      const options: any = { ref };
      if (inputs) {
        try {
          options.inputs = JSON.parse(inputs);
        } catch {
          throw new Error('Invalid inputs JSON format. Expected: {"key": "value"}');
        }
      }
      await client.dispatchWorkflow(owner, repo, workflow, options);
      const result = `Workflow dispatched successfully!\n  Workflow: ${workflow}\n  Ref: ${ref}\n  URL: ${client.getBaseUrl()}/${owner}/${repo}/actions`;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: result }) }],
      };
    },
  );

  server.tool(
    'list_workflow_runs',
    'List workflow runs for a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      status: z.string().optional().describe('Filter by status (waiting, running, success, failure, cancelled)'),
      event: z.string().optional().describe('Filter by event type (push, pull_request, workflow_dispatch)'),
      run_number: z.number().optional().describe('Filter by run number'),
      head_sha: z.string().optional().describe('Filter by HEAD SHA'),
      page: z.number().default(1).describe('Page number (1-based)'),
      limit: z.number().default(30).describe('Page size'),
    },
    async ({ owner, repo, status, event, run_number, head_sha, page, limit }) => {
      const params: any = { page, limit };
      if (status) params.status = status;
      if (event) params.event = event;
      if (run_number) params.run_number = run_number;
      if (head_sha) params.head_sha = head_sha;
      const result = await client.listWorkflowRuns(owner, repo, params);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: result }, null, 2) }],
      };
    },
  );

  server.tool(
    'get_workflow_run',
    'Get details of a specific workflow run by ID',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      run_id: z.number().describe('Workflow run ID'),
    },
    async ({ owner, repo, run_id }) => {
      const run = await client.getWorkflowRun(owner, repo, run_id);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: run }, null, 2) }],
      };
    },
  );
}
