/**
 * Forgejo MCP Server - HTTP Entry Point
 * 
 * Express server with Streamable HTTP transport for VPS deployment.
 * Supports per-request credentials via URL query parameters.
 */

import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ForgejoClient } from './forgejo-client.js';
import { registerAllTools } from './tools/register.js';
import { initFirebase, trackEvent, getAnalyticsSummary } from './firebase-analytics.js';

const VERSION = '3.0.0';
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Initialize Firebase analytics (optional)
initFirebase();

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================================
// Health Check
// ============================================================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    server: 'Forgejo MCP Server',
    version: VERSION,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ============================================================================
// Analytics Endpoint
// ============================================================================

app.get('/analytics', async (_req: Request, res: Response) => {
  const summary = await getAnalyticsSummary();
  res.json(summary);
});

// ============================================================================
// MCP Endpoint - Streamable HTTP Transport
// ============================================================================

// Session management
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

function createSession(forgejoUrl: string, forgejoToken: string): { transport: StreamableHTTPServerTransport; server: McpServer } {
  const client = new ForgejoClient({ url: forgejoUrl, token: forgejoToken });

  const server = new McpServer({
    name: 'Forgejo MCP Server',
    version: VERSION,
  });

  registerAllTools(server, client);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `forgejo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    onsessioninitialized: (sessionId: string) => {
      sessions.set(sessionId, { transport, server });
      console.log(`[Session] New session: ${sessionId}`);
      trackEvent('session_start', { sessionId });
    },
  });

  server.connect(transport).catch((err: Error) => {
    console.error('[MCP] Failed to connect transport:', err);
  });

  return { transport, server };
}

function resolveCredentials(req: Request): { url: string; token: string } {
  // Priority: query params > env vars
  const url = (req.query.url as string) || process.env.FORGEJO_URL || '';
  const token = (req.query.token as string) || process.env.FORGEJO_ACCESS_TOKEN || '';

  if (!url) throw new Error('Forgejo URL is required. Set FORGEJO_URL env var or pass ?url= query parameter.');
  if (!token) throw new Error('Forgejo access token is required. Set FORGEJO_ACCESS_TOKEN env var or pass ?token= query parameter.');

  return { url, token };
}

// POST /mcp - Main MCP endpoint
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Existing session
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
    } else {
      // New session
      const { url, token } = resolveCredentials(req);
      const { transport } = createSession(url, token);
      await transport.handleRequest(req, res, req.body);
    }
  } catch (err: any) {
    console.error('[MCP] Error handling request:', err);
    if (!res.headersSent) {
      res.status(400).json({ error: err.message || 'Internal server error' });
    }
  }
});

// GET /mcp - SSE stream for notifications
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }

  const session = sessions.get(sessionId)!;
  await session.transport.handleRequest(req, res);
});

// DELETE /mcp - Terminate session
app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
    sessions.delete(sessionId);
    console.log(`[Session] Terminated: ${sessionId}`);
    trackEvent('session_end', { sessionId });
  } else {
    res.status(400).json({ error: 'Invalid or missing session ID' });
  }
});

// ============================================================================
// Start Server
// ============================================================================

app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Forgejo MCP Server v${VERSION}`);
  console.log(`   HTTP endpoint: http://${HOST}:${PORT}/mcp`);
  console.log(`   Health check:  http://${HOST}:${PORT}/health`);
  console.log(`   Analytics:     http://${HOST}:${PORT}/analytics`);
  console.log(`   Transport:     Streamable HTTP`);

  if (process.env.FORGEJO_URL) {
    console.log(`   Forgejo URL:   ${process.env.FORGEJO_URL}`);
  } else {
    console.log(`   Forgejo URL:   (per-request via ?url= query param)`);
  }

  console.log('');
  trackEvent('server_start', { version: VERSION, port: PORT });
});
