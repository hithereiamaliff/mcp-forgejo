#!/usr/bin/env node

/**
 * Forgejo MCP Server - local stdio entry point.
 *
 * Usage (e.g. in Claude Desktop / Claude Code / Cursor config):
 *   command: npx, args: ["-y", "github:hithereiamaliff/mcp-forgejo"]
 *   env: {
 *     "FORGEJO_URL": "https://git.example.com",
 *     "FORGEJO_ACCESS_TOKEN": "...",
 *     "FORGEJO_TOOLSETS": "default,actions",   // optional
 *     "FORGEJO_READ_ONLY": "false"              // optional
 *   }
 *
 * The server runs on your own machine here, so localhost/LAN and http://
 * instances are allowed (the hosted HTTP server blocks them).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createForgejoServer, selectTools } from './index.js';
import { PERMISSIVE_POLICY, numberFromEnv, parseBoolean, parseToolsets } from './config.js';
import { SERVER_VERSION } from './version.js';

async function main(): Promise<void> {
  // stdout is reserved for the MCP protocol, so all logging goes to stderr.
  const url = process.env.FORGEJO_URL?.trim() || undefined;
  const token = (process.env.FORGEJO_ACCESS_TOKEN || process.env.FORGEJO_TOKEN || '').trim() || undefined;

  let toolsets;
  try {
    toolsets = parseToolsets(process.env.FORGEJO_TOOLSETS);
  } catch (error) {
    console.error(`FORGEJO_TOOLSETS: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const readOnly = parseBoolean(process.env.FORGEJO_READ_ONLY, false);

  if (!url) console.error('Warning: FORGEJO_URL is not set. Tools will return an error until it is configured.');
  if (url && !token) console.error('Warning: FORGEJO_ACCESS_TOKEN is not set. Only public data will be visible.');

  const server = createForgejoServer({
    credentials: { url, token },
    transport: 'stdio',
    authMode: 'local CLI (FORGEJO_URL + FORGEJO_ACCESS_TOKEN)',
    toolsets,
    readOnly,
    policy: PERMISSIVE_POLICY,
    timeoutMs: numberFromEnv(process.env.FORGEJO_TIMEOUT_MS, 30_000, 1000),
    maxResponseBytes: numberFromEnv(process.env.FORGEJO_MAX_RESPONSE_MB, 50) * 1024 * 1024,
    credentialHint: 'Then update FORGEJO_ACCESS_TOKEN and restart the server.',
    setupHint: 'Set the FORGEJO_URL and FORGEJO_ACCESS_TOKEN environment variables and restart the server.',
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Forgejo MCP Server v${SERVER_VERSION} running on stdio (${url ?? 'no instance configured'}; ` +
      `${selectTools(toolsets, readOnly).length} tools; toolsets: ${[...toolsets].join(', ')}${readOnly ? '; read-only' : ''})`,
  );

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
