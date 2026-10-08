/**
 * pulls toolset: pull requests, diffs, merging and code reviews.
 *
 * Pull requests are also issues: comments and labels on a PR are handled by
 * forgejo_add_issue_comment / forgejo_update_issue_labels (issues toolset).
 */

import { z } from 'zod';
import type { ForgejoClient } from '../forgejo/client.js';
import { meetsVersion } from '../forgejo/capabilities.js';
import {
  compact,
  labelNames,
  login,
  projectChangedFile,
  projectCommit,
  projectPull,
  projectReview,
  projectReviewComment,
  projectStatus,
  type Json,
} from '../forgejo/projections.js';
import { repoPath } from '../forgejo/url.js';
import { omittedNote, trimDiff } from '../utils/diff.js';
import { bullets, codeBlock, firstLine, fmtDate, shortSha, table, untrusted } from '../utils/format.js';
import { resolveLabelIds, resolveMilestoneId } from './lookups.js';
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

const DRAFT_PREFIX = /^\s*(WIP:|\[WIP\])\s*/i;

function prState(p: Json): string {
  if (p.merged) return 'merged';
  if (p.draft || DRAFT_PREFIX.test(p.title ?? '')) return `${p.state} (draft)`;
  return p.state;
}

function renderPullTable(pulls: Json[]): string {
  return table(
    ['#', 'Title', 'State', 'Head → Base', 'Author', 'Labels', 'Updated'],
    pulls.map(p => [`#${p.number}`, String(p.title ?? '').slice(0, 80), prState(p), `${p.head?.label ?? p.head?.ref} → ${p.base?.ref}`, login(p.user), labelNames(p.labels).join(', '), fmtDate(p.updated_at)]),
  );
}

function renderReviewTable(reviews: Json[]): string {
  return table(
    ['ID', 'Reviewer', 'State', 'Comments', 'Submitted', 'Notes'],
    reviews.map(r => [r.id, login(r.user) || r.team?.name || '', r.state, r.comments_count ?? 0, fmtDate(r.submitted_at), [r.dismissed && 'dismissed', r.stale && 'stale', r.official && 'official'].filter(Boolean).join(', ')]),
  );
}

function renderPull(p: Json, status?: Json, reviews?: Json[]): string {
  const pp = projectPull(p);
  const mergeable = p.merged ? undefined : p.mergeable === true ? 'yes' : p.mergeable === false ? 'no (conflicts or blocked)' : 'unknown';
  const lines = [
    `## Pull request #${pp.number}: ${pp.title}`,
    '',
    bullets([
      ['State', prState(p)],
      ['Author', pp.author ? `@${pp.author}` : undefined],
      ['Branches', `${p.head?.label ?? p.head?.ref} (${shortSha(p.head?.sha)}) → ${p.base?.label ?? p.base?.ref}`],
      ['Mergeable', mergeable],
      ['Merged', p.merged ? `${fmtDate(p.merged_at)} by @${login(p.merged_by)} (${shortSha(p.merge_commit_sha)})` : undefined],
      ['Changes', pp.changed_files !== undefined ? `${pp.changed_files} files, +${pp.additions ?? 0} / -${pp.deletions ?? 0}` : undefined],
      ['Labels', pp.labels],
      ['Assignees', pp.assignees?.map(a => `@${a}`)],
      ['Review requested from', [...(pp.requested_reviewers ?? []).map(r => `@${r}`), ...(pp.requested_teams ?? []).map((t: string) => `team ${t}`)]],
      ['Milestone', pp.milestone],
      ['Comments', pp.comments],
      ['Maintainers can edit', pp.allow_maintainer_edit ? 'yes' : undefined],
      ['Created', fmtDate(pp.created_at)],
      ['Updated', fmtDate(pp.updated_at)],
      ['Closed', p.merged ? undefined : fmtDate(pp.closed_at)],
      ['Web', pp.html_url],
    ]),
  ];
  if (status) {
    const statuses = (status.statuses ?? []) as Json[];
    lines.push(
      '',
      `### Checks: ${status.state || 'none reported'}`,
      ...(statuses.length ? ['', table(['Context', 'State', 'Description'], statuses.map(s => [s.context, s.status, (s.description ?? '').slice(0, 100)]))] : []),
    );
  }
  if (reviews?.length) lines.push('', '### Reviews', '', renderReviewTable(reviews));
  lines.push('', untrusted(p.body, `Description by @${pp.author}`));
  lines.push('', '_Next: forgejo_get_pull_request_diff (changes), forgejo_list_issue_comments (discussion), forgejo_merge_pull_request._');
  return lines.join('\n');
}

