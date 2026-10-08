/**
 * issues toolset: issues, comments, issue labels, milestones and global issue search.
 *
 * Issues and pull requests share one number sequence per repository, so most
 * of these tools (comments, labels) also work on pull requests.
 */

import { z } from 'zod';
import { compact, labelNames, login, logins, projectComment, projectIssue, projectLabel, projectMilestone, type Json } from '../forgejo/projections.js';
import { repoPath } from '../forgejo/url.js';
import { bullets, fmtDate, table, untrusted } from '../utils/format.js';
import { repoAndOrgLabels, resolveLabelIds, resolveMilestoneId } from './lookups.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  WRITE_IDEMPOTENT,
  ToolInputError,
  defineTool,
  formatResult,
  indexSchema,
  labelListSchema,
  pageFooter,
  pageMeta,
  pagination,
  repoRef,
  responseFormatSchema,
  stateSchema,
  textResult,
  userListSchema,
} from './shared.js';

// =============================================================================
// Rendering
// =============================================================================

export function renderIssueTable(issues: Json[], showRepo = false): string {
  const headers = showRepo
    ? ['Repository', '#', 'Title', 'State', 'Labels', 'Assignees', 'Updated']
    : ['#', 'Title', 'State', 'Labels', 'Assignees', 'Author', 'Updated'];
  return table(
    headers,
    issues.map(i => {
      const kind = i.pull_request ? 'PR ' : '';
      const state = i.pull_request?.merged ? 'merged' : i.state;
      const base = [`${kind}#${i.number}`, String(i.title ?? '').slice(0, 90), state, labelNames(i.labels).join(', '), logins(i.assignees).join(', ')];
      return showRepo ? [i.repository?.full_name ?? '', ...base, fmtDate(i.updated_at)] : [...base, login(i.user), fmtDate(i.updated_at)];
    }),
  );
}

function renderComment(c: Json): string {
  const edited = c.updated_at && c.updated_at !== c.created_at ? `, edited ${fmtDate(c.updated_at)}` : '';
  return untrusted(c.body, `Comment ${c.id} by @${login(c.user)} on ${fmtDate(c.created_at)}${edited}`);
}

export function renderIssue(i: Json, comments: Json[] = [], totalComments?: number): string {
  const p = projectIssue(i);
  const kind = i.pull_request ? 'Pull request' : 'Issue';
  const lines = [
    `## ${kind} #${p.number}: ${p.title}`,
    '',
    bullets([
      ['State', p.merged ? 'merged' : p.state],
      ['Author', p.author ? `@${p.author}` : undefined],
      ['Labels', p.labels],
      ['Assignees', p.assignees?.map(a => `@${a}`)],
      ['Milestone', p.milestone],
      ['Due date', fmtDate(p.due_date)],
      ['Branch/ref', p.ref],
      ['Locked', p.locked ? 'yes' : undefined],
      ['Comments', p.comments],
      ['Created', fmtDate(p.created_at)],
      ['Updated', fmtDate(p.updated_at)],
      ['Closed', fmtDate(p.closed_at)],
      ['Web', p.html_url],
    ]),
    '',
    untrusted(i.body, `Description by @${p.author}`),
  ];
  if (comments.length) {
    const total = totalComments ?? comments.length;
    lines.push('', `### Comments (${total > comments.length ? `latest ${comments.length} of ${total}` : total})`, '', comments.map(renderComment).join('\n\n'));
    if (total > comments.length) lines.push('', '_Older comments not shown: use forgejo_list_issue_comments._');
  }
  if (i.pull_request) lines.push('', '_This is a pull request: forgejo_get_pull_request shows branches, mergeability and checks._');
  return lines.join('\n');
}

const milestoneInputSchema = () =>
  z.union([z.string().trim().min(1).max(250), z.number().int().nonnegative()]).describe('Milestone title or ID');

const dueDateSchema = () =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, 'Use YYYY-MM-DD or an ISO date-time')
    .describe('Due date, YYYY-MM-DD (or ISO 8601)');

/** "2026-10-31" → "2026-10-31T00:00:00Z" (the API wants a full date-time). */
function toDateTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
}

// =============================================================================
// Listing and searching
// =============================================================================

