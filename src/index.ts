/**
 * Forgejo MCP Server - Main Entry Point
 * 
 * Registers all Forgejo tools and starts the MCP server using stdio transport.
 * For HTTP/VPS deployment, use http-server.ts instead.
 */

import dotenv from 'dotenv';
dotenv.config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ForgejoClient } from './forgejo-client.js';
import { registerAllTools } from './tools/register.js';

const VERSION = '3.0.0';

// Resolve config from environment
const FORGEJO_URL = process.env.FORGEJO_URL || '';
const FORGEJO_TOKEN = process.env.FORGEJO_ACCESS_TOKEN || '';

if (!FORGEJO_URL) {
  console.error('Error: FORGEJO_URL environment variable is required');
  process.exit(1);
}
if (!FORGEJO_TOKEN) {
  console.error('Error: FORGEJO_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

// Create Forgejo client
const client = new ForgejoClient({ url: FORGEJO_URL, token: FORGEJO_TOKEN });

// Create MCP server
const server = new McpServer({
  name: 'Forgejo MCP Server',
  version: VERSION,
});

// Register all tools
registerAllTools(server, client);

// Start stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Forgejo MCP Server v${VERSION} running on stdio`);
  console.error(`Connected to: ${FORGEJO_URL}`);
}

main().catch((err) => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