async function headStatus(client: ForgejoClient, owner: string, repo: string, sha?: string): Promise<Json | undefined> {
  if (!sha) return undefined;
  return client.get<Json>(repoPath(owner, repo, 'commits', sha, 'status'), { limit: 50 }).catch(() => undefined);
}

const reviewEventSchema = () =>
  z
    .enum(['APPROVED', 'REQUEST_CHANGES', 'COMMENT', 'PENDING'])
    .describe('APPROVED, REQUEST_CHANGES, COMMENT, or PENDING (a draft review you submit later)');

const reviewIdSchema = () => z.number().int().positive().describe('Review ID (from forgejo_list_pull_reviews)');

// =============================================================================
// Listing and reading
// =============================================================================

export const listPullRequests = defineTool({
  name: 'forgejo_list_pull_requests',
  title: 'List pull requests',
  toolset: 'pulls',
  description:
    'List pull requests in a repository, filtered by state, labels (names or IDs), milestone, author and base/head branch. ' +
    'For PRs awaiting your review across all repositories, use forgejo_search_issues with review_requested=true.',
  inputSchema: {
    ...repoRef(),
    state: stateSchema('open'),
    sort: z.enum(['oldest', 'recentupdate', 'recentclose', 'leastupdate', 'mostcomment', 'leastcomment', 'priority']).optional().describe('Sort order (default: newest first)'),
    labels: labelListSchema('Only PRs with these labels').optional(),
    milestone: z.union([z.string().trim().min(1), z.number().int().positive()]).optional().describe('Milestone title or ID'),
    author: z.string().trim().max(100).optional().describe('Only PRs opened by this user'),
    base: z.string().trim().max(250).optional().describe('Only PRs into this base branch'),
    head: z.string().trim().max(250).optional().describe('Only PRs from this head branch'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler(args, ctx) {
    const client = ctx.getClient();
    const [labelIds, milestoneId, caps] = await Promise.all([
      args.labels?.length ? resolveLabelIds(client, args.owner, args.repo, args.labels) : Promise.resolve(undefined),
      args.milestone !== undefined ? resolveMilestoneId(client, args.owner, args.repo, args.milestone) : Promise.resolve(undefined),
      client.capabilities(),
    ]);
    // base/head filters exist server-side from Forgejo 16; older versions filter this page client-side.
    const serverFilters = meetsVersion(caps, '16.0');
    const result = await client.list<Json>(
      repoPath(args.owner, args.repo, 'pulls'),
      {
        state: args.state,
        sort: args.sort,
        labels: labelIds,
        milestone: milestoneId,
        poster: args.author,
        base: serverFilters ? args.base : undefined,
        head: serverFilters ? args.head : undefined,
      },
      { page: args.page, limit: args.limit },
    );
    let items = result.items;
    let note = '';
    if (!serverFilters && (args.base || args.head)) {
      items = items.filter(p => (!args.base || p.base?.ref === args.base) && (!args.head || p.head?.ref === args.head || p.head?.label === args.head));
      note = `\n_This Forgejo version can't filter by branch on the server, so only this page (${result.items.length} PRs) was filtered. Check further pages if needed._`;
    }
    const view = { ...result, items };
    return formatResult(
      args.response_format,
      () =>
        items.length
          ? [`## ${args.state === 'all' ? '' : `${args.state[0].toUpperCase()}${args.state.slice(1)} `}pull requests in ${args.owner}/${args.repo}`, '', renderPullTable(items), '', pageFooter(view, 'pull requests'), note].join('\n')
          : `No ${args.state === 'all' ? '' : `${args.state} `}pull requests found in ${args.owner}/${args.repo} with these filters.${note}`,
      () => ({ pull_requests: items.map(p => projectPull(p)), ...pageMeta(result) }),
    );
  },
});

export const getPullRequest = defineTool({
  name: 'forgejo_get_pull_request',
  title: 'Get a pull request',
  toolset: 'pulls',
  description:
    'Get one pull request: branches, mergeability, change counts, labels, reviewers, CI check status of the head commit, ' +
    'review summary and description. Use forgejo_get_pull_request_diff for the code changes.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema('pull request'),
    include_checks: z.boolean().default(true).describe('Include the CI status of the head commit (default true)'),
    include_reviews: z.boolean().default(true).describe('Include the list of reviews (default true)'),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, repo, index, include_checks, include_reviews, response_format }, ctx) {
    const client = ctx.getClient();
    const pr = await client.get<Json>(repoPath(owner, repo, 'pulls', index));
    const headRepo = pr.head?.repo;
    const [status, reviews] = await Promise.all([
      include_checks ? headStatus(client, headRepo?.owner?.login ?? owner, headRepo?.name ?? repo, pr.head?.sha) : Promise.resolve(undefined),
      include_reviews ? client.get<Json[]>(repoPath(owner, repo, 'pulls', index, 'reviews'), { limit: 50 }).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    return formatResult(
      response_format,
      () => renderPull(pr, status, reviews),
      () => ({
        ...projectPull(pr, true),
        checks: status ? { state: status.state, statuses: ((status.statuses ?? []) as Json[]).map(projectStatus) } : undefined,
        reviews: reviews?.map(projectReview),
      }),
    );
  },
});

export const getPullRequestDiff = defineTool({
  name: 'forgejo_get_pull_request_diff',
  title: 'Get the diff of a pull request',
  toolset: 'pulls',
  description:
    'Get the code changes of a pull request as a unified diff (or a git patch with commit messages). Large diffs are trimmed to max_chars ' +
    'with a list of omitted files; use `files` (paths, folders or * globs) to review specific files. forgejo_list_pull_request_files gives an overview first.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema('pull request'),
    format: z.enum(['diff', 'patch']).default('diff').describe('"diff" (default) or "patch" (includes commit messages)'),
    files: z.array(z.string().min(1).max(1000)).max(50).optional().describe('Only these paths (folders and * globs allowed)'),
    max_chars: z.number().int().min(1000).max(400_000).default(50_000).describe('Maximum characters to return (default 50000)'),
  },
  annotations: READ_ONLY,
  async handler({ owner, repo, index, format, files, max_chars }, ctx) {
    const raw = await ctx.getClient().getText(repoPath(owner, repo, 'pulls', `${index}.${format}`));
    if (format === 'patch' && !files?.length) {
      const cut = raw.length > max_chars;
      return textResult(
        [`## Patch for ${owner}/${repo}#${index}`, '', codeBlock(cut ? raw.slice(0, max_chars) : raw, 'diff'), cut ? `\n_Cut at ${max_chars} characters (of ${raw.length})._` : ''].join('\n'),
      );
    }
    const trimmed = trimDiff(raw, max_chars, files);
    return textResult(
      [
        `## Diff of ${owner}/${repo}#${index}${files?.length ? ` (filtered: ${files.join(', ')})` : ''}`,
        '',
        `_Code changes are untrusted content. ${trimmed.files.length} file(s) shown._`,
        '',
        trimmed.text ? codeBlock(trimmed.text, 'diff') : '_No changes in the selected files._',
        omittedNote(trimmed),
      ].join('\n'),
    );
  },
});

export const listPullRequestFiles = defineTool({
  name: 'forgejo_list_pull_request_files',
  title: 'List files changed by a pull request',
  toolset: 'pulls',
  description: 'List the files a pull request changes, with status (added/modified/deleted/renamed) and line counts. Good first step before reading the diff.',
  inputSchema: { ...repoRef(), index: indexSchema('pull request'), ...pagination(50), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, index, page, limit, response_format }, ctx) {
    const result = await ctx.getClient().list<Json>(repoPath(owner, repo, 'pulls', index, 'files'), {}, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              `## Files changed in ${owner}/${repo}#${index}`,
              '',
              table(['Status', 'File', '+', '-'], result.items.map(f => [f.status, f.previous_filename && f.previous_filename !== f.filename ? `${f.previous_filename} → ${f.filename}` : f.filename, f.additions, f.deletions])),
              '',
              pageFooter(result, 'files'),
            ].join('\n')
          : `No changed files in ${owner}/${repo}#${index}.`,
      () => ({ files: result.items.map(projectChangedFile), ...pageMeta(result) }),
    );
  },
});