export const listIssues = defineTool({
  name: 'forgejo_list_issues',
  title: 'List issues in a repository',
  toolset: 'issues',
  description:
    'List issues (or pull requests, with type="pulls") in one repository, filtered by state, labels, milestones, keyword, author, ' +
    'assignee, mention and update time. For issues across all repositories (e.g. "assigned to me"), use forgejo_search_issues.',
  inputSchema: {
    ...repoRef(),
    state: stateSchema('open'),
    type: z.enum(['issues', 'pulls', 'all']).default('issues').describe('"issues" (default), "pulls" or "all"'),
    labels: z.array(z.string().trim().min(1)).optional().describe('Only items with ALL of these label names'),
    milestones: z.array(z.string().trim().min(1)).optional().describe('Only items in these milestones (titles)'),
    query: z.string().trim().max(200).optional().describe('Keyword search in title and body'),
    created_by: z.string().trim().max(100).optional().describe('Only items opened by this user'),
    assignee: z.string().trim().max(100).optional().describe('Only items assigned to this user'),
    mentioned: z.string().trim().max(100).optional().describe('Only items mentioning this user'),
    since: z.string().trim().max(40).optional().describe('Only items updated after this time (ISO 8601)'),
    sort: z
      .enum(['latest', 'oldest', 'recentupdate', 'leastupdate', 'mostcomment', 'leastcomment', 'nearduedate', 'farduedate'])
      .optional()
      .describe('Sort order (default: newest first)'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const result = await ctx.getClient().list<Json>(
      repoPath(args.owner, args.repo, 'issues'),
      {
        state: args.state,
        type: args.type === 'all' ? undefined : args.type,
        labels: args.labels?.join(','),
        milestones: args.milestones?.join(','),
        q: args.query,
        created_by: args.created_by,
        assigned_by: args.assignee,
        mentioned_by: args.mentioned,
        since: args.since,
        sort: args.sort,
      },
      { page: args.page, limit: args.limit },
    );
    const noun = args.type === 'pulls' ? 'pull requests' : args.type === 'all' ? 'issues and pull requests' : 'issues';
    return formatResult(
      args.response_format,
      () =>
        result.items.length
          ? [`## ${args.state === 'all' ? '' : `${args.state[0].toUpperCase()}${args.state.slice(1)} `}${noun} in ${args.owner}/${args.repo}`, '', renderIssueTable(result.items), '', pageFooter(result, noun)].join('\n')
          : `No ${args.state === 'all' ? '' : `${args.state} `}${noun} found in ${args.owner}/${args.repo} with these filters.`,
      () => ({ items: result.items.map(i => projectIssue(i)), ...pageMeta(result) }),
    );
  },
});

export const searchIssues = defineTool({
  name: 'forgejo_search_issues',
  title: 'Search issues and PRs across repositories',
  toolset: 'issues',
  description:
    'Search issues and pull requests across ALL repositories you can access — e.g. assigned to you, created by you, mentioning you, ' +
    'or awaiting your review — with keyword, label, milestone, owner and time filters. Use forgejo_list_issues for one repository.',
  inputSchema: {
    query: z.string().trim().max(200).optional().describe('Keyword to search for'),
    state: stateSchema('open'),
    type: z.enum(['issues', 'pulls']).optional().describe('Only issues or only pull requests (default: both)'),
    assigned: z.boolean().optional().describe('Only items assigned to you'),
    created: z.boolean().optional().describe('Only items you opened'),
    mentioned: z.boolean().optional().describe('Only items mentioning you'),
    review_requested: z.boolean().optional().describe('Only pull requests where your review is requested'),
    reviewed: z.boolean().optional().describe('Only pull requests you reviewed'),
    owner: z.string().trim().max(100).optional().describe('Only repositories of this user/organization'),
    team: z.string().trim().max(100).optional().describe('Only items for this team (needs owner = the organization)'),
    labels: z.array(z.string().trim().min(1)).optional().describe('Only items with any of these label names'),
    milestones: z.array(z.string().trim().min(1)).optional().describe('Only items in these milestones (titles)'),
    since: z.string().trim().max(40).optional().describe('Only items updated after this time (ISO 8601)'),
    before: z.string().trim().max(40).optional().describe('Only items updated before this time (ISO 8601)'),
    sort: z
      .enum(['relevance', 'latest', 'oldest', 'recentupdate', 'leastupdate', 'mostcomment', 'leastcomment', 'nearduedate', 'farduedate'])
      .optional()
      .describe('Sort order'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler(args, ctx) {
    if (args.team && !args.owner) throw new ToolInputError('team needs owner (the organization) as well.');
    const result = await ctx.getClient().list<Json>(
      '/repos/issues/search',
      {
        q: args.query,
        state: args.state,
        type: args.type,
        assigned: args.assigned,
        created: args.created,
        mentioned: args.mentioned,
        review_requested: args.review_requested,
        reviewed: args.reviewed,
        owner: args.owner,
        team: args.team,
        labels: args.labels?.join(','),
        milestones: args.milestones?.join(','),
        since: args.since,
        before: args.before,
        sort: args.sort,
      },
      { page: args.page, limit: args.limit },
    );
    return formatResult(
      args.response_format,
      () =>
        result.items.length
          ? ['## Search results', '', renderIssueTable(result.items, true), '', pageFooter(result, 'results')].join('\n')
          : 'No issues or pull requests match these filters.',
      () => ({ items: result.items.map(i => projectIssue(i)), ...pageMeta(result) }),
    );
  },
});

// =============================================================================
// Single issues
// =============================================================================

export const getIssue = defineTool({
  name: 'forgejo_get_issue',
  title: 'Get an issue',
  toolset: 'issues',
  description:
    'Get one issue (or pull request) by number: title, state, labels, assignees, milestone, description and the latest comments. ' +
    'For pull-request details (branches, mergeability, checks) use forgejo_get_pull_request.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema(),
    comments: z.number().int().min(0).max(100).default(10).describe('How many of the latest comments to include (default 10, 0 = none)'),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, repo, index, comments, response_format }, ctx) {
    const client = ctx.getClient();
    const issue = await client.get<Json>(repoPath(owner, repo, 'issues', index));
    const all = comments > 0 && issue.comments > 0 ? await client.get<Json[]>(repoPath(owner, repo, 'issues', index, 'comments')) : [];
    const latest = (all ?? []).slice(-comments);
    return formatResult(
      response_format,
      () => renderIssue(issue, latest, all?.length),
      () => ({ ...projectIssue(issue, true), comments_list: latest.map(projectComment) }),
    );
  },
});

export const createIssue = defineTool({
  name: 'forgejo_create_issue',
  title: 'Create an issue',
  toolset: 'issues',
  description:
    'Open a new issue with an optional description (markdown), labels (names or IDs), milestone (title or ID), assignees and due date.',
  inputSchema: {
    ...repoRef(),
    title: z.string().trim().min(1).max(255).describe('Issue title'),
    body: z.string().max(65_000).optional().describe('Description (markdown)'),
    labels: labelListSchema().optional(),
    milestone: milestoneInputSchema().optional(),
    assignees: userListSchema('User names to assign').optional(),
    due_date: dueDateSchema().optional(),
    ref: z.string().trim().max(250).optional().describe('Branch or tag the issue relates to'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler(args, ctx) {
    const client = ctx.getClient();
    const [labelIds, milestoneId] = await Promise.all([
      args.labels?.length ? resolveLabelIds(client, args.owner, args.repo, args.labels) : Promise.resolve(undefined),
      args.milestone !== undefined ? resolveMilestoneId(client, args.owner, args.repo, args.milestone) : Promise.resolve(undefined),
    ]);
    const issue = await client.post<Json>(repoPath(args.owner, args.repo, 'issues'), {
      title: args.title,
      body: args.body,
      labels: labelIds,
      milestone: milestoneId,
      assignees: args.assignees,
      due_date: toDateTime(args.due_date),
      ref: args.ref,
    });
    return formatResult(
      args.response_format,
      () => `Created issue **#${issue.number}** in ${args.owner}/${args.repo}: ${issue.html_url}\n\n${renderIssue(issue)}`,
      () => projectIssue(issue, true),
    );
  },
});

export const updateIssue = defineTool({
  name: 'forgejo_update_issue',
  title: 'Update an issue',
  toolset: 'issues',
  description:
    'Edit an issue or pull request: title, description, state (close/reopen), assignees (replaces the list), milestone (title or ID; 0 removes it), ' +
    'due date and ref. Only the fields you pass are changed. Labels are changed with forgejo_update_issue_labels.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema(),
    title: z.string().trim().min(1).max(255).optional(),
    body: z.string().max(65_000).optional().describe('New description (replaces the old one)'),
    state: z.enum(['open', 'closed']).optional().describe('"closed" to close, "open" to reopen'),
    assignees: userListSchema('Replace the assignees with these users ([] removes all)').optional(),
    milestone: milestoneInputSchema().optional().describe('Milestone title or ID; 0 removes the milestone'),
    due_date: dueDateSchema().optional(),
    remove_due_date: z.boolean().optional().describe('Remove the due date'),
    ref: z.string().trim().max(250).optional().describe('Branch or tag the issue relates to'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const client = ctx.getClient();
    const body: Json = compact({
      title: args.title,
      body: args.body,
      state: args.state,
      due_date: toDateTime(args.due_date),
      unset_due_date: args.remove_due_date || undefined,
      ref: args.ref,
    });
    if (args.body === '') body.body = '';
    if (args.assignees) body.assignees = args.assignees;
    if (args.milestone !== undefined) {
      body.milestone = args.milestone === 0 || args.milestone === '0' ? 0 : await resolveMilestoneId(client, args.owner, args.repo, args.milestone);
    }
    if (!Object.keys(body).length) throw new ToolInputError('Pass at least one field to change.');
    const issue = await client.patch<Json>(repoPath(args.owner, args.repo, 'issues', args.index), body);
    return formatResult(
      args.response_format,
      () => `Updated #${issue.number} in ${args.owner}/${args.repo}.\n\n${renderIssue(issue)}`,
      () => projectIssue(issue, true),
    );
  },
});

export const updateIssueLabels = defineTool({
  name: 'forgejo_update_issue_labels',
  title: 'Add, remove or replace issue labels',
  toolset: 'issues',
  description:
    'Change the labels on an issue or pull request using label names (case-insensitive) or IDs: `add` and/or `remove` some labels, ' +
    'or `replace` the whole set, or `clear` all. Repository and organization labels both work. Unknown names return the list of available labels.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema(),
    add: labelListSchema('Labels to add').optional(),
    remove: labelListSchema('Labels to remove').optional(),
    replace: labelListSchema('Replace all labels with exactly these').optional(),
    clear: z.boolean().optional().describe('Remove all labels'),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ owner, repo, index, add, remove, replace, clear }, ctx) {
    const client = ctx.getClient();
    const exclusive = [replace !== undefined, Boolean(clear), Boolean(add?.length || remove?.length)].filter(Boolean).length;
    if (exclusive === 0) throw new ToolInputError('Pass add and/or remove, or replace, or clear: true.');
    if (exclusive > 1) throw new ToolInputError('Use either add/remove, or replace, or clear — not a combination.');
    const base = repoPath(owner, repo, 'issues', index, 'labels');

    let labels: Json[] | null;
    if (clear) {
      await client.delete(base);
      labels = [];
    } else if (replace !== undefined) {
      labels = await client.put<Json[]>(base, { labels: await resolveLabelIds(client, owner, repo, replace) });
    } else {
      labels = null;
      if (add?.length) labels = await client.post<Json[]>(base, { labels: await resolveLabelIds(client, owner, repo, add) });
      if (remove?.length) {
        for (const id of await resolveLabelIds(client, owner, repo, remove)) await client.delete(`${base}/${id}`);
        labels = await client.get<Json[]>(base);
      }
    }
    const names = labelNames(labels ?? []);
    return textResult(`Labels on ${owner}/${repo}#${index} are now: ${names.length ? names.join(', ') : '(none)'}.`);
  },
});

// =============================================================================
// Comments
// =============================================================================

export const listIssueComments = defineTool({
  name: 'forgejo_list_issue_comments',
  title: 'List comments on an issue or PR',
  toolset: 'issues',
  description:
    'List the comments on an issue or pull request, oldest first (use page to move through long discussions). ' +
    'Inline code-review comments are listed with forgejo_get_pull_review.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema(),
    since: z.string().trim().max(40).optional().describe('Only comments updated after this time (ISO 8601)'),
    ...pagination(30),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, repo, index, since, page, limit, response_format }, ctx) {
    const all = (await ctx.getClient().get<Json[]>(repoPath(owner, repo, 'issues', index, 'comments'), { since })) ?? [];
    const items = all.slice((page - 1) * limit, page * limit);
    const pageInfo = { items, page, limit, total: all.length, hasMore: page * limit < all.length };
    return formatResult(
      response_format,
      () =>
        items.length
          ? [`## Comments on ${owner}/${repo}#${index}`, '', items.map(renderComment).join('\n\n'), '', pageFooter(pageInfo, 'comments')].join('\n')
          : `No comments on ${owner}/${repo}#${index}${page > 1 ? ` on page ${page}` : ''}.`,
      () => ({ comments: items.map(projectComment), ...pageMeta(pageInfo) }),
    );
  },
});

