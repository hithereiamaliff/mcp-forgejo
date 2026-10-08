/**
 * Shared building blocks for tool definitions.
 *
 * Every tool is a plain ToolDefinition object. src/index.ts registers them in a
 * loop (filtered by toolset and read-only mode), and the same list feeds the
 * server card, TOOLS.md and the tests — one source of truth for names,
 * descriptions, toolsets and annotations.
 *
 * Schema pieces are FACTORIES (call them for every use): reusing one zod
 * instance in two places makes the JSON schema contain "$ref", which some
 * strict MCP clients reject.
 */

import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Toolset } from '../config.js';
import type { ForgejoClient, Page } from '../forgejo/client.js';
import { ForgejoError } from '../forgejo/errors.js';
import { formatNumber } from '../utils/format.js';

/** Per-request context handed to every tool handler. */
export interface ToolContext {
  /** The request's Forgejo client (throws a friendly error if no instance/token is configured). */
  getClient(): ForgejoClient;
  transport: 'http' | 'stdio';
  /** How the caller authenticated (shown by forgejo_hello). */
  authMode: string;
  /** Toolsets enabled for this request. */
  toolsets: ReadonlySet<Toolset>;
  readOnly: boolean;
  /** The configured instance URL (normalised if valid), if any. */
  instanceUrl?: string;
  /** Why there is no usable connection (missing/invalid URL or token), if so. */
  connectionProblem?: string;
  /** Tools registered for this request (used by forgejo_hello). */
  enabledTools: ReadonlyArray<Pick<ToolDefinition, 'name' | 'toolset' | 'minVersion'>>;
}

export interface ToolDefinition {
  name: string;
  title: string;
  toolset: Toolset;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  /** Minimum Forgejo version, e.g. "16.0". Checked before the handler runs. */
  minVersion?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, ctx: ToolContext) => Promise<CallToolResult>;
}

/** Identity helper that keeps handler args typed against the schema. */
export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  toolset: Toolset;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  minVersion?: string;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>;
}): ToolDefinition {
  return def as ToolDefinition;
}

// =============================================================================
// Annotation presets
// =============================================================================

/** Reads only. Safe for clients to auto-approve. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Creates something (issue, comment, branch, PR...). Clients should ask first. */
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Updates/sets something; repeating the call with the same input has no extra effect. */
export const WRITE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Deletes, merges or otherwise makes changes that are hard to undo. */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

// =============================================================================
// Common schema pieces (factories — see the note at the top)
// =============================================================================

export const ownerSchema = () =>
  z.string().trim().min(1).max(100).describe('Repository owner: a user or organization name (e.g. "aliff")');

export const repoSchema = () => z.string().trim().min(1).max(100).describe('Repository name (e.g. "my-project")');

/** owner + repo, spread into an input schema. */
export const repoRef = () => ({ owner: ownerSchema(), repo: repoSchema() });

export const indexSchema = (what = 'issue or pull request') =>
  z.number().int().positive().describe(`The ${what} number (as shown in the URL, e.g. 42 for #42)`);

export const pageSchema = () => z.number().int().min(1).default(1).describe('Page number, starting at 1');

export const limitSchema = (fallback = 20) =>
  z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(fallback)
    .describe(`Items per page (default ${fallback}; the instance caps this, usually at 50)`);

/** page + limit, spread into an input schema. */
export const pagination = (fallback = 20) => ({ page: pageSchema(), limit: limitSchema(fallback) });

export const responseFormatSchema = () =>
  z
    .enum(['markdown', 'json'])
    .default('markdown')
    .describe('"markdown" (default) for a readable summary, or "json" for compact structured data');

export const refSchema = (what = 'Branch, tag or commit SHA') => z.string().trim().min(1).max(250).describe(what);

export const stateSchema = (fallback: 'open' | 'closed' | 'all' = 'open') =>
  z.enum(['open', 'closed', 'all']).default(fallback).describe(`Filter by state (default "${fallback}")`);

/** Labels given by name ("bug") or numeric ID (12). */
export const labelListSchema = (what = 'Labels') =>
  z
    .array(z.union([z.string().trim().min(1), z.number().int().positive()]))
    .describe(`${what}: label names (e.g. "bug") or numeric IDs`);

export const userListSchema = (what: string) => z.array(z.string().trim().min(1)).describe(what);

// =============================================================================
// Result helpers
// =============================================================================

export type ResponseFormat = 'markdown' | 'json';

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(data: unknown): CallToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

/** Markdown or compact JSON depending on the caller's response_format. */
export function formatResult(format: ResponseFormat | undefined, markdown: () => string, json: () => unknown): CallToolResult {
  return format === 'json' ? jsonResult(json()) : textResult(markdown());
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Raised for invalid tool input that zod can't express (e.g. "exactly one of"). */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** Turn any thrown error into a tool error result (never leaks stack traces). */
export function toErrorResult(error: unknown): CallToolResult {
  if (error instanceof ForgejoError || error instanceof ToolInputError) {
    return errorResult(error.message);
  }
  console.error('Unexpected tool error:', error);
  return errorResult('Unexpected error while calling Forgejo. Please try again.');
}

// =============================================================================
// Pagination helpers
// =============================================================================

/** "Showing 21–40 of 97 · page 2 of 5 · more: call again with page=3" */
export function pageFooter(page: Page<unknown>, noun = 'items'): string {
  const { items, page: p, limit, total, hasMore } = page;
  if (items.length === 0) return p > 1 ? `_No ${noun} on page ${p}._` : '';
  const from = (p - 1) * limit + 1;
  const to = from + items.length - 1;
  const parts = [`Showing ${formatNumber(from)}–${formatNumber(to)}${total !== null ? ` of ${formatNumber(total)}` : ''} ${noun}`];
  if (total !== null) parts.push(`page ${p} of ${Math.max(1, Math.ceil(total / limit))}`);
  if (hasMore) parts.push(`more available: call again with page=${p + 1}`);
  return `_${parts.join(' · ')}_`;
}

/** Pagination metadata for JSON output. */
export function pageMeta(page: Page<unknown>) {
  return { page: page.page, limit: page.limit, total: page.total, has_more: page.hasMore };
}
