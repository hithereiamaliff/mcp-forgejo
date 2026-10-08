/**
 * repo_admin toolset (opt-in): repository deletion, collaborators, branch
 * protection rules, webhooks, push mirrors and mirror syncing.
 *
 * Secrets never appear in output: webhook secrets, authorization headers and
 * mirror passwords are write-only here, and credentials that are often embedded
 * in webhook or mirror URLs (user:password@, token query parameters, chat-service
 * tokens in the path) are masked before anything is shown.
 */

import { z } from 'zod';
import type { ForgejoClient } from '../forgejo/client.js';
import { ForgejoError } from '../forgejo/errors.js';
import { compact, login, type Json } from '../forgejo/projections.js';
import { repoPath } from '../forgejo/url.js';
import { bullets, codeBlock, fmtDate, plural, table } from '../utils/format.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  WRITE_IDEMPOTENT,
  ToolInputError,
  defineTool,
  errorResult,
  formatResult,
  pageFooter,
  pageMeta,
  pagination,
  repoRef,
  responseFormatSchema,
  textResult,
} from './shared.js';

// =============================================================================
// Helpers
// =============================================================================

/** Encode a user-supplied path segment (rule names may contain "/" or "*"). */
const seg = (value: string): string => encodeURIComponent(value);

/** Max per-user permission lookups in forgejo_list_collaborators (one API call each). */
const MAX_PERMISSION_LOOKUPS = 20;

/** Query parameters whose values are credentials (DingTalk access_token, WeCom key, Azure code...). */
const SECRET_QUERY_KEY = /token|secret|key|pass|auth|sig|code/i;

/** A path segment that looks like an embedded access token: long, and random-looking (mixed case + digits, or digit-heavy like hex/UUIDs). */
function looksLikeToken(segment: string): boolean {
  if (segment.length < 20 || !/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  const digits = segment.replace(/\D/g, '').length;
  const mixedCase = /[a-z]/.test(segment) && /[A-Z]/.test(segment) && digits > 0;
  return mixedCase || digits / segment.length >= 0.25;
}

/**
 * Hide credentials embedded in a webhook or mirror URL: user:password@,
 * token-like query values, Telegram bot tokens and token-like path segments
 * (Slack, Discord, Teams and Feishu webhook URLs carry their secret in the path).
 */
export function maskUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // scp-style SSH addresses (git@host:owner/repo.git) have no password; mask any "//user:pass@" just in case.
    return raw.replace(/\/\/[^/@\s]+@/, '//***@');
  }
  // For http(s) the user name itself may be a token (https://<token>@host/...); "git@" on SSH URLs is not secret.
  if (url.password || (url.username && /^https?:$/.test(url.protocol))) {
    url.username = '***';
    url.password = '';
  }
  for (const key of new Set(url.searchParams.keys())) {
    if (SECRET_QUERY_KEY.test(key)) url.searchParams.set(key, '***');
  }
  url.pathname = url.pathname
    .split('/')
    .map(part => (/^bot\d+:/.test(part) ? 'bot***' : looksLikeToken(part) ? '***' : part))
    .join('/');
  return url.toString();
}

/** Mask "//user:pass@" inside free text such as mirror error messages. */
const maskText = (text: unknown): string | undefined =>
  typeof text === 'string' && text ? text.replace(/\/\/[^/@\s]+@/g, '//***@') : undefined;

/** Run `fn` over `items` with at most `limit` calls in flight. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** "@alice, @bob, team devs" */
function who(users: unknown, teams: unknown): string {
  const list = [
    ...(Array.isArray(users) ? users.map(u => `@${u}`) : []),
    ...(Array.isArray(teams) ? teams.map(t => `team ${t}`) : []),
  ];
  return list.length ? list.join(', ') : 'nobody listed';
}

// =============================================================================
// Repository deletion
// =============================================================================

export const deleteRepo = defineTool({
  name: 'forgejo_delete_repo',
  title: 'Delete a repository',
  toolset: 'repo_admin',
  description:
    'PERMANENTLY delete a repository with all its code, branches, issues, pull requests, releases, wiki, packages links and settings. ' +
    'This CANNOT be undone. Only call it when the user explicitly asked to delete this exact repository, and set `confirm_full_name` ' +
    'to "owner/repo" (it must match owner and repo exactly). To keep the data but make it read-only, use forgejo_update_repo with archived: true instead.',
  inputSchema: {
    ...repoRef(),
    confirm_full_name: z
      .string()
      .trim()
      .min(3)
      .max(201)
      .describe('Safety check: the full repository name "owner/repo" again. Nothing is deleted unless it matches owner and repo exactly'),
  },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, confirm_full_name }, ctx) {
    const expected = `${owner}/${repo}`;
    if (confirm_full_name !== expected) {
      throw new ToolInputError(
        `confirm_full_name "${confirm_full_name}" does not match "${expected}", so nothing was deleted. ` +
          'Confirm with the user which repository to delete and pass its exact "owner/repo" name.',
      );
    }
    await ctx.getClient().delete(repoPath(owner, repo));
    return textResult(`Permanently deleted repository **${expected}**.`);
  },
});

// =============================================================================
// Collaborators
// =============================================================================

