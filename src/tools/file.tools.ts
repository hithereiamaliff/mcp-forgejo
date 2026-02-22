/**
 * File Tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ForgejoClient } from '../forgejo-client.js';

export function registerFileTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'get_file_content',
    'Get the content of a file from a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      filePath: z.string().describe('File path'),
      ref: z.string().optional().describe('Ref (branch/tag/commit)'),
    },
    async ({ owner, repo, filePath, ref }) => {
      const content = await client.getFileContent(owner, repo, filePath, ref);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: content }, null, 2) }],
      };
    },
  );

  server.tool(
    'create_file',
    'Create a new file in a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      filePath: z.string().describe('File path'),
      content: z.string().describe('Content (plain text, will be base64-encoded automatically)'),
      message: z.string().describe('Commit message'),
      branch_name: z.string().describe('Branch name'),
      new_branch_name: z.string().optional().describe('New branch name (creates branch if provided)'),
    },
    async ({ owner, repo, filePath, content: fileContent, message, branch_name, new_branch_name }) => {
      const options: any = {
        content: Buffer.from(fileContent).toString('base64'),
        message,
        branch: branch_name,
      };
      if (new_branch_name) options.new_branch = new_branch_name;
      const result = await client.createFile(owner, repo, filePath, options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: result }, null, 2) }],
      };
    },
  );

  server.tool(
    'update_file',
    'Update an existing file in a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      filePath: z.string().describe('File path'),
      content: z.string().describe('Content (plain text, will be base64-encoded automatically)'),
      message: z.string().describe('Commit message'),
      branch_name: z.string().describe('Branch name'),
      sha: z.string().describe('SHA of the file being replaced'),
      new_branch_name: z.string().optional().describe('New branch name'),
    },
    async ({ owner, repo, filePath, content: fileContent, message, branch_name, sha, new_branch_name }) => {
      const options: any = {
        content: Buffer.from(fileContent).toString('base64'),
        message,
        branch: branch_name,
        sha,
      };
      if (new_branch_name) options.new_branch = new_branch_name;
      const result = await client.updateFile(owner, repo, filePath, options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: result }, null, 2) }],
      };
    },
  );

  server.tool(
    'delete_file',
    'Delete a file from a repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      filePath: z.string().describe('File path'),
      message: z.string().describe('Commit message'),
      branch_name: z.string().describe('Branch name'),
      sha: z.string().describe('SHA of the file being deleted'),
      new_branch_name: z.string().optional().describe('New branch name'),
    },
    async ({ owner, repo, filePath, message, branch_name, sha, new_branch_name }) => {
      const options: any = {
        message,
        branch: branch_name,
        sha,
      };
      if (new_branch_name) options.new_branch = new_branch_name;
      await client.deleteFile(owner, repo, filePath, options);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: 'File deleted successfully' }) }],
      };
    },
  );
}
