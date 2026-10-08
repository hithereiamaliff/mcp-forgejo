#!/usr/bin/env node

/**
 * Forgejo MCP Server - Streamable HTTP entry point (VPS / Docker).
 *
 * Follows the TechMavie MCP pattern (mcp-zerobounce v2 / mcp-github v2):
 *   - A brand-new McpServer + transport for EVERY request (stateless), so one
 *     caller's Forgejo token can never leak into another caller's request.
 *   - Ways to authenticate:
 *       hosted       /mcp/usr_xxx, Authorization: Bearer usr_xxx, X-API-Key: usr_xxx
 *                    or /mcp?api_key=usr_xxx  → resolved via mcp-key-service
 *       self-hosted  X-API-Key: <MCP_API_KEY> + X-Forgejo-Url + X-Forgejo-Token
 *                    (falling back to the server's FORGEJO_URL / FORGEJO_ACCESS_TOKEN)
 *   - Per-request tool selection: ?toolsets=default,actions&read_only=true
 *     (or the X-Forgejo-Toolsets / X-Forgejo-Read-Only headers).
 *   - Outbound requests to user-supplied instance URLs go through an SSRF guard.
 *
 * Usage:
 *   npm run build && node dist/http-server.js
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ALL_TOOLS, SERVER_NAME, SERVER_VERSION, createForgejoServer, describeTool } from './index.js';
import {
  ConfigError,
  DEFAULT_TOOLSETS,
  networkPolicyFromEnv,
  numberFromEnv,
  parseBoolean,
  parseToolsets,
  type Toolset,
} from './config.js';
import { KeyServiceClient } from './utils/key-service.js';
import { Analytics, dashboardHtml } from './utils/analytics.js';
import { safeEqual, sanitizeUrlForLogs } from './utils/security.js';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MCP_API_KEY = process.env.MCP_API_KEY || '';
const MCP_PROTOCOL_VERSION = process.env.MCP_PROTOCOL_VERSION || '2025-11-25';
const ENABLE_MCP_DIAGNOSTICS = process.env.ENABLE_MCP_DIAGNOSTICS === 'true';
const MCP_TRACE_HTTP = process.env.MCP_TRACE_HTTP === 'true';
const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || '';
const KEY_SERVICE_TOKEN = process.env.KEY_SERVICE_TOKEN || '';
const KEY_SERVICE_SERVER_ID = process.env.KEY_SERVICE_SERVER_ID || 'forgejo';
const ANALYTICS_DIR = process.env.ANALYTICS_DIR || '/app/data';
const PUBLIC_BASE_PATH = normalizePublicBasePath(process.env.PUBLIC_BASE_PATH || '');
const KEY_PORTAL_URL = process.env.KEY_PORTAL_URL || 'https://mcpkeys.techmavie.digital';
// Optional single-tenant fallback for self-hosted mode (still requires MCP_API_KEY).
const SERVER_FORGEJO_URL = process.env.FORGEJO_URL?.trim() || '';
const SERVER_FORGEJO_TOKEN = (process.env.FORGEJO_ACCESS_TOKEN || process.env.FORGEJO_TOKEN || '').trim();
const BODY_LIMIT = process.env.MCP_BODY_LIMIT || '10mb';
const TIMEOUT_MS = numberFromEnv(process.env.FORGEJO_TIMEOUT_MS, 30_000, 1000);
const MAX_RESPONSE_BYTES = numberFromEnv(process.env.FORGEJO_MAX_RESPONSE_MB, 20) * 1024 * 1024;
const NETWORK_POLICY = networkPolicyFromEnv();
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const ALLOW_ALL_ORIGINS = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes('*');

if ((KEY_SERVICE_URL && !KEY_SERVICE_TOKEN) || (!KEY_SERVICE_URL && KEY_SERVICE_TOKEN)) {
  console.error('KEY_SERVICE_URL and KEY_SERVICE_TOKEN must both be set (hosted mode) or both be unset.');
  process.exit(1);
}

let DEFAULT_TOOLSET_SELECTION: Set<Toolset>;
try {
  DEFAULT_TOOLSET_SELECTION = parseToolsets(process.env.FORGEJO_TOOLSETS);
} catch (error) {
  console.error(`FORGEJO_TOOLSETS: ${(error as Error).message}`);
  process.exit(1);
}
const DEFAULT_READ_ONLY = parseBoolean(process.env.FORGEJO_READ_ONLY, false);

if (!MCP_API_KEY) {
  console.warn('MCP_API_KEY is not set: self-hosted /mcp access and /analytics are disabled.');
}

const keyService = new KeyServiceClient({ url: KEY_SERVICE_URL, token: KEY_SERVICE_TOKEN, serverId: KEY_SERVICE_SERVER_ID });
const analytics = new Analytics(ANALYTICS_DIR);
analytics.startAutoSave();

// =============================================================================
// Helpers
// =============================================================================

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function normalizePublicBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed || trimmed === '/') return '';
  return (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).replace(/\/+$/, '');
}

function withPublicBasePath(route: string): string {
  return `${PUBLIC_BASE_PATH}${route}`;
}

/**
 * Map a request to a fixed route name for analytics and logs.
 * Express matches routes case-insensitively, so compare case-insensitively too,
 * and never record raw paths: they could contain usr_ keys (/MCP/usr_...) or
 * scanner noise that would grow analytics.json forever.
 */