export const listCollaborators = defineTool({
  name: 'forgejo_list_collaborators',
  title: 'List repository collaborators',
  toolset: 'repo_admin',
  description:
    'List the users added as collaborators on a repository. With `include_permissions`, also look up each one\'s access level ' +
    `(read/write/admin; at most ${MAX_PERMISSION_LOOKUPS} lookups per call). The owner and organization team members have access ` +
    'without being listed here. Use forgejo_set_collaborator to add or change access and forgejo_remove_collaborator to revoke it.',
  inputSchema: {
    ...repoRef(),
    include_permissions: z
      .boolean()
      .default(false)
      .describe(`Also look up each collaborator's permission (one extra request per user, first ${MAX_PERMISSION_LOOKUPS} only)`),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, repo, include_permissions, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const result = await client.list<Json>(repoPath(owner, repo, 'collaborators'), {}, { page, limit });

    const permissions = new Map<string, string>();
    const failures: string[] = [];
    let skipped = 0;
    if (include_permissions && result.items.length) {
      const targets = result.items.slice(0, MAX_PERMISSION_LOOKUPS).map(u => login(u)).filter(Boolean);
      skipped = result.items.length - Math.min(result.items.length, MAX_PERMISSION_LOOKUPS);
      await mapLimit(targets, 5, async name => {
        try {
          const p = await client.get<Json>(repoPath(owner, repo, 'collaborators', seg(name), 'permission'));
          permissions.set(name, String(p?.permission ?? p?.role_name ?? 'unknown'));
        } catch (error) {
          if (!(error instanceof ForgejoError)) throw error;
          failures.push(`${name}: ${error.message}`);
        }
      });
    }

    const rows = result.items.map(u => ({ login: login(u), full_name: u.full_name, permission: permissions.get(login(u)) }));
    return formatResult(
      response_format,
      () => {
        if (!rows.length) {
          return `No collaborators on ${owner}/${repo}${page > 1 ? ` (page ${page})` : ''}. The owner and organization teams have access without being collaborators.`;
        }
        const headers = include_permissions ? ['Login', 'Name', 'Permission'] : ['Login', 'Name'];
        const lines = [
          `## Collaborators of ${owner}/${repo}`,
          '',
          table(headers, rows.map(r => (include_permissions ? [r.login, r.full_name, r.permission ?? '—'] : [r.login, r.full_name]))),
          '',
          pageFooter(result, 'collaborators'),
        ];
        if (skipped) lines.push(`_Permissions were looked up for the first ${MAX_PERMISSION_LOOKUPS} only; use limit=${MAX_PERMISSION_LOOKUPS} and paging for the rest._`);
        if (failures.length) lines.push('', 'Permission lookups that failed:', ...failures.map(f => `- ${f}`));
        return lines.join('\n');
      },
      () => ({
        collaborators: rows.map(r => compact(r)),
        permission_lookup_failures: failures.length ? failures : undefined,
        ...pageMeta(result),
      }),
    );
  },
});

const usernameSchema = (what: string) => z.string().trim().min(1).max(100).describe(what);

export const setCollaborator = defineTool({
  name: 'forgejo_set_collaborator',
  title: 'Add a collaborator or change their access',
  toolset: 'repo_admin',
  description:
    'Add a user as a collaborator on a repository, or change an existing collaborator\'s access level: "read" (view and clone), ' +
    '"write" (push, manage issues and pull requests) or "admin" (also settings, collaborators and webhooks). ' +
    'Use forgejo_list_collaborators to see current collaborators and forgejo_remove_collaborator to revoke access.',
  inputSchema: {
    ...repoRef(),
    username: usernameSchema('User name of the person to add or update'),
    permission: z.enum(['read', 'write', 'admin']).describe('Access level: "read", "write" or "admin"'),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ owner, repo, username, permission }, ctx) {
    const client = ctx.getClient();
    const path = repoPath(owner, repo, 'collaborators', seg(username));
    // 204 = already a collaborator, 404 = not yet (422 = no such user, which is reported as an error).
    const existing = await client.request('GET', path, { okStatuses: [404] });
    await client.put(path, { permission });
    return textResult(
      existing.status === 404
        ? `Added **${username}** as a collaborator on ${owner}/${repo} with **${permission}** access.`
        : `Changed **${username}**'s access on ${owner}/${repo} to **${permission}**.`,
    );
  },
});

export const removeCollaborator = defineTool({
  name: 'forgejo_remove_collaborator',
  title: 'Remove a collaborator',
  toolset: 'repo_admin',
  description:
    'Remove a user from a repository\'s collaborators, revoking the access granted to them directly. They keep any access they have ' +
    'through organization teams (or as anyone can, for public repositories). Use forgejo_list_collaborators to see who has access.',
  inputSchema: {
    ...repoRef(),
    username: usernameSchema('User name of the collaborator to remove'),
  },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, username }, ctx) {
    await ctx.getClient().delete(repoPath(owner, repo, 'collaborators', seg(username)));
    return textResult(`Removed **${username}** from the collaborators of ${owner}/${repo}.`);
  },
});

// =============================================================================
// Branch protection
// =============================================================================

