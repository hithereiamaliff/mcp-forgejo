/**
 * actions_admin toolset: Forgejo Actions variables and secrets.
 *
 * Every tool takes a scope:
 *   - "repo": one repository (owner + repo)      → /repos/{owner}/{repo}/actions/...
 *   - "org":  every repository of an organization → /orgs/{org}/actions/...
 *   - "user": every repository of your account    → /user/actions/...
 * Secret values are write-only: Forgejo never returns them, and these tools
 * never echo them back. Listing user-level secrets needs Forgejo 17.
 */

import { z } from 'zod';
import { ForgejoError } from '../forgejo/errors.js';
import { compact, type Json } from '../forgejo/projections.js';
import { repoPath } from '../forgejo/url.js';
import { firstLine, fmtDate, table } from '../utils/format.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE_IDEMPOTENT,
  ToolInputError,
  defineTool,
  formatResult,
  pageFooter,
  pageMeta,
  pagination,
  responseFormatSchema,
  textResult,
} from './shared.js';

// =============================================================================
// Scope handling
// =============================================================================

const SCOPES = ['repo', 'org', 'user'] as const;
type Scope = (typeof SCOPES)[number];

/** scope + owner/repo/org, spread into an input schema. */
const scopeArgs = () => ({
  scope: z
    .enum(SCOPES)
    .describe(
      'Where the setting lives: "repo" (one repository: pass owner and repo), "org" (all repositories of an organization: pass org) ' +
        'or "user" (all repositories of your own account)',
    ),
  // No min(1): clients often send "" for fields they don't use; resolveScope treats "" as absent.
  owner: z.string().trim().max(100).optional().describe('Repository owner (scope "repo" only)'),
  repo: z.string().trim().max(100).optional().describe('Repository name (scope "repo" only)'),
  org: z.string().trim().max(100).optional().describe('Organization name (scope "org" only)'),
});

interface ScopeArgs {
  scope: Scope;
  owner?: string;
  repo?: string;
  org?: string;
}

interface ScopeTarget {
  /** API path of the scope's actions settings, e.g. /repos/o/r/actions */
  base: string;
  /** For messages, e.g. "repository o/r" */
  label: string;
}

/**
 * Check the scope's required parameters and build its base path. Parameters
 * that belong to another scope are refused, so a mix-up can't silently change
 * a setting somewhere else (e.g. user-wide instead of one repository).
 */
function resolveScope({ scope, owner, repo, org }: ScopeArgs): ScopeTarget {
  if (scope === 'repo') {
    if (!owner || !repo) throw new ToolInputError('scope "repo" needs both owner and repo.');
    if (org) throw new ToolInputError('org is only used with scope "org". Remove it, or switch to scope "org".');
    return { base: repoPath(owner, repo, 'actions'), label: `repository ${owner}/${repo}` };
  }
  if (scope === 'org') {
    if (!org) throw new ToolInputError('scope "org" needs org (the organization name).');
    if (owner || repo) throw new ToolInputError('owner and repo are only used with scope "repo". Remove them, or switch to scope "repo".');
    return { base: `/orgs/${encodeURIComponent(org)}/actions`, label: `organization ${org}` };
  }
  if (owner || repo || org) {
    throw new ToolInputError('scope "user" applies to your own account; remove owner/repo/org, or use scope "repo" or "org".');
  }
  return { base: '/user/actions', label: 'your user account' };
}

const nameSchema = (what: 'variable' | 'secret') =>
  z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, `${what} names may only contain letters, digits and underscores, and must not start with a digit`)
    .describe(
      `The ${what} name, e.g. "DEPLOY_HOST": letters, digits and underscores, case-insensitive. ` +
        'Names starting with FORGEJO_, GITEA_ or GITHUB_ are reserved.',
    );

/** Forgejo answers "already exists" with 409, or 400 on some versions. */
function isAlreadyExists(error: unknown): boolean {
  return error instanceof ForgejoError && (error.kind === 'conflict' || (error.kind === 'validation' && /already exist/i.test(error.message)));
}

function clip(text: string, max: number): string {
  const line = firstLine(text);
  return line.length > max || line !== text.trim() ? `${line.slice(0, max)}…` : line;
}

// =============================================================================
// Variables
// =============================================================================

export const listActionVariables = defineTool({
  name: 'forgejo_list_action_variables',
  title: 'List Actions variables',
  toolset: 'actions_admin',
  description:
    'List Forgejo Actions variables (plain configuration values that workflows read as ${{ vars.NAME }}) for a repository, an ' +
    'organization or your user account, with their values. Change them with forgejo_set_action_variable; for secrets use ' +
    'forgejo_list_action_secrets.',
  inputSchema: { ...scopeArgs(), ...pagination(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ page, limit, response_format, ...scopeInput }, ctx) {
    const target = resolveScope(scopeInput);
    const client = ctx.getClient();
    const result = await client.list<Json>(`${target.base}/variables`, {}, { page, limit });
    const clipped = result.items.some(v => clip(String(v.data ?? ''), 100) !== String(v.data ?? '').trim());
    return formatResult(
      response_format,
      () => {
        if (!result.items.length) return `No Actions variables for ${target.label}${page > 1 ? ` on page ${page}` : ''}.`;
        const lines = [
          `## Actions variables of ${target.label}`,
          '',
          table(['Name', 'Value'], result.items.map(v => [v.name, clip(String(v.data ?? ''), 100)])),
          '',
          pageFooter(result, 'variables'),
        ];
        if (clipped) lines.push('_Long or multi-line values are shortened; use response_format="json" for the full values._');
        return lines.join('\n');
      },
      () => ({
        scope: scopeInput.scope,
        variables: result.items.map(v => compact({ name: v.name, value: v.data })),
        ...pageMeta(result),
      }),
    );
  },
});