export const addIssueComment = defineTool({
  name: 'forgejo_add_issue_comment',
  title: 'Comment on an issue or PR',
  toolset: 'issues',
  description: 'Add a comment (markdown) to an issue or pull request. For a code review with inline comments, use forgejo_create_pull_review.',
  inputSchema: { ...repoRef(), index: indexSchema(), body: z.string().trim().min(1).max(65_000).describe('Comment text (markdown)') },
  annotations: WRITE,
  async handler({ owner, repo, index, body }, ctx) {
    const comment = await ctx.getClient().post<Json>(repoPath(owner, repo, 'issues', index, 'comments'), { body });
    return textResult(`Comment ${comment.id} added to ${owner}/${repo}#${index}: ${comment.html_url}`);
  },
});

export const editIssueComment = defineTool({
  name: 'forgejo_edit_issue_comment',
  title: 'Edit a comment',
  toolset: 'issues',
  description: 'Replace the text of an existing issue or pull-request comment (by comment ID, as shown by forgejo_list_issue_comments).',
  inputSchema: {
    ...repoRef(),
    comment_id: z.number().int().positive().describe('Comment ID'),
    body: z.string().trim().min(1).max(65_000).describe('New comment text (markdown)'),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ owner, repo, comment_id, body }, ctx) {
    const comment = await ctx.getClient().patch<Json>(repoPath(owner, repo, 'issues', 'comments', comment_id), { body });
    return textResult(`Comment ${comment_id} updated: ${comment?.html_url ?? ''}`.trim());
  },
});