const KNOWN_ROUTES = new Set(['/', '/health', '/mcp', '/mcp-debug/open', '/.well-known/mcp/server-card.json']);

function normalizeRoute(req: Request): string {
  const p = req.path.toLowerCase().replace(/\/+$/, '') || '/';
  if (p.startsWith('/mcp/')) return '/mcp/:userKey';
  if (KNOWN_ROUTES.has(p)) return p;
  if (p.startsWith('/.well-known/oauth-')) return '/.well-known/oauth-*';
  if (p.startsWith('/analytics')) return '/analytics';
  return '(other)';
}

function traceHttp(req: Request, res: Response, details: Record<string, unknown> = {}): void {
  if (!MCP_TRACE_HTTP) return;
  console.log('[mcp-http]', {
    method: req.method,
    path: normalizeRoute(req),
    accept: req.get('accept'),
    contentType: req.get('content-type'),
    protocolVersion: req.get('mcp-protocol-version'),
    rpcMethod: req.body?.method,
    status: res.statusCode,
    ...details,
  });
}

/** JSON-RPC shaped error so MCP clients can show the message. */
function sendError(req: Request, res: Response, error: HttpError): void {
  if (res.headersSent) return;
  const id = req.body && (typeof req.body.id === 'string' || typeof req.body.id === 'number') ? req.body.id : null;
  res.status(error.status).json({
    jsonrpc: '2.0',
    error: {
      code: error.status >= 500 ? -32603 : -32600,
      message: error.message,
      data: { reason: error.code },
    },
    id,
  });
}

/**
 * The SDK rejects requests whose Accept header doesn't list both
 * application/json and text/event-stream. Some clients omit one, so add them.
 * Patches both req.headers and req.rawHeaders (the SDK's Hono adapter reads both).
 */
function ensureAcceptHeader(req: Request): void {
  const current = req.headers.accept || '';
  const missing = ['application/json', 'text/event-stream'].filter(type => !current.includes(type));
  if (!missing.length) return;
  const value = [current, ...missing].filter(Boolean).join(', ');
  req.headers.accept = value;
  const index = req.rawHeaders.findIndex((name, i) => i % 2 === 0 && name.toLowerCase() === 'accept');
  if (index >= 0) req.rawHeaders[index + 1] = value;
  else req.rawHeaders.push('Accept', value);
}