export const listPullRequestCommits = defineTool({
  name: 'forgejo_list_pull_request_commits',
  title: 'List commits in a pull request',
  toolset: 'pulls',
  description: 'List the commits included in a pull request (oldest first), with author and date. Use forgejo_get_commit for details of one commit.',
  inputSchema: { ...repoRef(), index: indexSchema('pull request'), ...pagination(50), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, index, page, limit, response_format }, ctx) {
    const result = await ctx.getClient().list<Json>(repoPath(owner, repo, 'pulls', index, 'commits'), { verification: false, files: false }, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              `## Commits in ${owner}/${repo}#${index}`,
              '',
              table(['SHA', 'Message', 'Author', 'Date'], result.items.map(c => [shortSha(c.sha), firstLine(c.commit?.message).slice(0, 80), c.commit?.author?.name ?? '', fmtDate(c.commit?.author?.date)])),
              '',
              pageFooter(result, 'commits'),
            ].join('\n')
          : 'No commits.',
      () => ({ commits: result.items.map(c => ({ ...projectCommit(c), message: firstLine(c.commit?.message) })), ...pageMeta(result) }),
    );
  },
});

// =============================================================================
// Creating, editing, merging
// =============================================================================

export const createPullRequest = defineTool({
  name: 'forgejo_create_pull_request',
  title: 'Open a pull request',
  toolset: 'pulls',
  description:
    'Open a pull request from `head` into `base` (default: the repository default branch). For a branch in a fork, use head="forkowner:branch". ' +
    'Optionally mark it as a draft (adds the "WIP:" title prefix), add labels, milestone, assignees and request reviewers.',
  inputSchema: {
    ...repoRef(),
    title: z.string().trim().min(1).max(255).describe('Pull request title'),
    head: z.string().trim().min(1).max(250).describe('Branch with the changes ("branch" or "forkowner:branch")'),
    base: z.string().trim().min(1).max(250).optional().describe('Branch to merge into (default: the default branch)'),
    body: z.string().max(65_000).optional().describe('Description (markdown)'),
    draft: z.boolean().default(false).describe('Open as a draft (work in progress)'),
    labels: labelListSchema().optional(),
    milestone: z.union([z.string().trim().min(1), z.number().int().positive()]).optional().describe('Milestone title or ID'),
    assignees: userListSchema('User names to assign').optional(),
    reviewers: userListSchema('User names to request a review from').optional(),
    team_reviewers: userListSchema('Team names to request a review from').optional(),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler(args, ctx) {
    const client = ctx.getClient();
    const [base, labelIds, milestoneId] = await Promise.all([
      args.base ? Promise.resolve(args.base) : client.get<Json>(repoPath(args.owner, args.repo)).then(r => String(r.default_branch)),
      args.labels?.length ? resolveLabelIds(client, args.owner, args.repo, args.labels) : Promise.resolve(undefined),
      args.milestone !== undefined ? resolveMilestoneId(client, args.owner, args.repo, args.milestone) : Promise.resolve(undefined),
    ]);
    const title = args.draft && !DRAFT_PREFIX.test(args.title) ? `WIP: ${args.title}` : args.title;
    const pr = await client.post<Json>(repoPath(args.owner, args.repo, 'pulls'), {
      title,
      head: args.head,
      base,
      body: args.body,
      labels: labelIds,
      milestone: milestoneId,
      assignees: args.assignees,
    });
    let reviewNote = '';
    if (args.reviewers?.length || args.team_reviewers?.length) {
      try {
        await client.post(repoPath(args.owner, args.repo, 'pulls', pr.number, 'requested_reviewers'), { reviewers: args.reviewers, team_reviewers: args.team_reviewers });
        reviewNote = `\nReview requested from ${[...(args.reviewers ?? []).map(r => `@${r}`), ...(args.team_reviewers ?? [])].join(', ')}.`;
      } catch (error) {
        reviewNote = `\nThe pull request was created, but requesting reviewers failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return formatResult(
      args.response_format,
      () => `Opened pull request **#${pr.number}** (${args.head} → ${base}): ${pr.html_url}${reviewNote}`,
      () => projectPull(pr, true),
    );
  },
});

export const updatePullRequest = defineTool({
  name: 'forgejo_update_pull_request',
  title: 'Update a pull request',
  toolset: 'pulls',
  description:
    'Edit a pull request: title, description, base branch, state (close/reopen), draft status, labels (replaces them), milestone (0 removes), ' +
    'assignees (replaces them), due date and whether maintainers may edit. Only the fields you pass are changed.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema('pull request'),
    title: z.string().trim().min(1).max(255).optional().describe('New title'),
    body: z.string().max(65_000).optional().describe('New description (replaces the old one)'),
    base: z.string().trim().min(1).max(250).optional().describe('Change the target branch'),
    state: z.enum(['open', 'closed']).optional().describe('"closed" to close without merging, "open" to reopen'),
    draft: z.boolean().optional().describe('true: mark as draft (WIP: prefix); false: ready for review'),
    labels: labelListSchema('Replace the labels with these').optional(),
    milestone: z.union([z.string().trim().min(1), z.number().int().nonnegative()]).optional().describe('Milestone title or ID; 0 removes it'),
    assignees: userListSchema('Replace the assignees ([] removes all)').optional(),
    due_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/).optional().describe('Due date YYYY-MM-DD'),
    remove_due_date: z.boolean().optional().describe('Remove the due date'),
    allow_maintainer_edit: z.boolean().optional().describe('Let maintainers push to the head branch'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler(args, ctx) {
    const client = ctx.getClient();
    const body: Json = compact({
      title: args.title,
      body: args.body,
      base: args.base,
      state: args.state,
      due_date: args.due_date && /^\d{4}-\d{2}-\d{2}$/.test(args.due_date) ? `${args.due_date}T00:00:00Z` : args.due_date,
      unset_due_date: args.remove_due_date || undefined,
      allow_maintainer_edit: args.allow_maintainer_edit,
    });
    if (args.body === '') body.body = '';
    if (args.assignees) body.assignees = args.assignees;
    if (args.labels) body.labels = await resolveLabelIds(client, args.owner, args.repo, args.labels);
    if (args.milestone !== undefined) {
      body.milestone = args.milestone === 0 || args.milestone === '0' ? 0 : await resolveMilestoneId(client, args.owner, args.repo, args.milestone);
    }
    if (args.draft !== undefined) {
      const current = args.title ?? String((await client.get<Json>(repoPath(args.owner, args.repo, 'pulls', args.index))).title);
      const clean = current.replace(DRAFT_PREFIX, '');
      body.title = args.draft ? `WIP: ${clean}` : clean;
    }
    if (!Object.keys(body).length) throw new ToolInputError('Pass at least one field to change.');
    const pr = await client.patch<Json>(repoPath(args.owner, args.repo, 'pulls', args.index), body);
    return formatResult(args.response_format, () => `Updated pull request #${pr.number}.\n\n${renderPull(pr)}`, () => projectPull(pr, true));
  },
});

export const mergePullRequest = defineTool({
  name: 'forgejo_merge_pull_request',
  title: 'Merge a pull request',
  toolset: 'pulls',
  description:
    'Merge a pull request with the chosen method (merge commit, rebase, rebase-merge, squash or fast-forward-only), optionally deleting the head branch. ' +
    'With auto_merge=true it merges automatically once all checks pass. With cancel_auto_merge=true it cancels a scheduled auto-merge instead. ' +
    'Pass head_commit_id to make sure the PR has not changed since you reviewed it.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema('pull request'),
    method: z
      .enum(['merge', 'rebase', 'rebase-merge', 'squash', 'fast-forward-only', 'manually-merged'])
      .default('merge')
      .describe('Merge method (default "merge"); must be allowed in the repository settings'),
    title: z.string().max(255).optional().describe('Merge commit title (merge/squash)'),
    message: z.string().max(65_000).optional().describe('Merge commit message (merge/squash)'),
    delete_branch: z.boolean().default(false).describe('Delete the head branch after merging'),
    auto_merge: z.boolean().default(false).describe('Schedule the merge for when all checks succeed'),
    head_commit_id: z.string().trim().min(7).max(64).optional().describe('Only merge if the head commit is still this SHA'),
    force_merge: z.boolean().default(false).describe('Merge even if checks/approvals are missing (needs admin rights)'),
    cancel_auto_merge: z.boolean().default(false).describe('Cancel a scheduled auto-merge instead of merging'),
  },
  annotations: DESTRUCTIVE,
  async handler(args, ctx) {
    const client = ctx.getClient();
    const path = repoPath(args.owner, args.repo, 'pulls', args.index, 'merge');
    if (args.cancel_auto_merge) {
      await client.delete(path);
      return textResult(`Cancelled the scheduled auto-merge of ${args.owner}/${args.repo}#${args.index}.`);
    }
    await client.post(path, {
      Do: args.method,
      MergeTitleField: args.title,
      MergeMessageField: args.message,
      delete_branch_after_merge: args.delete_branch,
      merge_when_checks_succeed: args.auto_merge || undefined,
      head_commit_id: args.head_commit_id,
      force_merge: args.force_merge || undefined,
    });
    const pr = await client.get<Json>(repoPath(args.owner, args.repo, 'pulls', args.index));
    if (pr.merged) {
      return textResult(`Merged ${args.owner}/${args.repo}#${args.index} (${args.method}) as ${shortSha(pr.merge_commit_sha)}${args.delete_branch ? '; head branch deleted' : ''}. ${pr.html_url}`);
    }
    return textResult(
      args.auto_merge
        ? `Auto-merge scheduled for ${args.owner}/${args.repo}#${args.index}: it will be merged (${args.method}) when all checks pass.`
        : `The merge request was accepted, but #${args.index} is not shown as merged yet. Check it with forgejo_get_pull_request.`,
    );
  },
});

export const updatePullRequestBranch = defineTool({
  name: 'forgejo_update_pull_request_branch',
  title: 'Update a PR branch from its base',
  toolset: 'pulls',
  description: 'Bring a pull request\'s head branch up to date with its base branch, by merging the base into it (default) or rebasing it.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema('pull request'),
    style: z.enum(['merge', 'rebase']).default('merge').describe('"merge" (default) or "rebase"'),
  },
  annotations: WRITE,
  async handler({ owner, repo, index, style }, ctx) {
    await ctx.getClient().post(repoPath(owner, repo, 'pulls', index, 'update'), undefined, { style });
    return textResult(`Updated the head branch of ${owner}/${repo}#${index} from its base (${style}).`);
  },
});

