/**
 * labels toolset: create, update and delete labels (repository or organization)
 * and milestones.
 *
 * The read tools (forgejo_list_labels, forgejo_list_milestones) live in the
 * issues toolset; this toolset only manages them.
 */

import { z } from 'zod';
import type { ForgejoClient } from '../forgejo/client.js';
import { ForgejoError } from '../forgejo/errors.js';
import { projectLabel, projectMilestone, type Json } from '../forgejo/projections.js';
import { repoPath } from '../forgejo/url.js';
import { bullets, fmtDate } from '../utils/format.js';
import { fetchAllPages } from './lookups.js';
import {
  DESTRUCTIVE,
  WRITE,
  WRITE_IDEMPOTENT,
  ToolInputError,
  defineTool,
  formatResult,
  repoRef,
  responseFormatSchema,
  textResult,
} from './shared.js';

// =============================================================================
// Schema pieces (factories: call per use, never share one instance)
// =============================================================================

const optionalOwner = () =>
  z.string().trim().min(1).max(100).optional().describe('Repository owner, for a repository label (use together with `repo`; omit when using `org`)');
const optionalRepo = () =>
  z.string().trim().min(1).max(100).optional().describe('Repository name, for a repository label (use together with `owner`; omit when using `org`)');
const optionalOrg = () =>
  z.string().trim().min(1).max(100).optional().describe('Organization name, for an organization-wide label (omit when using `owner` + `repo`)');

/** owner + repo OR org, spread into an input schema. */
const labelTargetSchema = () => ({ owner: optionalOwner(), repo: optionalRepo(), org: optionalOrg() });

const colorSchema = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex colour like "#ee0701" or "ee0701"')
    .describe(`${what}: hex colour, with or without "#" (e.g. "#ee0701", "0e8a16", "fbca04")`);

const labelRefSchema = () =>
  z
    .union([z.number().int().positive(), z.string().trim().min(1).max(255)])
    .describe('The label: its numeric ID, or its exact name (matched case-insensitively)');

const milestoneRefSchema = () =>
  z
    .union([z.number().int().positive(), z.string().trim().min(1).max(255)])
    .describe('The milestone: its numeric ID, or its exact title');

const dueOnSchema = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe('Due date: "YYYY-MM-DD" (treated as the end of that day, 23:59:59 UTC) or a full ISO 8601 timestamp');

const EXCLUSIVE_HELP =
  'Scoped label: when true, a name like "priority/high" makes all "priority/…" labels mutually exclusive (an issue can have only one of them)';

// =============================================================================
// Helpers
// =============================================================================

/** "#EE0701", "ee0701" or "e01" → "#ee0701" (the form Forgejo's API documents). */
export function normalizeColor(input: string): string {
  const hex = input.trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
    throw new ToolInputError(`"${input}" is not a hex colour. Use something like "#ee0701".`);
  }
  const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
  return `#${full.toLowerCase()}`;
}