function queryString(req: Request, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = req.query[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

// =============================================================================
// Credential + option resolution
// =============================================================================

interface Credentials {
  url: string;
  token: string;
  authMode: string;
  credentialHint: string;
}

interface RequestOptions {
  toolsets: Set<Toolset>;
  readOnly: boolean;
}

/** Toolsets and read-only mode for this request (query string or headers override the server defaults). */
function resolveRequestOptions(req: Request): RequestOptions {
  const toolsetsInput = queryString(req, 'toolsets') ?? req.get('X-Forgejo-Toolsets');
  let toolsets = DEFAULT_TOOLSET_SELECTION;
  if (toolsetsInput !== undefined && toolsetsInput.trim() !== '') {
    try {
      toolsets = parseToolsets(toolsetsInput);
    } catch (error) {
      if (error instanceof ConfigError) throw new HttpError(400, 'invalid_toolsets', error.message);
      throw error;
    }
  }
  const readOnlyInput = queryString(req, 'read_only', 'readonly', 'readOnly') ?? req.get('X-Forgejo-Read-Only');
  return { toolsets, readOnly: parseBoolean(readOnlyInput, DEFAULT_READ_ONLY) };
}

/** Hosted mode: swap a usr_ key for the caller's Forgejo URL + token. */
async function resolveHosted(userKey: string): Promise<Credentials> {
  if (!userKey.startsWith('usr_')) {
    throw new HttpError(401, 'invalid_key', `Expected a personal key starting with "usr_". Create one for Forgejo at ${KEY_PORTAL_URL}`);
  }
  if (!keyService.enabled) {
    throw new HttpError(503, 'service_unavailable', 'Hosted key mode is not configured on this server.');
  }

  const result = await keyService.resolve(userKey);
  if (!result.ok) {
    if (result.reason === 'invalid_key') {
      throw new HttpError(
        403,
        'invalid_key',
        `This key is invalid, revoked or suspended, or it is not a Forgejo connection. Check your Forgejo connection at ${KEY_PORTAL_URL}`,
      );
    }
    if (result.reason === 'malformed_response') {
      throw new HttpError(
        502,
        'malformed_response',
        `The key service returned incomplete Forgejo credentials. Re-save your Forgejo connection (instance URL and token) at ${KEY_PORTAL_URL}`,
      );
    }
    throw new HttpError(503, 'service_unavailable', 'The key service is temporarily unavailable. Please try again shortly.');
  }

  return {
    url: result.credentials.url,
    token: result.credentials.token,
    authMode: 'hosted (mcp-key-service)',
    credentialHint: `Then update the token on your Forgejo connection at ${KEY_PORTAL_URL}.`,
  };
}

/** Self-hosted mode: shared MCP_API_KEY gate + the caller's Forgejo URL/token in headers. */
function resolveSelfHosted(req: Request): Credentials {
  if (!MCP_API_KEY) {
    throw new HttpError(503, 'server_misconfigured', 'Self-hosted mode is disabled: MCP_API_KEY is not set on this server.');
  }
  if (!safeEqual(req.get('X-API-Key'), MCP_API_KEY)) {
    throw new HttpError(401, 'unauthorized', 'Invalid or missing X-API-Key header.');
  }
  const url = req.get('X-Forgejo-Url')?.trim() || SERVER_FORGEJO_URL;
  const token = req.get('X-Forgejo-Token')?.trim() || SERVER_FORGEJO_TOKEN;
  if (!url || !token) {
    throw new HttpError(400, 'missing_config', 'Send your Forgejo instance URL and access token in the X-Forgejo-Url and X-Forgejo-Token headers.');
  }
  return {
    url,
    token,
    authMode: 'self-hosted (X-API-Key)',
    credentialHint: 'Then send the new token in the X-Forgejo-Token header.',
  };
}

/** Pick the auth mode for a request to /mcp (no key in the path). */
async function resolveFromRequest(req: Request): Promise<Credentials> {
  // A usr_ key sent in a header (for clients that support custom headers) keeps it out of URLs entirely.
  const bearerKey = /^Bearer\s+(usr_\S+)$/i.exec(req.get('Authorization') || '')?.[1];
  if (bearerKey) return resolveHosted(bearerKey);
  const headerKey = req.get('X-API-Key');
  if (headerKey?.startsWith('usr_')) return resolveHosted(headerKey);

  if (headerKey || req.get('X-Forgejo-Token') || req.get('X-Forgejo-Url')) return resolveSelfHosted(req);

  const queryKey = queryString(req, 'api_key', 'apiKey');
  if (queryKey !== undefined && queryKey.trim()) {
    if (!queryKey.startsWith('usr_')) {
      // Raw tokens in URLs end up in proxy logs, so only usr_ keys are accepted there.
      throw new HttpError(
        400,
        'raw_key_not_supported',
        `Only personal usr_ keys are accepted in the URL. Create one at ${KEY_PORTAL_URL} and connect to /mcp/usr_..., ` +
          'or use the X-API-Key + X-Forgejo-Url + X-Forgejo-Token headers on a self-hosted server.',
      );
    }
    return resolveHosted(queryKey);
  }

  throw new HttpError(
    401,
    'missing_auth',
    `Authentication required. Connect to ${withPublicBasePath('/mcp/usr_...')} (or send "Authorization: Bearer usr_...") with your personal key from ${KEY_PORTAL_URL}, ` +
      'or (self-hosted) send X-API-Key, X-Forgejo-Url and X-Forgejo-Token headers.',
  );
}

// =============================================================================
// Per-request MCP handling
// =============================================================================

function createDiagnosticsServer(): McpServer {
  const server = new McpServer({ name: `${SERVER_NAME} (diagnostics)`, version: SERVER_VERSION });
  server.registerTool(
    'diagnostics_ping',
    { title: 'Diagnostics ping', description: 'Returns "pong". Verifies transport and initialization only.', annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: 'text', text: 'pong' }] }),
  );
  return server;
}