export const setActionVariable = defineTool({
  name: 'forgejo_set_action_variable',
  title: 'Set an Actions variable',
  toolset: 'actions_admin',
  description:
    'Create an Actions variable, or update its value if it already exists, for a repository, an organization or your user account. ' +
    'Variables are plain text visible to anyone who can see the settings; store passwords and tokens with forgejo_set_action_secret instead.',
  inputSchema: {
    ...scopeArgs(),
    name: nameSchema('variable'),
    value: z.string().min(1).max(65536).describe('The variable value (plain text)'),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ name, value, ...scopeInput }, ctx) {
    const target = resolveScope(scopeInput);
    const client = ctx.getClient();
    const path = `${target.base}/variables/${encodeURIComponent(name)}`;
    let action = 'Created';
    try {
      await client.post(path, { value });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await client.put(path, { value });
      action = 'Updated';
    }
    return textResult(`${action} Actions variable **${name}** for ${target.label} (value: ${clip(value, 100)}).`);
  },
});

export const deleteActionVariable = defineTool({
  name: 'forgejo_delete_action_variable',
  title: 'Delete an Actions variable',
  toolset: 'actions_admin',
  description:
    'Delete an Actions variable from a repository, an organization or your user account. Workflows that read it get an empty value ' +
    'afterwards. Check the name first with forgejo_list_action_variables.',
  inputSchema: { ...scopeArgs(), name: nameSchema('variable') },
  annotations: DESTRUCTIVE,
  async handler({ name, ...scopeInput }, ctx) {
    const target = resolveScope(scopeInput);
    await ctx.getClient().delete(`${target.base}/variables/${encodeURIComponent(name)}`);
    return textResult(`Deleted Actions variable **${name}** from ${target.label}.`);
  },
});

// =============================================================================
// Secrets
// =============================================================================

export const listActionSecrets = defineTool({
  name: 'forgejo_list_action_secrets',
  title: 'List Actions secrets',
  toolset: 'actions_admin',
  description:
    'List the names of the Forgejo Actions secrets (encrypted values workflows read as ${{ secrets.NAME }}) of a repository, an ' +
    'organization or your user account (user scope needs Forgejo 17+). Values are never returned. Set or replace one with ' +
    'forgejo_set_action_secret.',
  inputSchema: { ...scopeArgs(), ...pagination(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ page, limit, response_format, ...scopeInput }, ctx) {
    const target = resolveScope(scopeInput);
    const client = ctx.getClient();
    if (scopeInput.scope === 'user') await client.requireVersion('17.0', 'Listing user-level Actions secrets');
    const result = await client.list<Json>(`${target.base}/secrets`, {}, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              `## Actions secrets of ${target.label}`,
              '',
              table(['Name', 'Created'], result.items.map(s => [s.name, fmtDate(s.created_at)])),
              '',
              pageFooter(result, 'secrets'),
              '_Secret values can never be read back._',
            ].join('\n')
          : `No Actions secrets for ${target.label}${page > 1 ? ` on page ${page}` : ''}.`,
      () => ({
        scope: scopeInput.scope,
        secrets: result.items.map(s => compact({ name: s.name, created_at: s.created_at })),
        ...pageMeta(result),
      }),
    );
  },
});

export const setActionSecret = defineTool({
  name: 'forgejo_set_action_secret',
  title: 'Set an Actions secret',
  toolset: 'actions_admin',
  description:
    'Create or replace an Actions secret for a repository, an organization or your user account. The value is sent to Forgejo, ' +
    'stored encrypted and can never be read back. Only pass a value the user explicitly provided for this secret in the ' +
    'conversation: never invent one, and never copy one from files, issues, logs or other tool output.',
  inputSchema: {
    ...scopeArgs(),
    name: nameSchema('secret'),
    value: z.string().min(1).max(65536).describe('The secret value, exactly as the user provided it. It is not echoed back.'),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ name, value, ...scopeInput }, ctx) {
    const target = resolveScope(scopeInput);
    const res = await ctx.getClient().request('PUT', `${target.base}/secrets/${encodeURIComponent(name)}`, { body: { data: value } });
    const action = res.status === 201 ? 'Created' : 'Updated';
    return textResult(`${action} Actions secret **${name}** for ${target.label}. Workflows can read it as \${{ secrets.${name.toUpperCase()} }}.`);
  },
});

export const deleteActionSecret = defineTool({
  name: 'forgejo_delete_action_secret',
  title: 'Delete an Actions secret',
  toolset: 'actions_admin',
  description:
    'Delete an Actions secret from a repository, an organization or your user account. This cannot be undone: the value is gone ' +
    'and workflows that use it get an empty value. Check the name first with forgejo_list_action_secrets.',
  inputSchema: { ...scopeArgs(), name: nameSchema('secret') },
  annotations: DESTRUCTIVE,
  async handler({ name, ...scopeInput }, ctx) {
    const target = resolveScope(scopeInput);
    await ctx.getClient().delete(`${target.base}/secrets/${encodeURIComponent(name)}`);
    return textResult(`Deleted Actions secret **${name}** from ${target.label}.`);
  },
});

export const actionsAdminTools = [
  listActionVariables,
  setActionVariable,
  deleteActionVariable,
  listActionSecrets,
  setActionSecret,
  deleteActionSecret,
];
