/**
 * admin toolset: site administration (instance admins only).
 *
 * Every endpoint here needs a site-admin account and a token with the
 * read:admin / write:admin scope. Other users get HTTP 403, which the client
 * turns into an explanatory error.
 */

import { z } from 'zod';
import { compact, projectUser, type Json } from '../forgejo/projections.js';
import { fmtDate, formatNumber, table } from '../utils/format.js';
import { READ_ONLY, WRITE, defineTool, formatResult, pageFooter, pageMeta, pagination, responseFormatSchema, textResult } from './shared.js';

/** projectUser plus the account-state fields only admins see. */
function projectAdminUser(u: Json) {
  return compact({
    ...projectUser(u),
    active: u.active,
    restricted: u.restricted || undefined,
    prohibit_login: u.prohibit_login || undefined,
    login_name: u.login_name && u.login_name !== u.login ? u.login_name : undefined,
    source_id: u.source_id || undefined,
  });
}

function projectCron(c: Json) {
  return compact({ name: c.name, schedule: c.schedule, next: c.next, prev: c.prev, exec_times: c.exec_times });
}

const yesNo = (value: unknown) => (value ? 'yes' : 'no');

export const adminListUsers = defineTool({
  name: 'forgejo_admin_list_users',
  title: 'List all users (admin)',
  toolset: 'admin',
  description:
    'Site admins only: list every user account on the instance with email, admin flag, active/restricted state, last login and ' +
    'creation date. Filter by authentication source (source_id, login_name) and sort. Non-admins get HTTP 403; to find users by ' +
    'name use forgejo_search_users (users toolset) instead.',
  inputSchema: {
    source_id: z.number().int().positive().optional().describe('Only users of this authentication source ID (LDAP, OAuth2, ...)'),
    login_name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe('Only the user with this exact login name at their authentication source (e.g. an LDAP uid)'),
    sort: z
      .enum(['oldest', 'newest', 'alphabetically', 'reversealphabetically', 'recentupdate', 'leastupdate'])
      .optional()
      .describe('Sort order (default: the instance default, alphabetical)'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ source_id, login_name, sort, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const result = await client.list<Json>('/admin/users', { source_id, login_name, sort }, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              '## Users',
              '',
              table(
                ['Login', 'Email', 'Admin', 'Active', 'Restricted', 'Last login', 'Created'],
                result.items.map(u => [
                  u.login,
                  u.email,
                  yesNo(u.is_admin),
                  `${yesNo(u.active)}${u.prohibit_login ? ' (login disabled)' : ''}`,
                  yesNo(u.restricted),
                  fmtDate(u.last_login) || 'never',
                  fmtDate(u.created),
                ]),
              ),
              '',
              pageFooter(result, 'users'),
            ].join('\n')
          : 'No users match these filters.',
      () => ({ users: result.items.map(projectAdminUser), ...pageMeta(result) }),
    );
  },
});

export const adminListCronTasks = defineTool({
  name: 'forgejo_admin_list_cron_tasks',
  title: 'List cron tasks (admin)',
  toolset: 'admin',
  description:
    'Site admins only: list the instance\'s scheduled maintenance tasks (mirror updates, repository health checks, cleanups, ...) ' +
    'with their schedule, next and previous run and how often they have run. Use the task name with forgejo_admin_run_cron_task ' +
    'to run one now. Non-admins get HTTP 403.',
  inputSchema: { ...pagination(50), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const result = await client.list<Json>('/admin/cron', {}, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              '## Cron tasks',
              '',
              table(
                ['Task', 'Schedule', 'Next run', 'Previous run', 'Runs'],
                result.items.map(c => [c.name, c.schedule, fmtDate(c.next), fmtDate(c.prev) || 'never', formatNumber(Number(c.exec_times ?? 0))]),
              ),
              '',
              pageFooter(result, 'tasks'),
            ].join('\n')
          : 'No cron tasks found.',
      () => ({ tasks: result.items.map(projectCron), ...pageMeta(result) }),
    );
  },
});

export const adminRunCronTask = defineTool({
  name: 'forgejo_admin_run_cron_task',
  title: 'Run a cron task now (admin)',
  toolset: 'admin',
  description:
    'Site admins only: start one of the instance\'s scheduled maintenance tasks immediately (e.g. "update_mirrors", ' +
    '"repo_health_check", "delete_old_actions"). It runs in the background; check forgejo_admin_list_cron_tasks afterwards for the ' +
    'updated previous-run time. Get valid task names from forgejo_admin_list_cron_tasks. Non-admins get HTTP 403.',
  inputSchema: {
    task: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9_]+$/, 'Task names are lowercase with underscores, e.g. "update_mirrors"')
      .describe('Task name as listed by forgejo_admin_list_cron_tasks, e.g. "update_mirrors"'),
  },
  annotations: WRITE,
  async handler({ task }, ctx) {
    const client = ctx.getClient();
    await client.post(`/admin/cron/${encodeURIComponent(task)}`);
    return textResult(
      `Started cron task **${task}**. It runs in the background; call forgejo_admin_list_cron_tasks later to see its previous-run time.`,
    );
  },
});

export const adminTools = [adminListUsers, adminListCronTasks, adminRunCronTask];
