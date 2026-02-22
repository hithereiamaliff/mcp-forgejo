/**
 * Tool Registration
 * 
 * Registers all Forgejo MCP tools with the MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ForgejoClient } from '../forgejo-client.js';
import { registerUserTools } from './user.tools.js';
import { registerRepoTools } from './repo.tools.js';
import { registerBranchTools } from './branch.tools.js';
import { registerFileTools } from './file.tools.js';
import { registerCommitTools } from './commit.tools.js';
import { registerIssueTools } from './issue.tools.js';
import { registerCommentTools } from './comment.tools.js';
import { registerPullTools } from './pull.tools.js';
import { registerReviewTools } from './review.tools.js';
import { registerSearchTools } from './search.tools.js';
import { registerActionsTools } from './actions.tools.js';

export function registerAllTools(server: McpServer, client: ForgejoClient): void {
  registerUserTools(server, client);
  registerRepoTools(server, client);
  registerBranchTools(server, client);
  registerFileTools(server, client);
  registerCommitTools(server, client);
  registerIssueTools(server, client);
  registerCommentTools(server, client);
  registerPullTools(server, client);
  registerReviewTools(server, client);
  registerSearchTools(server, client);
  registerActionsTools(server, client);

  // Hello / version tool
  server.tool(
    'hello',
    'A simple test tool to verify that the MCP server is working correctly',
    {},
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          message: 'Hello from Forgejo MCP Server!',
          version: '3.0.0',
          timestamp: new Date().toISOString(),
          forgejoUrl: client.getBaseUrl(),
          transport: 'streamable-http',
        }, null, 2),
      }],
    }),
  );
}