/** Compact branch protection rule (booleans kept explicit: false matters for protection settings). */
function projectProtection(b: Json) {
  return compact({
    rule_name: b.rule_name || b.branch_name,
    enable_push: Boolean(b.enable_push),
    enable_push_whitelist: Boolean(b.enable_push_whitelist),
    push_whitelist_usernames: b.push_whitelist_usernames,
    push_whitelist_teams: b.push_whitelist_teams,
    push_whitelist_deploy_keys: Boolean(b.push_whitelist_deploy_keys),
    enable_merge_whitelist: Boolean(b.enable_merge_whitelist),
    merge_whitelist_usernames: b.merge_whitelist_usernames,
    merge_whitelist_teams: b.merge_whitelist_teams,
    required_approvals: b.required_approvals ?? 0,
    enable_approvals_whitelist: Boolean(b.enable_approvals_whitelist),
    approvals_whitelist_username: b.approvals_whitelist_username,
    approvals_whitelist_teams: b.approvals_whitelist_teams,
    enable_status_check: Boolean(b.enable_status_check),
    status_check_contexts: b.status_check_contexts,
    block_on_rejected_reviews: Boolean(b.block_on_rejected_reviews),
    block_on_official_review_requests: Boolean(b.block_on_official_review_requests),
    block_on_outdated_branch: Boolean(b.block_on_outdated_branch),
    dismiss_stale_approvals: Boolean(b.dismiss_stale_approvals),
    ignore_stale_approvals: Boolean(b.ignore_stale_approvals),
    require_signed_commits: Boolean(b.require_signed_commits),
    protected_file_patterns: b.protected_file_patterns,
    unprotected_file_patterns: b.unprotected_file_patterns,
    apply_to_admins: Boolean(b.apply_to_admins),
    created_at: b.created_at,
    updated_at: b.updated_at,
  });
}

function renderProtection(b: Json): string {
  const push = !b.enable_push
    ? 'blocked for everyone (changes must go through pull requests)'
    : b.enable_push_whitelist
      ? `only ${who(b.push_whitelist_usernames, b.push_whitelist_teams)}${b.push_whitelist_deploy_keys ? ', plus deploy keys with write access' : ''}`
      : 'anyone with write access';
  const merge = b.enable_merge_whitelist ? `only ${who(b.merge_whitelist_usernames, b.merge_whitelist_teams)}` : 'anyone with write access';
  const approvals = b.required_approvals
    ? `${b.required_approvals}${b.enable_approvals_whitelist ? ` (counted only from ${who(b.approvals_whitelist_username, b.approvals_whitelist_teams)})` : ''}`
    : 'none';
  const checks = b.enable_status_check
    ? Array.isArray(b.status_check_contexts) && b.status_check_contexts.length
      ? `required: ${b.status_check_contexts.join(', ')}`
      : 'enabled (no contexts listed)'
    : 'not required';
  const blockers = [
    b.block_on_rejected_reviews && 'rejected reviews',
    b.block_on_official_review_requests && 'pending official review requests',
    b.block_on_outdated_branch && 'branch behind base',
  ].filter(Boolean);
  const stale = b.dismiss_stale_approvals ? 'dismissed on new commits' : b.ignore_stale_approvals ? 'not counted after new commits' : 'kept';
  return [
    `### ${b.rule_name || b.branch_name}`,
    '',
    bullets([
      ['Push', push],
      ['Merge', merge],
      ['Required approvals', approvals],
      ['Status checks', checks],
      ['Merging blocked by', blockers.length ? blockers.join(', ') : 'nothing extra'],
      ['Stale approvals', stale],
      ['Signed commits required', b.require_signed_commits ? 'yes' : 'no'],
      ['Protected files', b.protected_file_patterns],
      ['Unprotected files', b.unprotected_file_patterns],
      ['Applies to admins', b.apply_to_admins ? 'yes' : 'no'],
      ['Updated', fmtDate(b.updated_at)],
    ]),
  ].join('\n');
}

export const listBranchProtections = defineTool({
  name: 'forgejo_list_branch_protections',
  title: 'List branch protection rules',
  toolset: 'repo_admin',
  description:
    'List a repository\'s branch protection rules: who may push and merge (allowlists), required approvals, required status checks, ' +
    'review blockers, signed-commit requirement, protected file patterns and whether admins are bound too. ' +
    'Use forgejo_set_branch_protection to create or change a rule and forgejo_delete_branch_protection to remove one.',
  inputSchema: { ...repoRef(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, response_format }, ctx) {
    const rules = (await ctx.getClient().get<Json[]>(repoPath(owner, repo, 'branch_protections'))) ?? [];
    return formatResult(
      response_format,
      () =>
        rules.length
          ? [`## Branch protection rules in ${owner}/${repo} (${rules.length})`, '', rules.map(renderProtection).join('\n\n')].join('\n')
          : `${owner}/${repo} has no branch protection rules. Create one with forgejo_set_branch_protection.`,
      () => ({ rules: rules.map(projectProtection) }),
    );
  },
});

// Factories for the editable rule settings (fresh zod instances per use).
const optBool = (what: string) => z.boolean().optional().describe(what);
const nameList = (what: string) => z.array(z.string().trim().min(1).max(250)).max(100).optional().describe(what);