export const deleteIssueComment = defineTool({
  name: 'forgejo_delete_issue_comment',
  title: 'Delete a comment',
  toolset: 'issues',
  description: 'Permanently delete an issue or pull-request comment by its ID.',
  inputSchema: { ...repoRef(), comment_id: z.number().int().positive().describe('Comment ID') },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, comment_id }, ctx) {
    await ctx.getClient().delete(repoPath(owner, repo, 'issues', 'comments', comment_id));
    return textResult(`Deleted comment ${comment_id} in ${owner}/${repo}.`);
  },
});

// =============================================================================
// Labels and milestones (read-only here; management is in the labels toolset)
// =============================================================================

export const listLabels = defineTool({
  name: 'forgejo_list_labels',
  title: 'List labels',
  toolset: 'issues',
  description:
    'List the labels available in a repository, including its organization\'s labels, with IDs, colors and descriptions. ' +
    'Label names can be used directly in other tools.',
  inputSchema: { ...repoRef(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, response_format }, ctx) {
    const labels = await repoAndOrgLabels(ctx.getClient(), owner, repo);
    return formatResult(
      response_format,
      () =>
        labels.length
          ? [
              `## Labels in ${owner}/${repo}`,
              '',
              table(['ID', 'Name', 'Color', 'Description', 'Scope'], labels.map(l => {
                const p = projectLabel(l);
                return [p.id, p.name, p.color, p.description, p.scope === 'org' ? 'organization' : 'repository'];
              })),
            ].join('\n')
          : `${owner}/${repo} has no labels.`,
      () => ({ labels: labels.map(projectLabel) }),
    );
  },
});