async function serveMcp(req: Request, res: Response, credentials: Credentials | null, options: RequestOptions | null): Promise<void> {
  const server =
    credentials && options
      ? createForgejoServer({
          credentials: { url: credentials.url, token: credentials.token },
          transport: 'http',
          authMode: credentials.authMode,
          toolsets: options.toolsets,
          readOnly: options.readOnly,
          policy: NETWORK_POLICY,
          timeoutMs: TIMEOUT_MS,
          maxResponseBytes: MAX_RESPONSE_BYTES,
          credentialHint: credentials.credentialHint,
          setupHint: `Update your Forgejo connection at ${KEY_PORTAL_URL}.`,
          onToolComplete: event => analytics.trackToolCall(event.tool, event.isError, event.durationMs),
        })
      : createDiagnosticsServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true, // plain JSON responses: simpler for proxies and curl
  });

  // Idempotent cleanup once the response is done.
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    void transport.close();
    void server.close();
  };
  res.once('finish', cleanup);
  res.once('close', cleanup);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Express handler factory for the MCP endpoints. */
function mcpHandler(getCredentials: ((req: Request) => Promise<Credentials>) | null) {
  return async (req: Request, res: Response) => {
    // Stateless server: there is no session to stream (GET) or terminate (DELETE).
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      sendError(req, res, new HttpError(405, 'method_not_allowed', 'Method not allowed. Send MCP JSON-RPC requests with POST.'));
      return;
    }

    try {
      ensureAcceptHeader(req);
      const options = getCredentials ? resolveRequestOptions(req) : null;
      const credentials = getCredentials ? await getCredentials(req) : null;
      await serveMcp(req, res, credentials, options);
      traceHttp(req, res, { authMode: credentials?.authMode ?? 'diagnostics' });
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status >= 500) console.error(`[mcp] ${error.code}: ${error.message} (${sanitizeUrlForLogs(req.originalUrl)})`);
        traceHttp(req, res, { error: error.code });
        sendError(req, res, error);
        return;
      }
      console.error(`[mcp] Unhandled error for ${sanitizeUrlForLogs(req.originalUrl)}:`, error);
      sendError(req, res, new HttpError(500, 'internal_error', 'Unexpected server error.'));
    }
  };
}

// =============================================================================
// Express app
// =============================================================================

const app = express();

// Only trust X-Forwarded-For from local proxies (nginx on the host / Docker network).
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.disable('x-powered-by');

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOW_ALL_ORIGINS || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
      else callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'Mcp-Session-Id',
      'Mcp-Protocol-Version',
      'Last-Event-ID',
      'X-API-Key',
      'X-Forgejo-Url',
      'X-Forgejo-Token',
      'X-Forgejo-Toolsets',
      'X-Forgejo-Read-Only',
    ],
    exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
    maxAge: 86400,
  }),
);

app.use(express.json({ limit: BODY_LIMIT }));