const protectionSettings = () => ({
  enable_push: optBool(
    'Allow direct pushes to matching branches. New rules default to false: nobody can push directly, so changes go through pull requests',
  ),
  enable_push_whitelist: optBool('With pushing enabled, only the users/teams in the push allowlist may push'),
  push_whitelist_usernames: nameList('Users allowed to push (replaces the current list). Implies enable_push and enable_push_whitelist'),
  push_whitelist_teams: nameList('Teams allowed to push, organization repositories only (replaces the current list)'),
  push_whitelist_deploy_keys: optBool('Also let deploy keys with write access push (part of the push allowlist)'),
  enable_merge_whitelist: optBool('Only the users/teams in the merge allowlist may merge pull requests into matching branches'),
  merge_whitelist_usernames: nameList('Users allowed to merge (replaces the current list). Implies enable_merge_whitelist'),
  merge_whitelist_teams: nameList('Teams allowed to merge, organization repositories only (replaces the current list)'),
  required_approvals: z.number().int().min(0).max(100).optional().describe('Approving reviews needed before a pull request can be merged (0 = none)'),
  enable_approvals_whitelist: optBool('Only count approvals from the users/teams in the approvals allowlist'),
  approvals_whitelist_username: nameList('Users whose approvals count (replaces the current list). Implies enable_approvals_whitelist'),
  approvals_whitelist_teams: nameList('Teams whose approvals count, organization repositories only (replaces the current list)'),
  enable_status_check: optBool('Require commit status checks (CI) to pass before merging'),
  status_check_contexts: nameList('Status check contexts that must pass; glob patterns allowed, e.g. "ci/build" or "ci/*". Implies enable_status_check'),
  block_on_rejected_reviews: optBool('Block merging while the pull request has a "request changes" review'),
  block_on_official_review_requests: optBool('Block merging while official review requests are still pending'),
  block_on_outdated_branch: optBool('Block merging while the pull request branch is behind the base branch'),
  dismiss_stale_approvals: optBool('Dismiss existing approvals when new commits are pushed'),
  ignore_stale_approvals: optBool('Do not count approvals made on older commits (without dismissing them)'),
  require_signed_commits: optBool('Reject pushes containing unsigned or unverifiable commits'),
  protected_file_patterns: z
    .string()
    .max(2000)
    .optional()
    .describe('Files nobody may change by push, as semicolon-separated globs (e.g. ".forgejo/workflows/**;LICENSE"); "" clears it'),
  unprotected_file_patterns: z
    .string()
    .max(2000)
    .optional()
    .describe('Files users with write access may push directly even when pushing is restricted, semicolon-separated globs; "" clears it'),
  apply_to_admins: optBool('Apply the rule to repository administrators too'),
});

const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;

/**
 * Forgejo only honours some settings together with their switches (e.g. a push
 * allowlist is ignored unless enable_push and enable_push_whitelist are sent as
 * true). Fill in the switches the caller left out, based on what they did pass
 * and the rule's current state. Returns the switches that were filled in.
 */
function applyImpliedSwitches(s: Json, current: Json): string[] {
  const filled: string[] = [];
  const set = (key: string, value: boolean) => {
    s[key] = value;
    filled.push(`${key}=${value}`);
  };
  const pushListGiven = nonEmpty(s.push_whitelist_usernames) || nonEmpty(s.push_whitelist_teams) || s.push_whitelist_deploy_keys === true;
  if (s.enable_push === false && (s.enable_push_whitelist === true || pushListGiven)) {
    throw new ToolInputError('enable_push: false blocks all direct pushes, so a push allowlist has no effect. Set enable_push: true to let the allowlist push.');
  }
  if (s.enable_push_whitelist === undefined && (pushListGiven || s.push_whitelist_deploy_keys !== undefined)) {
    set('enable_push_whitelist', pushListGiven || Boolean(current.enable_push_whitelist));
  }
  if (s.enable_push === undefined && s.enable_push_whitelist !== undefined) {
    set('enable_push', s.enable_push_whitelist === true || Boolean(current.enable_push));
  }
  if (s.enable_merge_whitelist === undefined && (nonEmpty(s.merge_whitelist_usernames) || nonEmpty(s.merge_whitelist_teams))) {
    set('enable_merge_whitelist', true);
  }
  if (s.enable_approvals_whitelist === undefined && (nonEmpty(s.approvals_whitelist_username) || nonEmpty(s.approvals_whitelist_teams))) {
    set('enable_approvals_whitelist', true);
  }
  if (s.enable_status_check === undefined && nonEmpty(s.status_check_contexts)) {
    set('enable_status_check', true);
  }
  return filled;
}

export const setBranchProtection = defineTool({
  name: 'forgejo_set_branch_protection',
  title: 'Create or update a branch protection rule',
  toolset: 'repo_admin',
  description:
    'Create a branch protection rule, or update the existing rule with the same `rule_name` (only the settings you pass change). ' +
    'rule_name is a branch name or a glob pattern such as "main" or "release/*". A new rule with no other settings blocks direct pushes ' +
    'and force-pushes to matching branches. Configure push/merge/approval allowlists, required approvals, required status checks, ' +
    'review blockers, signed commits and protected files. Use forgejo_list_branch_protections to see current rules.',
  inputSchema: {
    ...repoRef(),
    rule_name: z.string().trim().min(1).max(255).describe('Branch name or glob pattern the rule applies to, e.g. "main" or "release/*"'),
    ...protectionSettings(),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ owner, repo, rule_name, response_format, ...fields }, ctx) {
    const client = ctx.getClient();
    const settings: Json = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const rulePath = repoPath(owner, repo, 'branch_protections', seg(rule_name));
    const existing = await client.request<Json>('GET', rulePath, { okStatuses: [404] });
    const created = existing.status === 404;
    if (!created && !Object.keys(settings).length) {
      throw new ToolInputError(
        `A rule named "${rule_name}" already exists in ${owner}/${repo}; pass at least one setting to change. ` +
          'Use forgejo_list_branch_protections to see its current settings.',
      );
    }
    const filled = applyImpliedSwitches(settings, created ? {} : existing.data ?? {});
    const rule = created
      ? await client.post<Json>(repoPath(owner, repo, 'branch_protections'), { rule_name, ...settings })
      : await client.patch<Json>(rulePath, settings);
    const lines = [`${created ? 'Created' : 'Updated'} branch protection rule **${rule_name}** in ${owner}/${repo}.`];
    if (filled.length) {
      lines.push(`_Forgejo only applies some settings together with their switches, so these were also sent: ${filled.join(', ')}._`);
    }
    lines.push('', renderProtection({ rule_name, ...rule }));
    return formatResult(
      response_format,
      () => lines.join('\n'),
      () => ({ created, implied_settings: filled.length ? filled : undefined, rule: projectProtection({ rule_name, ...rule }) }),
    );
  },
});