export const listMilestones = defineTool({
  name: 'forgejo_list_milestones',
  title: 'List milestones',
  toolset: 'issues',
  description: 'List the milestones of a repository with their progress (open/closed issues) and due dates. Milestone titles can be used in other tools.',
  inputSchema: {
    ...repoRef(),
    state: stateSchema('open'),
    name: z.string().trim().max(250).optional().describe('Filter by title'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, repo, state, name, page, limit, response_format }, ctx) {
    const result = await ctx.getClient().list<Json>(repoPath(owner, repo, 'milestones'), { state, name }, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              `## Milestones in ${owner}/${repo}`,
              '',
              table(
                ['ID', 'Title', 'State', 'Progress', 'Due'],
                result.items.map(m => {
                  const total = (m.open_issues ?? 0) + (m.closed_issues ?? 0);
                  return [m.id, m.title, m.state, total ? `${m.closed_issues}/${total} closed (${Math.round(((m.closed_issues ?? 0) / total) * 100)}%)` : 'no issues', fmtDate(m.due_on)];
                }),
              ),
              '',
              pageFooter(result, 'milestones'),
            ].join('\n')
          : `No ${state === 'all' ? '' : `${state} `}milestones in ${owner}/${repo}.`,
      () => ({ milestones: result.items.map(projectMilestone), ...pageMeta(result) }),
    );
  },
});

export const issueTools = [
  listIssues,
  searchIssues,
  getIssue,
  createIssue,
  updateIssue,
  updateIssueLabels,
  listIssueComments,
  addIssueComment,
  editIssueComment,
  deleteIssueComment,
  listLabels,
  listMilestones,
];