// Track every request except the analytics endpoints themselves.
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (!req.path.startsWith('/analytics')) {
    analytics.trackRequest({
      method: req.method,
      endpoint: normalizeRoute(req),
      ip: req.ip || req.socket.remoteAddress || 'unknown',
      userAgent: req.get('user-agent'),
    });
  }
  next();
});

// ---- Info & health -----------------------------------------------------------

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: 'MCP server for Forgejo (self-hosted or Codeberg)',
    transport: 'streamable-http',
    protocolVersion: MCP_PROTOCOL_VERSION,
    tools: ALL_TOOLS.length,
    defaultToolsets: DEFAULT_TOOLSETS,
    endpoints: {
      mcp: withPublicBasePath('/mcp/{usr_key}'),
      mcpSelfHosted: withPublicBasePath('/mcp'),
      health: withPublicBasePath('/health'),
      serverCard: withPublicBasePath('/.well-known/mcp/server-card.json'),
      analytics: withPublicBasePath('/analytics'),
      analyticsDashboard: withPublicBasePath('/analytics/dashboard'),
      ...(ENABLE_MCP_DIAGNOSTICS ? { diagnostics: withPublicBasePath('/mcp-debug/open') } : {}),
    },
    options: {
      toolsets: '?toolsets=default,actions,wiki (or "all")',
      readOnly: '?read_only=true',
    },
    getAKey: KEY_PORTAL_URL,
    documentation: 'https://github.com/hithereiamaliff/mcp-forgejo',
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'streamable-http',
    protocolVersion: MCP_PROTOCOL_VERSION,
    uptime: analytics.uptime(),
    keyService: keyService.enabled ? 'configured' : 'not configured',
    timestamp: new Date().toISOString(),
  });
});

// ---- Discovery ---------------------------------------------------------------

app.get('/.well-known/mcp/server-card.json', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    description:
      'Forgejo (self-hosted or Codeberg): repositories, files, branches, commits, issues, pull requests, reviews, notifications, ' +
      'Actions, releases, wiki, organizations and more. Tools are grouped into toolsets; see each tool\'s "toolset".',
    transport: { type: 'streamable-http', endpoint: withPublicBasePath('/mcp') },
    authentication: { required: true },
    tools: ALL_TOOLS.map(tool => ({
      name: tool.name,
      title: tool.title,
      description: describeTool(tool),
      annotations: tool.annotations,
      toolset: tool.toolset,
      defaultEnabled: tool.toolset === 'meta' || DEFAULT_TOOLSETS.includes(tool.toolset),
    })),
  });
});

// This server doesn't implement OAuth; answer clearly so clients don't keep probing.
app.all(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/{*path}'], (_req: Request, res: Response) => {
  res.status(404).json({ error: 'oauth_metadata_not_supported' });
});
app.all(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/{*path}'], (_req: Request, res: Response) => {
  res.status(404).json({ error: 'oauth_metadata_not_supported' });
});

// ---- Analytics (data requires MCP_API_KEY) --------------------------------------

function requireApiKey(req: Request, res: Response): boolean {
  if (!MCP_API_KEY) {
    res.status(503).json({ error: 'server_misconfigured', message: 'Set MCP_API_KEY to enable analytics.' });
    return false;
  }
  if (safeEqual(req.get('X-API-Key'), MCP_API_KEY)) return true;
  res.status(401).json({ error: 'unauthorized', message: 'Valid X-API-Key header required.' });
  return false;
}

app.get('/analytics', (req: Request, res: Response) => {
  if (!requireApiKey(req, res)) return;
  res.json(analytics.summary(SERVER_NAME));
});

app.get('/analytics/tools', (req: Request, res: Response) => {
  if (!requireApiKey(req, res)) return;
  res.json(analytics.toolStats());
});

app.get('/analytics/dashboard', (_req: Request, res: Response) => {
  res.type('html').send(dashboardHtml(SERVER_NAME));
});

// ---- MCP endpoints -------------------------------------------------------------

if (ENABLE_MCP_DIAGNOSTICS) {
  app.all('/mcp-debug/open', mcpHandler(null));
}