// =============================================================================
// Reviews
// =============================================================================

export const listPullReviews = defineTool({
  name: 'forgejo_list_pull_reviews',
  title: 'List reviews of a pull request',
  toolset: 'pulls',
  description: 'List the reviews on a pull request (approvals, change requests, comments, pending drafts) with their IDs and comment counts.',
  inputSchema: { ...repoRef(), index: indexSchema('pull request'), ...pagination(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, index, page, limit, response_format }, ctx) {
    const result = await ctx.getClient().list<Json>(repoPath(owner, repo, 'pulls', index, 'reviews'), {}, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [`## Reviews of ${owner}/${repo}#${index}`, '', renderReviewTable(result.items), '', pageFooter(result, 'reviews'), '', '_Use forgejo_get_pull_review for a review\'s inline comments._'].join('\n')
          : `No reviews on ${owner}/${repo}#${index} yet.`,
      () => ({ reviews: result.items.map(projectReview), ...pageMeta(result) }),
    );
  },
});

export const getPullReview = defineTool({
  name: 'forgejo_get_pull_review',
  title: 'Get a review and its comments',
  toolset: 'pulls',
  description: 'Get one pull-request review with its summary and all inline code comments (file, line, text).',
  inputSchema: { ...repoRef(), index: indexSchema('pull request'), review_id: reviewIdSchema(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, index, review_id, response_format }, ctx) {
    const client = ctx.getClient();
    const base = repoPath(owner, repo, 'pulls', index, 'reviews', review_id);
    const [review, comments] = await Promise.all([client.get<Json>(base), client.get<Json[]>(`${base}/comments`)]);
    return formatResult(
      response_format,
      () =>
        [
          `## Review ${review.id} on ${owner}/${repo}#${index}`,
          '',
          bullets([
            ['Reviewer', `@${login(review.user) || review.team?.name}`],
            ['State', review.state],
            ['Commit', shortSha(review.commit_id)],
            ['Submitted', fmtDate(review.submitted_at)],
            ['Flags', [review.dismissed && 'dismissed', review.stale && 'stale', review.official && 'official'].filter(Boolean).join(', ')],
          ]),
          '',
          untrusted(review.body, 'Review summary'),
          ...(comments?.length
            ? ['', `### Inline comments (${comments.length})`, '', comments.map(c => untrusted(c.body, `${c.path}:${c.position || c.original_position} — @${login(c.user)}${c.resolver ? ' (resolved)' : ''}`)).join('\n\n')]
            : []),
        ].join('\n'),
      () => ({ ...projectReview(review), comments_list: (comments ?? []).map(projectReviewComment) }),
    );
  },
});

