/**
 * notifications toolset: the authenticated user's notification inbox.
 */

import { z } from 'zod';
import { projectNotification, type Json } from '../forgejo/projections.js';
import { repoPath } from '../forgejo/url.js';
import { bullets, fmtDate, table } from '../utils/format.js';
import { READ_ONLY, WRITE_IDEMPOTENT, ToolInputError, defineTool, formatResult, pageFooter, pageMeta, pagination, responseFormatSchema, textResult } from './shared.js';

const optionalOwner = () => z.string().trim().min(1).max(100).optional().describe('Repository owner (to limit to one repository; needs repo)');
const optionalRepo = () => z.string().trim().min(1).max(100).optional().describe('Repository name (to limit to one repository; needs owner)');

function scopePath(owner?: string, repo?: string): string {
  if (Boolean(owner) !== Boolean(repo)) throw new ToolInputError('Pass both owner and repo to limit to one repository, or neither for all notifications.');
  return owner && repo ? repoPath(owner, repo, 'notifications') : '/notifications';
}

export const listNotifications = defineTool({
  name: 'forgejo_list_notifications',
  title: 'List notifications',
  toolset: 'notifications',
  description:
    'List your notifications (unread by default), optionally for one repository, by status (unread/read/pinned), subject type ' +
    '(issue/pull/repository) and time. Shows the unread count. Mark them as read with forgejo_mark_notifications_read.',
  inputSchema: {
    owner: optionalOwner(),
    repo: optionalRepo(),
    status: z
      .array(z.enum(['unread', 'read', 'pinned']))
      .min(1)
      .default(['unread', 'pinned'])
      .describe('Statuses to include (default unread + pinned)'),
    subject_type: z.array(z.enum(['issue', 'pull', 'repository'])).optional().describe('Only these subject types'),
    since: z.string().trim().max(40).optional().describe('Only notifications updated after this time (ISO 8601)'),
    before: z.string().trim().max(40).optional().describe('Only notifications updated before this time (ISO 8601)'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, repo, status, subject_type, since, before, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const path = scopePath(owner, repo);
    const [result, unread] = await Promise.all([
      client.list<Json>(path, { 'status-types': status, 'subject-type': subject_type, since, before }, { page, limit }),
      client.get<Json>('/notifications/new').catch(() => undefined),
    ]);
    const scope = owner && repo ? ` for ${owner}/${repo}` : '';
    return formatResult(
      response_format,
      () =>
        [
          `## Notifications${scope}`,
          '',
          ...(unread?.new !== undefined ? [`You have **${unread.new}** unread notification(s) in total.`, ''] : []),
          result.items.length
            ? table(
                ['ID', 'Repository', 'Type', 'Title', 'State', 'Status', 'Updated'],
                result.items.map(n => [n.id, n.repository?.full_name, n.subject?.type, String(n.subject?.title ?? '').slice(0, 80), n.subject?.state, n.pinned ? 'pinned' : n.unread ? 'unread' : 'read', fmtDate(n.updated_at)]),
              )
            : `No ${status.join('/')} notifications${scope}.`,
          '',
          pageFooter(result, 'notifications'),
        ].join('\n'),
      () => ({ unread_total: unread?.new, notifications: result.items.map(projectNotification), ...pageMeta(result) }),
    );
  },
});

export const getNotificationThread = defineTool({
  name: 'forgejo_get_notification_thread',
  title: 'Get a notification',
  toolset: 'notifications',
  description:
    'Get one notification thread by ID: repository, subject (issue/PR/commit/release) and links. ' +
    'Then open the subject with forgejo_get_issue or forgejo_get_pull_request.',
  inputSchema: { id: z.number().int().positive().describe('Notification thread ID'), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ id, response_format }, ctx) {
    const n = await ctx.getClient().get<Json>(`/notifications/threads/${id}`);
    const p = projectNotification(n);
    return formatResult(
      response_format,
      () =>
        [
          `## Notification ${p.id}: ${p.title}`,
          '',
          bullets([
            ['Repository', p.repository],
            ['Type', p.type],
            ['State', p.state],
            ['Status', p.pinned ? 'pinned' : p.unread ? 'unread' : 'read'],
            ['Updated', fmtDate(p.updated_at)],
            ['Web', p.html_url],
            ['Latest comment', p.latest_comment_url],
          ]),
        ].join('\n'),
      () => p,
    );
  },
});

export const markNotificationsRead = defineTool({
  name: 'forgejo_mark_notifications_read',
  title: 'Mark notifications as read',
  toolset: 'notifications',
  description:
    'Change the status of notifications: one thread (`id`), all notifications of one repository (owner + repo), or all of them. ' +
    'Default marks as read; to_status can also be "unread" or "pinned". `before` limits bulk changes to notifications older than that time.',
  inputSchema: {
    id: z.number().int().positive().optional().describe('A single notification thread ID'),
    owner: optionalOwner(),
    repo: optionalRepo(),
    all: z.boolean().default(false).describe('Confirm changing ALL your notifications (when no id/repo is given)'),
    to_status: z.enum(['read', 'unread', 'pinned']).default('read').describe('New status (default "read")'),
    before: z.string().trim().max(40).optional().describe('Only notifications last updated before this time (ISO 8601; bulk only)'),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ id, owner, repo, all, to_status, before }, ctx) {
    const client = ctx.getClient();
    if (id !== undefined) {
      if (owner || repo || all) throw new ToolInputError('Pass either id, or owner+repo, or all=true.');
      await client.patch(`/notifications/threads/${id}`, undefined, { 'to-status': to_status });
      return textResult(`Notification ${id} marked as ${to_status}.`);
    }
    if (!owner && !repo && !all) {
      throw new ToolInputError('Pass id for one notification, owner+repo for one repository, or all=true to change all notifications.');
    }
    const path = scopePath(owner, repo);
    // Bulk changes: unread → read by default; when re-marking as unread, act on read ones.
    const from = to_status === 'unread' ? ['read'] : ['unread', 'pinned'];
    const res = await client.request<Json[]>('PUT', path, {
      query: { all: true, 'status-types': from, 'to-status': to_status, last_read_at: before },
    });
    const count = Array.isArray(res.data) ? res.data.length : undefined;
    return textResult(
      `${count !== undefined ? `${count} notification(s)` : 'Notifications'}${owner && repo ? ` in ${owner}/${repo}` : ''} marked as ${to_status}${before ? ` (updated before ${before})` : ''}.`,
    );
  },
});

export const notificationTools = [listNotifications, getNotificationThread, markNotificationsRead];