export const deleteBranchProtection = defineTool({
  name: 'forgejo_delete_branch_protection',
  title: 'Delete a branch protection rule',
  toolset: 'repo_admin',
  description:
    'Delete a branch protection rule by its rule name (e.g. "main" or "release/*"). Matching branches lose all of the rule\'s restrictions ' +
    '(anyone with write access can push and force-push). Use forgejo_list_branch_protections to find rule names.',
  inputSchema: {
    ...repoRef(),
    rule_name: z.string().trim().min(1).max(255).describe('Exact rule name to delete, as shown by forgejo_list_branch_protections'),
  },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, rule_name }, ctx) {
    await ctx.getClient().delete(repoPath(owner, repo, 'branch_protections', seg(rule_name)));
    return textResult(`Deleted branch protection rule **${rule_name}** from ${owner}/${repo}.`);
  },
});

// =============================================================================
// Webhooks
// =============================================================================

/** Webhook types accepted by the API (CreateHookOption.type in Forgejo 14–17). */
const HOOK_TYPES = ['forgejo', 'gitea', 'gogs', 'slack', 'discord', 'dingtalk', 'telegram', 'msteams', 'feishu', 'wechatwork', 'packagist'] as const;

/** Compact webhook. Never includes the secret, the authorization header or type metadata (which can hold bot tokens). */
function projectHook(h: Json) {
  return compact({
    id: h.id,
    type: h.type,
    url: maskUrl(h.config?.url ?? h.url),
    content_type: h.config?.content_type ?? h.content_type,
    events: h.events,
    active: h.active,
    branch_filter: h.branch_filter,
    authorization_header_set: h.authorization_header ? true : undefined,
    created_at: h.created_at,
    updated_at: h.updated_at,
  });
}

function eventSummary(events: unknown): string {
  if (!Array.isArray(events) || !events.length) return '';
  return events.length > 6 ? `${events.slice(0, 6).join(', ')} +${events.length - 6} more` : events.join(', ');
}

export const listWebhooks = defineTool({
  name: 'forgejo_list_webhooks',
  title: 'List repository webhooks',
  toolset: 'repo_admin',
  description:
    'List a repository\'s webhooks: ID, type, target URL, events, active state, branch filter and last update. ' +
    'Secrets and authorization headers are never shown, and tokens embedded in target URLs are masked. ' +
    'Use forgejo_create_webhook to add one and forgejo_delete_webhook to remove one.',
  inputSchema: { ...repoRef(), ...pagination(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, page, limit, response_format }, ctx) {
    const result = await ctx.getClient().list<Json>(repoPath(owner, repo, 'hooks'), {}, { page, limit });
    const hooks = result.items.map(projectHook);
    return formatResult(
      response_format,
      () =>
        hooks.length
          ? [
              `## Webhooks of ${owner}/${repo}`,
              '',
              table(
                ['ID', 'Type', 'Target URL', 'Events', 'Active', 'Branch filter', 'Updated'],
                hooks.map(h => [h.id, h.type, h.url, eventSummary(h.events), h.active ? 'yes' : 'no', h.branch_filter, fmtDate(h.updated_at)]),
              ),
              '',
              pageFooter(result, 'webhooks'),
            ].join('\n')
          : `${owner}/${repo} has no webhooks${page > 1 ? ` on page ${page}` : ''}.`,
      () => ({ webhooks: hooks, ...pageMeta(result) }),
    );
  },
});