const inlineCommentSchema = () =>
  z.object({
    path: z.string().trim().min(1).max(1000).describe('File path in the PR'),
    body: z.string().trim().min(1).max(65_000).describe('Comment text (markdown)'),
    new_line: z.number().int().nonnegative().optional().describe('Line number in the NEW version of the file (for added/unchanged lines)'),
    old_line: z.number().int().nonnegative().optional().describe('Line number in the OLD version (for removed lines)'),
  });

export const createPullReview = defineTool({
  name: 'forgejo_create_pull_review',
  title: 'Review a pull request',
  toolset: 'pulls',
  description:
    'Submit a review on a pull request: approve, request changes or comment, with an optional summary and inline comments on specific lines ' +
    '(new_line for added/unchanged lines, old_line for removed lines). Use event=PENDING to start a draft review and submit it later ' +
    'with forgejo_submit_pull_review.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema('pull request'),
    event: reviewEventSchema(),
    body: z.string().max(65_000).optional().describe('Review summary (markdown)'),
    comments: z.array(inlineCommentSchema()).max(100).optional().describe('Inline comments'),
    commit_id: z.string().trim().min(7).max(64).optional().describe('Commit SHA being reviewed (default: the latest)'),
  },
  annotations: WRITE,
  async handler({ owner, repo, index, event, body, comments, commit_id }, ctx) {
    if ((event === 'REQUEST_CHANGES' || event === 'COMMENT') && !body?.trim() && !comments?.length) {
      throw new ToolInputError(`A ${event} review needs a body or at least one inline comment.`);
    }
    for (const c of comments ?? []) {
      if (!c.new_line && !c.old_line) throw new ToolInputError(`Inline comment on ${c.path} needs new_line or old_line.`);
    }
    const review = await ctx.getClient().post<Json>(repoPath(owner, repo, 'pulls', index, 'reviews'), {
      event,
      body,
      commit_id,
      comments: comments?.map(c => ({ path: c.path, body: c.body, new_position: c.new_line ?? 0, old_position: c.old_line ?? 0 })),
    });
    return textResult(
      `${event === 'PENDING' ? 'Started a pending review' : `Submitted a ${event} review`} (ID ${review.id}) on ${owner}/${repo}#${index}` +
        `${comments?.length ? ` with ${comments.length} inline comment(s)` : ''}.${review.html_url ? ` ${review.html_url}` : ''}`,
    );
  },
});