// Hosted (recommended): https://mcp.techmavie.digital/forgejo/mcp/usr_xxx
app.all('/mcp/:userKey', mcpHandler(async req => resolveHosted(String(req.params.userKey))));

// Hosted via header or ?api_key=usr_xxx, or self-hosted via headers.
app.all('/mcp', mcpHandler(resolveFromRequest));

// ---- Fallbacks -------------------------------------------------------------------

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not_found', message: 'Unknown endpoint. See / for available endpoints.' });
});

// Body-parser and CORS errors → JSON instead of an HTML stack trace.
app.use((error: Error & { status?: number; type?: string }, req: Request, res: Response, _next: NextFunction) => {
  if (error.type === 'entity.too.large') {
    sendError(req, res, new HttpError(413, 'payload_too_large', `Request body is larger than ${BODY_LIMIT}.`));
  } else if (error.type === 'entity.parse.failed') {
    if (!res.headersSent) res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON' }, id: null });
  } else if (error.message === 'Not allowed by CORS') {
    if (!res.headersSent) res.status(403).json({ error: 'cors_rejected', message: 'Origin not allowed.' });
  } else {
    console.error('Unhandled HTTP error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: 'Unexpected server error.' });
  }
});

// =============================================================================
// Start & graceful shutdown
// =============================================================================

const httpServer: Server = app.listen(PORT, HOST, (error?: Error) => {
  // Express 5 passes startup errors (e.g. port already in use) to this callback.
  if (error) {
    console.error(`Failed to start on ${HOST}:${PORT}: ${error.message}`);
    process.exit(1);
  }
  const line = '='.repeat(64);
  console.log(line);
  console.log(`${SERVER_NAME} (Streamable HTTP) v${SERVER_VERSION}`);
  console.log(line);
  console.log(`Listening:        http://${HOST}:${PORT}`);
  console.log(`MCP (hosted):     ${withPublicBasePath('/mcp/usr_...')}  or  ${withPublicBasePath('/mcp?api_key=usr_...')}`);
  console.log(`MCP (self-host):  ${withPublicBasePath('/mcp')} with X-API-Key + X-Forgejo-Url + X-Forgejo-Token`);
  console.log(`Health:           ${withPublicBasePath('/health')}`);
  console.log(`Server card:      ${withPublicBasePath('/.well-known/mcp/server-card.json')}`);
  console.log(`Analytics:        ${withPublicBasePath('/analytics/dashboard')}`);
  console.log(`Tools:            ${ALL_TOOLS.length} total`);
  console.log(`Default toolsets: ${[...DEFAULT_TOOLSET_SELECTION].join(', ')}${DEFAULT_READ_ONLY ? ' (read-only)' : ''}`);
  console.log(`Key service:      ${keyService.enabled ? `configured (${KEY_SERVICE_URL}, server_id=${KEY_SERVICE_SERVER_ID})` : 'not configured'}`);
  console.log(`Self-hosted auth: ${MCP_API_KEY ? 'enabled' : 'disabled (set MCP_API_KEY)'}`);
  console.log(`Server instance:  ${SERVER_FORGEJO_URL ? `${SERVER_FORGEJO_URL} (self-hosted fallback)` : 'not set'}`);
  console.log(
    `Network policy:   ${NETWORK_POLICY.requireHttps ? 'https only' : 'http allowed'}, ` +
      `${NETWORK_POLICY.allowPrivate ? 'private addresses ALLOWED' : 'private addresses blocked'}` +
      `${NETWORK_POLICY.trustedHosts.size ? `, trusted: ${[...NETWORK_POLICY.trustedHosts].join(', ')}` : ''}`,
  );
  console.log(`Diagnostics:      ${ENABLE_MCP_DIAGNOSTICS ? 'enabled' : 'disabled'} | HTTP tracing: ${MCP_TRACE_HTTP ? 'on' : 'off'}`);
  console.log(`CORS origins:     ${ALLOW_ALL_ORIGINS ? '*' : ALLOWED_ORIGINS.join(', ')}`);
  console.log(line);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, saving analytics and shutting down...`);
  analytics.save();
  keyService.dispose();
  httpServer.close(() => process.exit(0));
  // Don't hang forever on open connections.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