export const createWebhook = defineTool({
  name: 'forgejo_create_webhook',
  title: 'Create a repository webhook',
  toolset: 'repo_admin',
  description:
    'Add a webhook that makes Forgejo POST to a URL when events happen in the repository (push by default). `type` picks the payload ' +
    'format: "forgejo" (generic JSON or form) or a service integration (Slack needs extra_config.channel). Only pass `secret` or ' +
    '`authorization_header` if the user explicitly provided them; never invent one. They are stored by Forgejo and never shown again. ' +
    'Set `test` to send a test push event right away. Use forgejo_list_webhooks to review webhooks and forgejo_delete_webhook to remove one.',
  inputSchema: {
    ...repoRef(),
    url: z.string().trim().url().max(2048).describe('Target URL Forgejo sends the events to'),
    type: z
      .enum(HOOK_TYPES)
      .default('forgejo')
      .describe('Payload format: "forgejo" (default), "gitea", "gogs", or a service: slack, discord, dingtalk, telegram, msteams, feishu, wechatwork, packagist'),
    content_type: z.enum(['json', 'form']).default('json').describe('Body encoding for forgejo/gitea/gogs payloads: "json" (default) or "form"'),
    events: z
      .array(z.string().trim().regex(/^[a-z_]+$/, 'Use lowercase event names like "push"'))
      .min(1)
      .max(40)
      .default(['push'])
      .describe(
        'Events that trigger it (default ["push"]). Common: push, create, delete, fork, issues, issue_comment, pull_request, ' +
          'pull_request_review, pull_request_sync, release, wiki, repository, package. "issues" and "pull_request" include their sub-events (assign, label, milestone, comment)',
      ),
    branch_filter: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe('Only fire push/create/delete events for matching branches, glob syntax (e.g. "main" or "{main,release/*}"). Default: all branches'),
    active: z.boolean().default(true).describe('Activate the webhook immediately (default true)'),
    secret: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Secret for signing payloads (signature headers). ONLY pass a secret the user explicitly gave you'),
    authorization_header: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe('Authorization header value sent with every delivery, e.g. "Bearer <token>". ONLY pass one the user explicitly gave you'),
    extra_config: z
      .record(z.string().max(1000))
      .optional()
      .describe('Type-specific settings, e.g. Slack {"channel": "#dev", "username": "forgejo"}; Packagist {"username", "api_token", "package_url"}'),
    test: z.boolean().default(false).describe('Send a test push event right after creating the webhook'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler({ owner, repo, url, type, content_type, events, branch_filter, active, secret, authorization_header, extra_config, test, response_format }, ctx) {
    const reserved = Object.keys(extra_config ?? {}).filter(k => ['url', 'content_type', 'secret'].includes(k));
    if (reserved.length) {
      throw new ToolInputError(`Pass ${reserved.join(', ')} as top-level parameters, not inside extra_config.`);
    }
    const client = ctx.getClient();
    const config: Record<string, string> = { ...(extra_config ?? {}), url, content_type };
    if (secret) config.secret = secret;
    const hook = await client.post<Json>(repoPath(owner, repo, 'hooks'), { type, config, events, active, branch_filter, authorization_header });

    // The webhook exists now, so a failed test is reported instead of failing the call (retrying would create a duplicate).
    let testOutcome: { sent: boolean; error?: string } | undefined;
    if (test) {
      try {
        await client.post(repoPath(owner, repo, 'hooks', Number(hook.id), 'tests'));
        testOutcome = { sent: true };
      } catch (error) {
        if (!(error instanceof ForgejoError)) throw error;
        testOutcome = { sent: false, error: error.message };
      }
    }

    const p = projectHook(hook);
    const settingsUrl = client.webUrl(`/${owner}/${repo}/settings/hooks/${p.id}`);
    return formatResult(
      response_format,
      () =>
        [
          `Created webhook **#${p.id}** (${p.type}) on ${owner}/${repo}.`,
          '',
          bullets([
            ['Target', p.url],
            ['Content type', p.content_type],
            ['Events', p.events],
            ['Branch filter', p.branch_filter],
            ['Active', p.active ? 'yes' : 'no'],
            ['Secret', secret ? 'set (hidden)' : undefined],
            ['Authorization header', authorization_header ? 'set (hidden)' : undefined],
            ['Deliveries', settingsUrl],
          ]),
          testOutcome
            ? testOutcome.sent
              ? '\nTest push event sent; check the delivery result on the webhook settings page.'
              : `\nThe webhook was created, but sending the test event failed: ${testOutcome.error}`
            : '',
        ]
          .join('\n')
          .trimEnd(),
      () => compact({ ...p, secret_set: secret ? true : undefined, settings_url: settingsUrl, test: testOutcome }),
    );
  },
});

export const deleteWebhook = defineTool({
  name: 'forgejo_delete_webhook',
  title: 'Delete a repository webhook',
  toolset: 'repo_admin',
  description:
    'Delete a repository webhook by its numeric ID; the target stops receiving events and the delivery history is lost. ' +
    'Use forgejo_list_webhooks to find the ID.',
  inputSchema: {
    ...repoRef(),
    id: z.number().int().positive().describe('Webhook ID, as shown by forgejo_list_webhooks'),
  },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, id }, ctx) {
    await ctx.getClient().delete(repoPath(owner, repo, 'hooks', id));
    return textResult(`Deleted webhook #${id} from ${owner}/${repo}.`);
  },
});

// =============================================================================
// Mirrors
// =============================================================================

/** Compact push mirror. The remote password is never returned by Forgejo; the address is masked anyway. */
function projectPushMirror(m: Json) {
  return compact({
    remote_name: m.remote_name,
    remote_address: maskUrl(m.remote_address),
    interval: m.interval,
    sync_on_commit: m.sync_on_commit,
    branch_filter: m.branch_filter,
    last_update: m.last_update,
    last_error: maskText(m.last_error),
    created: m.created,
    public_key: m.public_key,
  });
}

function sshKeyInstructions(publicKey: string): string {
  return [
    'Add this SSH public key to the remote repository as a deploy key **with write access** ' +
      '(GitHub: Settings → Deploy keys → Add deploy key, tick "Allow write access"):',
    '',
    codeBlock(publicKey),
  ].join('\n');
}