export const submitPullReview = defineTool({
  name: 'forgejo_submit_pull_review',
  title: 'Submit a pending review',
  toolset: 'pulls',
  description: 'Submit a pending (draft) pull-request review as APPROVED, REQUEST_CHANGES or COMMENT, with an optional final summary.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema('pull request'),
    review_id: reviewIdSchema(),
    event: z.enum(['APPROVED', 'REQUEST_CHANGES', 'COMMENT']).describe('How to submit the review'),
    body: z.string().max(65_000).optional().describe('Review summary (markdown)'),
  },
  annotations: WRITE,
  async handler({ owner, repo, index, review_id, event, body }, ctx) {
    const review = await ctx.getClient().post<Json>(repoPath(owner, repo, 'pulls', index, 'reviews', review_id), { event, body });
    return textResult(`Submitted review ${review_id} on ${owner}/${repo}#${index} as ${review?.state ?? event}.`);
  },
});

export const dismissPullReview = defineTool({
  name: 'forgejo_dismiss_pull_review',
  title: 'Dismiss a review',
  toolset: 'pulls',
  description: 'Dismiss a pull-request review (it no longer counts as an approval/change request), with a reason. Set undo=true to restore a dismissed review.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema('pull request'),
    review_id: reviewIdSchema(),
    message: z.string().max(5000).optional().describe('Reason for dismissing'),
    undo: z.boolean().default(false).describe('Undismiss instead'),
  },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, index, review_id, message, undo }, ctx) {
    const base = repoPath(owner, repo, 'pulls', index, 'reviews', review_id);
    if (undo) await ctx.getClient().post(`${base}/undismissals`);
    else await ctx.getClient().post(`${base}/dismissals`, { message, priors: false });
    return textResult(`${undo ? 'Restored' : 'Dismissed'} review ${review_id} on ${owner}/${repo}#${index}.`);
  },
});

