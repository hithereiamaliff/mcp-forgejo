/**
 * User Tools
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ForgejoClient } from '../forgejo-client.js';

export function registerUserTools(server: McpServer, client: ForgejoClient): void {
  server.tool(
    'get_my_user_info',
    'Get information about the authenticated user',
    {},
    async () => {
      const user = await client.getMyUserInfo();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ Result: user }, null, 2) }],
      };
    },
  );
}