export const listPushMirrors = defineTool({
  name: 'forgejo_list_push_mirrors',
  title: 'List push mirrors',
  toolset: 'repo_admin',
  description:
    'List a repository\'s push mirrors (remotes Forgejo pushes to, e.g. a GitHub copy): remote name, remote address, sync interval, ' +
    'sync-on-commit, branch filter, last sync time and last error. Use forgejo_sync_mirror to push now, forgejo_create_push_mirror ' +
    'to add one and forgejo_delete_push_mirror to remove one.',
  inputSchema: { ...repoRef(), ...pagination(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, page, limit, response_format }, ctx) {
    const result = await ctx.getClient().list<Json>(repoPath(owner, repo, 'push_mirrors'), {}, { page, limit });
    const mirrors = result.items.map(projectPushMirror);
    return formatResult(
      response_format,
      () => {
        if (!mirrors.length) return `${owner}/${repo} has no push mirrors${page > 1 ? ` on page ${page}` : ''}. Add one with forgejo_create_push_mirror.`;
        const lines = [
          `## Push mirrors of ${owner}/${repo}`,
          '',
          table(
            ['Remote name', 'Address', 'Interval', 'On commit', 'Branches', 'Last sync', 'Last error'],
            mirrors.map(m => [
              m.remote_name,
              m.remote_address,
              m.interval,
              m.sync_on_commit ? 'yes' : 'no',
              m.branch_filter || 'all',
              fmtDate(m.last_update) || 'never',
              (m.last_error ?? '').slice(0, 200),
            ]),
          ),
          '',
          pageFooter(result, 'push mirrors'),
        ];
        for (const m of mirrors.filter(x => x.public_key)) {
          lines.push('', `SSH public key of **${m.remote_name}** (must be a deploy key with write access on the remote):`, '', codeBlock(String(m.public_key)));
        }
        return lines.join('\n');
      },
      () => ({ push_mirrors: mirrors, ...pageMeta(result) }),
    );
  },
});

export const createPushMirror = defineTool({
  name: 'forgejo_create_push_mirror',
  title: 'Create a push mirror',
  toolset: 'repo_admin',
  description:
    'Make Forgejo push this repository to another Git remote on a schedule and/or after every commit, e.g. to keep a GitHub copy in sync. ' +
    'Authenticate with `remote_username` + `remote_password` (for GitHub: your user name and a personal access token with write access), ' +
    'or with `use_ssh` (Forgejo generates a key pair; add the returned public key on the remote as a deploy key with write access). ' +
    'Only pass credentials the user explicitly provided; never invent them. They are stored by Forgejo and never shown again. ' +
    'Use forgejo_sync_mirror to push immediately and forgejo_list_push_mirrors to check the result.',
  inputSchema: {
    ...repoRef(),
    remote_address: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .describe('Target repository URL, e.g. https://github.com/owner/repo.git (or an SSH address like git@github.com:owner/repo.git with use_ssh)'),
    remote_username: z.string().trim().min(1).max(200).optional().describe('User name on the remote. ONLY pass credentials the user explicitly gave you'),
    remote_password: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe('Password or access token for the remote (needs remote_username). ONLY pass a token the user explicitly gave you'),
    use_ssh: z
      .boolean()
      .default(false)
      .describe('Authenticate with an SSH key pair generated by Forgejo instead of a password (the public key is returned)'),
    interval: z
      .string()
      .trim()
      .min(1)
      .regex(/^(0|(\d+h)?(\d+m)?(\d+s)?)$/, 'Use a duration like "8h0m0s", "1h30m" or "10m", or "0"')
      .default('8h0m0s')
      .describe('Scheduled push interval as a duration like "8h0m0s" (default) or "1h30m" (instance minimum is usually 10m); "0" disables scheduled pushes'),
    sync_on_commit: z.boolean().default(true).describe('Also push whenever new commits arrive (default true)'),
    branch_filter: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe('Only mirror matching branches, glob syntax (e.g. "main" or "{main,release/*}"). Default: all branches'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler({ owner, repo, remote_address, remote_username, remote_password, use_ssh, interval, sync_on_commit, branch_filter, response_format }, ctx) {
    if (use_ssh && (remote_username || remote_password)) {
      throw new ToolInputError('use_ssh authenticates with a generated key pair; do not pass remote_username or remote_password with it.');
    }
    if (!use_ssh && !/^https?:\/\//i.test(remote_address)) {
      throw new ToolInputError('remote_address must be an http(s):// URL. For SSH addresses (git@host:owner/repo.git) set use_ssh: true.');
    }
    if (/^https?:\/\//i.test(remote_address)) {
      let parsed: URL;
      try {
        parsed = new URL(remote_address);
      } catch {
        throw new ToolInputError(`"${maskUrl(remote_address)}" is not a valid URL.`);
      }
      if (parsed.username || parsed.password) {
        throw new ToolInputError('Do not put credentials inside remote_address; pass them as remote_username and remote_password instead.');
      }
    }
    if (remote_password && !remote_username) {
      throw new ToolInputError('remote_password needs remote_username too (for GitHub: your GitHub user name with a personal access token as the password).');
    }

    const client = ctx.getClient();
    const mirror = await client.post<Json>(repoPath(owner, repo, 'push_mirrors'), {
      remote_address,
      remote_username,
      remote_password,
      interval,
      sync_on_commit,
      branch_filter,
      use_ssh: use_ssh || undefined,
    });
    const p = projectPushMirror(mirror ?? {});
    const auth = use_ssh ? 'SSH key' : remote_password ? 'user name + password/token (stored, hidden)' : 'none';
    const lines = [
      `Created push mirror **${p.remote_name ?? '(unnamed)'}** on ${owner}/${repo} → ${p.remote_address ?? maskUrl(remote_address)}.`,
      '',
      bullets([
        ['Interval', p.interval ?? interval],
        ['Push on every commit', (p.sync_on_commit ?? sync_on_commit) ? 'yes' : 'no'],
        ['Branches', p.branch_filter || 'all'],
        ['Authentication', auth],
      ]),
    ];
    if (p.public_key) lines.push('', sshKeyInstructions(String(p.public_key)));
    lines.push('', 'To push right away, call forgejo_sync_mirror with which: "push".');
    return formatResult(response_format, () => lines.join('\n'), () => p);
  },
});

export const deletePushMirror = defineTool({
  name: 'forgejo_delete_push_mirror',
  title: 'Delete a push mirror',
  toolset: 'repo_admin',
  description:
    'Remove a push mirror by its remote name, so Forgejo stops pushing to that remote (the remote repository itself is not touched). ' +
    'Use forgejo_list_push_mirrors to find the remote name.',
  inputSchema: {
    ...repoRef(),
    remote_name: z.string().trim().min(1).max(255).describe('Remote name of the push mirror, as shown by forgejo_list_push_mirrors (e.g. "remote_mirror_abc123")'),
  },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, remote_name }, ctx) {
    await ctx.getClient().delete(repoPath(owner, repo, 'push_mirrors', seg(remote_name)));
    return textResult(`Deleted push mirror **${remote_name}** from ${owner}/${repo}. The remote repository itself was not changed.`);
  },
});