export const deletePullReview = defineTool({
  name: 'forgejo_delete_pull_review',
  title: 'Delete a review',
  toolset: 'pulls',
  description: 'Delete a pull-request review (typically your own pending draft review) and its comments.',
  inputSchema: { ...repoRef(), index: indexSchema('pull request'), review_id: reviewIdSchema() },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, index, review_id }, ctx) {
    await ctx.getClient().delete(repoPath(owner, repo, 'pulls', index, 'reviews', review_id));
    return textResult(`Deleted review ${review_id} on ${owner}/${repo}#${index}.`);
  },
});

export const requestPullReviewers = defineTool({
  name: 'forgejo_request_pull_reviewers',
  title: 'Request or remove reviewers',
  toolset: 'pulls',
  description: 'Request reviews on a pull request from users or teams, or withdraw review requests.',
  inputSchema: {
    ...repoRef(),
    index: indexSchema('pull request'),
    add: userListSchema('User names to request a review from').optional(),
    add_teams: userListSchema('Team names to request a review from').optional(),
    remove: userListSchema('User names to withdraw the request from').optional(),
    remove_teams: userListSchema('Team names to withdraw the request from').optional(),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ owner, repo, index, add, add_teams, remove, remove_teams }, ctx) {
    if (!add?.length && !add_teams?.length && !remove?.length && !remove_teams?.length) {
      throw new ToolInputError('Pass users or teams to add or remove.');
    }
    const client = ctx.getClient();
    const path = repoPath(owner, repo, 'pulls', index, 'requested_reviewers');
    const done: string[] = [];
    if (add?.length || add_teams?.length) {
      await client.post(path, { reviewers: add, team_reviewers: add_teams });
      done.push(`requested ${[...(add ?? []).map(u => `@${u}`), ...(add_teams ?? [])].join(', ')}`);
    }
    if (remove?.length || remove_teams?.length) {
      await client.delete(path, { reviewers: remove, team_reviewers: remove_teams });
      done.push(`removed ${[...(remove ?? []).map(u => `@${u}`), ...(remove_teams ?? [])].join(', ')}`);
    }
    return textResult(`Review requests on ${owner}/${repo}#${index}: ${done.join('; ')}.`);
  },
});

export const pullTools = [
  listPullRequests,
  getPullRequest,
  createPullRequest,
  updatePullRequest,
  getPullRequestDiff,
  listPullRequestFiles,
  listPullRequestCommits,
  mergePullRequest,
  updatePullRequestBranch,
  listPullReviews,
  getPullReview,
  createPullReview,
  submitPullReview,
  dismissPullReview,
  deletePullReview,
  requestPullReviewers,
];