/** "2026-12-31" → "2026-12-31T23:59:59Z"; any other parseable date → RFC 3339 in UTC. */
export function toRfc3339(value: string): string {
  const input = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const d = new Date(`${input}T23:59:59Z`);
    // Reject impossible dates like 2026-02-31 (Date would roll them over).
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input) {
      throw new ToolInputError(`"${value}" is not a valid date. Use YYYY-MM-DD, e.g. 2026-12-31.`);
    }
    return `${input}T23:59:59Z`;
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new ToolInputError(`"${value}" is not a valid date. Use YYYY-MM-DD or an ISO 8601 timestamp like 2026-12-31T17:00:00+08:00.`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface LabelTarget {
  /** API path of the label collection, e.g. /repos/o/r/labels or /orgs/acme/labels */
  base: string;
  /** Human description, e.g. "o/r" or "organization acme" */
  where: string;
  isOrg: boolean;
}

/** Exactly one of owner+repo (repository label) or org (organization label). */
function labelTarget(args: { owner?: string; repo?: string; org?: string }): LabelTarget {
  const hasRepo = Boolean(args.owner || args.repo);
  if (args.org && hasRepo) {
    throw new ToolInputError('Pass either owner + repo (repository label) or org (organization label), not both.');
  }
  if (args.org) {
    return { base: `/orgs/${encodeURIComponent(args.org)}/labels`, where: `organization ${args.org}`, isOrg: true };
  }
  if (args.owner && args.repo) {
    return { base: repoPath(args.owner, args.repo, 'labels'), where: `${args.owner}/${args.repo}`, isOrg: false };
  }
  if (hasRepo) throw new ToolInputError('A repository label needs both owner and repo.');
  throw new ToolInputError('Pass owner + repo for a repository label, or org for an organization label.');
}

/**
 * Label ID or name → { id, name }. Names are matched case-insensitively against
 * the target's own labels (repo labels for a repo, org labels for an org).
 * A string of digits that matches no name is treated as an ID.
 */
async function resolveLabel(client: ForgejoClient, target: LabelTarget, label: string | number): Promise<{ id: number; name?: string }> {
  if (typeof label === 'number') return { id: label };
  const labels = await fetchAllPages<Json>(client, target.base);
  const lower = label.toLowerCase();
  const match = labels.find(l => l.name === label) ?? labels.find(l => String(l.name).toLowerCase() === lower);
  if (match) return { id: Number(match.id), name: String(match.name) };
  if (/^\d+$/.test(label)) return { id: Number(label) };
  const known = labels.map(l => `"${l.name}"`).join(', ') || '(none)';
  throw new ToolInputError(
    `No label named "${label}" in ${target.where}. Available labels: ${known}.` +
      (target.isOrg ? '' : ' If it is an organization-wide label, pass org instead of owner + repo.'),
  );
}

function renderLabel(l: Json): string {
  const p = projectLabel(l);
  return bullets([
    ['ID', p.id],
    ['Color', p.color],
    ['Description', p.description],
    ['Exclusive (scoped)', p.exclusive ? 'yes' : undefined],
    ['Archived', p.archived ? 'yes' : undefined],
  ]);
}

function renderMilestone(m: Json): string {
  const p = projectMilestone(m);
  return bullets([
    ['ID', p.id],
    ['State', p.state],
    ['Due', fmtDate(p.due_on)],
    ['Issues', p.open_issues !== undefined || p.closed_issues !== undefined ? `${p.open_issues ?? 0} open / ${p.closed_issues ?? 0} closed` : undefined],
  ]);
}

/** Path of one milestone; the API accepts a title in place of the ID. */
function milestonePath(owner: string, repo: string, milestone: string | number): string {
  return repoPath(owner, repo, 'milestones', encodeURIComponent(String(milestone)));
}

/** Turn a 404 on a milestone into a pointer at forgejo_list_milestones. */
function milestoneNotFound(error: unknown, owner: string, repo: string, milestone: string | number): never {
  if (error instanceof ForgejoError && error.kind === 'not_found') {
    throw new ToolInputError(
      `No milestone with ID or title "${milestone}" in ${owner}/${repo} (or the repository is not visible to your token). ` +
        'Use forgejo_list_milestones to see the available milestones.',
    );
  }
  throw error;
}

// =============================================================================
// Labels
// =============================================================================

export const createLabel = defineTool({
  name: 'forgejo_create_label',
  title: 'Create a label',
  toolset: 'labels',
  description:
    'Create a label in a repository (owner + repo) or an organization-wide label shared by all its repositories (org). ' +
    'Scoped labels: name it "scope/value" (e.g. "priority/high") and set exclusive=true so an issue can carry only one label per scope. ' +
    'Use forgejo_list_labels (issues toolset) to see existing labels, and forgejo_update_issue_labels to put labels on issues.',
  inputSchema: {
    ...labelTargetSchema(),
    name: z.string().trim().min(1).max(255).describe('Label name, e.g. "bug" or "priority/high"'),
    color: colorSchema('Label colour'),
    description: z.string().max(500).optional().describe('Short description shown in the label picker'),
    exclusive: z.boolean().optional().describe(EXCLUSIVE_HELP),
    archived: z.boolean().optional().describe('Create it archived (hidden from label pickers, kept on existing issues)'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler({ owner, repo, org, name, color, description, exclusive, archived, response_format }, ctx) {
    const target = labelTarget({ owner, repo, org });
    const client = ctx.getClient();
    const created = await client.post<Json>(target.base, {
      name,
      color: normalizeColor(color),
      description,
      exclusive,
      is_archived: archived,
    });
    return formatResult(
      response_format,
      () => `Created label **${created.name}** in ${target.where}.\n\n${renderLabel(created)}`,
      () => projectLabel(created),
    );
  },
});

export const updateLabel = defineTool({
  name: 'forgejo_update_label',
  title: 'Update a label',
  toolset: 'labels',
  description:
    'Rename a label or change its colour, description, scoped/exclusive flag or archived state. Works for repository labels ' +
    '(owner + repo) and organization labels (org). The label can be given by ID or by name. Only the fields you pass are changed; ' +
    'issues keep the label. Use forgejo_list_labels (issues toolset) to find label names and IDs.',
  inputSchema: {
    ...labelTargetSchema(),
    label: labelRefSchema(),
    name: z.string().trim().min(1).max(255).optional().describe('New name'),
    color: colorSchema('New colour').optional(),
    description: z.string().max(500).optional().describe('New description (an empty string clears it)'),
    exclusive: z.boolean().optional().describe(EXCLUSIVE_HELP),
    archived: z.boolean().optional().describe('Archive (hide from label pickers) or unarchive the label'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ owner, repo, org, label, name, color, description, exclusive, archived, response_format }, ctx) {
    const target = labelTarget({ owner, repo, org });
    const patch = Object.fromEntries(
      Object.entries({
        name,
        color: color !== undefined ? normalizeColor(color) : undefined,
        description,
        exclusive,
        is_archived: archived,
      }).filter(([, v]) => v !== undefined),
    );
    if (!Object.keys(patch).length) {
      throw new ToolInputError('Nothing to change: pass at least one of name, color, description, exclusive or archived.');
    }
    const client = ctx.getClient();
    const { id } = await resolveLabel(client, target, label);
    const updated = await client.patch<Json>(`${target.base}/${id}`, patch);
    return formatResult(
      response_format,
      () => `Updated label **${updated.name}** in ${target.where}.\n\n${renderLabel(updated)}`,
      () => projectLabel(updated),
    );
  },
});

export const deleteLabel = defineTool({
  name: 'forgejo_delete_label',
  title: 'Delete a label',
  toolset: 'labels',
  description:
    'Permanently delete a repository label (owner + repo) or organization label (org), given by ID or name. ' +
    'The label is removed from every issue and pull request that has it, and this cannot be undone. ' +
    'To hide a label but keep it on existing issues, use forgejo_update_label with archived=true instead.',
  inputSchema: { ...labelTargetSchema(), label: labelRefSchema() },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, org, label }, ctx) {
    const target = labelTarget({ owner, repo, org });
    const client = ctx.getClient();
    const { id, name } = await resolveLabel(client, target, label);
    await client.delete(`${target.base}/${id}`);
    return textResult(`Deleted label ${name ? `**${name}** (ID ${id})` : `ID ${id}`} from ${target.where}.`);
  },
});

// =============================================================================
// Milestones
// =============================================================================

export const createMilestone = defineTool({
  name: 'forgejo_create_milestone',
  title: 'Create a milestone',
  toolset: 'labels',
  description:
    'Create a milestone in a repository, with an optional description and due date. Assign issues and pull requests to it ' +
    'with forgejo_create_issue / forgejo_update_issue (milestone by title or ID). Use forgejo_list_milestones (issues toolset) ' +
    'to see existing milestones.',
  inputSchema: {
    ...repoRef(),
    title: z.string().trim().min(1).max(255).describe('Milestone title, e.g. "v1.2"'),
    description: z.string().max(10_000).optional().describe('Milestone description (markdown)'),
    due_on: dueOnSchema().optional(),
    state: z.enum(['open', 'closed']).optional().describe('Initial state (default "open")'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler({ owner, repo, title, description, due_on, state, response_format }, ctx) {
    const dueOn = due_on !== undefined ? toRfc3339(due_on) : undefined;
    const client = ctx.getClient();
    const created = await client.post<Json>(repoPath(owner, repo, 'milestones'), { title, description, due_on: dueOn, state });
    return formatResult(
      response_format,
      () => `Created milestone **${created.title}** in ${owner}/${repo}.\n\n${renderMilestone(created)}`,
      () => projectMilestone(created),
    );
  },
});

export const updateMilestone = defineTool({
  name: 'forgejo_update_milestone',
  title: 'Update a milestone',
  toolset: 'labels',
  description:
    'Change a milestone: rename it, edit its description or due date, or close/reopen it (state "closed"/"open"). ' +
    'The milestone can be given by ID or title. Only the fields you pass are changed. ' +
    'Use forgejo_list_milestones (issues toolset) to find milestones.',
  inputSchema: {
    ...repoRef(),
    milestone: milestoneRefSchema(),
    title: z.string().trim().min(1).max(255).optional().describe('New title'),
    description: z.string().max(10_000).optional().describe('New description (markdown)'),
    due_on: dueOnSchema().optional(),
    state: z.enum(['open', 'closed']).optional().describe('"closed" to close the milestone, "open" to reopen it'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ owner, repo, milestone, title, description, due_on, state, response_format }, ctx) {
    const patch = Object.fromEntries(
      Object.entries({ title, description, due_on: due_on !== undefined ? toRfc3339(due_on) : undefined, state }).filter(([, v]) => v !== undefined),
    );
    if (!Object.keys(patch).length) {
      throw new ToolInputError('Nothing to change: pass at least one of title, description, due_on or state.');
    }
    const client = ctx.getClient();
    const updated = await client.patch<Json>(milestonePath(owner, repo, milestone), patch).catch(error => milestoneNotFound(error, owner, repo, milestone));
    return formatResult(
      response_format,
      () => `Updated milestone **${updated.title}** in ${owner}/${repo}.\n\n${renderMilestone(updated)}`,
      () => projectMilestone(updated),
    );
  },
});

export const deleteMilestone = defineTool({
  name: 'forgejo_delete_milestone',
  title: 'Delete a milestone',
  toolset: 'labels',
  description:
    'Permanently delete a milestone (by ID or title). Issues and pull requests in it are kept but no longer belong to any milestone. ' +
    'This cannot be undone; to finish a milestone instead, close it with forgejo_update_milestone (state "closed").',
  inputSchema: { ...repoRef(), milestone: milestoneRefSchema() },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, milestone }, ctx) {
    const client = ctx.getClient();
    await client.delete(milestonePath(owner, repo, milestone)).catch(error => milestoneNotFound(error, owner, repo, milestone));
    return textResult(`Deleted milestone ${typeof milestone === 'number' ? `ID ${milestone}` : `"${milestone}"`} from ${owner}/${repo}.`);
  },
});

export const labelTools = [createLabel, updateLabel, deleteLabel, createMilestone, updateMilestone, deleteMilestone];