/** Queue a pull-mirror sync (fetch from the upstream source). Throws if the repository is not a pull mirror. */
async function syncPullMirror(client: ForgejoClient, owner: string, repo: string): Promise<string> {
  await client.post(repoPath(owner, repo, 'mirror-sync'));
  return 'Pull mirror: sync queued (Forgejo fetches the latest changes from the source repository).';
}

/** Queue a sync of every push mirror. Throws a ToolInputError if there are none. */
async function syncPushMirrors(client: ForgejoClient, owner: string, repo: string): Promise<string> {
  const mirrors = await client.list<Json>(repoPath(owner, repo, 'push_mirrors'), {}, { limit: 50 });
  const count = mirrors.total ?? mirrors.items.length;
  if (!count) {
    throw new ToolInputError(`${owner}/${repo} has no push mirrors, so there is nothing to push. Create one with forgejo_create_push_mirror.`);
  }
  await client.post(repoPath(owner, repo, 'push_mirrors-sync'));
  const names = mirrors.items.map(m => m.remote_name).filter(Boolean);
  return `Push mirrors: sync queued for ${plural(count, 'mirror')}${names.length ? ` (${names.join(', ')})` : ''}.`;
}

export const syncMirror = defineTool({
  name: 'forgejo_sync_mirror',
  title: 'Sync mirrors now',
  toolset: 'repo_admin',
  description:
    'Trigger mirror synchronisation now instead of waiting for the schedule. which: "pull" fetches from the source of a pull-mirror ' +
    'repository (one created with forgejo_migrate_repo mirror: true), "push" pushes to all push mirrors, "both" (default) does both and ' +
    'reports which parts applied. Syncs run in the background: check forgejo_list_push_mirrors (last sync / last error) or forgejo_get_repo afterwards.',
  inputSchema: {
    ...repoRef(),
    which: z
      .enum(['pull', 'push', 'both'])
      .default('both')
      .describe('"pull" (fetch from the source), "push" (push to all push mirrors) or "both" (default)'),
  },
  annotations: WRITE,
  async handler({ owner, repo, which }, ctx) {
    const client = ctx.getClient();
    const footer = 'Syncs run in the background; check forgejo_list_push_mirrors or forgejo_get_repo for the result.';
    if (which === 'pull') return textResult(`${await syncPullMirror(client, owner, repo)}\n\n${footer}`);
    if (which === 'push') return textResult(`${await syncPushMirrors(client, owner, repo)}\n\n${footer}`);

    // "both": run each part and report it; a repository is often only one kind of mirror.
    const lines: string[] = [];
    let triggered = 0;
    for (const [label, run] of [
      ['Pull mirror', () => syncPullMirror(client, owner, repo)],
      ['Push mirrors', () => syncPushMirrors(client, owner, repo)],
    ] as const) {
      try {
        lines.push(`- ${await run()}`);
        triggered++;
      } catch (error) {
        if (!(error instanceof ForgejoError) && !(error instanceof ToolInputError)) throw error;
        lines.push(`- ${label}: not synced. ${error.message}`);
      }
    }
    if (!triggered) return errorResult(`Nothing was synced for ${owner}/${repo}:\n${lines.join('\n')}`);
    return textResult([`Mirror sync for ${owner}/${repo}:`, ...lines, '', footer].join('\n'));
  },
});

export const repoAdminTools = [
  deleteRepo,
  listCollaborators,
  setCollaborator,
  removeCollaborator,
  listBranchProtections,
  setBranchProtection,
  deleteBranchProtection,
  listWebhooks,
  createWebhook,
  deleteWebhook,
  listPushMirrors,
  createPushMirror,
  deletePushMirror,
  syncMirror,
];
