/**
 * Catalogue rules for every tool: naming, documentation, annotations,
 * toolsets, read-only filtering, version gating and schema hygiene.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TOOLSETS, TOOLSETS, parseToolsets } from '../src/config.js';
import { ALL_TOOLS, selectTools } from '../src/index.js';
import { connect, fakeForgejo } from './helpers.js';

test('every tool is prefixed, unique, documented, annotated and in a known toolset', () => {
  assert.equal(ALL_TOOLS.length, 118);
  const names = new Set<string>();
  for (const tool of ALL_TOOLS) {
    assert.match(tool.name, /^forgejo_[a-z_]+$/, tool.name);
    assert.ok(!names.has(tool.name), `duplicate ${tool.name}`);
    names.add(tool.name);
    assert.ok(tool.title && tool.title.length <= 60, `${tool.name} needs a short title`);
    assert.ok(tool.description.length >= 60, `${tool.name} needs a fuller description`);
    assert.ok((TOOLSETS as readonly string[]).includes(tool.toolset), `${tool.name} has unknown toolset ${tool.toolset}`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name} missing ${hint}`);
    }
    if (tool.annotations.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false, `${tool.name} is read-only AND destructive`);
  }
});

test('read tools look like reads and write tools are never marked read-only', () => {
  for (const tool of ALL_TOOLS) {
    const verb = tool.name.replace(/^forgejo_(admin_)?/, '').split('_')[0];
    if (['create', 'update', 'delete', 'set', 'add', 'edit', 'remove', 'merge', 'dispatch', 'cancel', 'rerun', 'migrate', 'fork', 'push', 'mark', 'submit', 'dismiss', 'request', 'sync', 'run'].includes(verb)) {
      assert.equal(tool.annotations.readOnlyHint, false, `${tool.name} writes but is marked read-only`);
    }
    if (['get', 'list', 'search', 'compare', 'hello'].includes(verb)) {
      assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} reads but is not marked read-only`);
    }
  }
});

test('the destructive set is exactly what we expect (clients ask before these)', () => {
  const destructive = ALL_TOOLS.filter(t => t.annotations.destructiveHint).map(t => t.name).sort();
  assert.deepEqual(destructive, [
    'forgejo_cancel_workflow_run',
    'forgejo_delete_action_secret',
    'forgejo_delete_action_variable',
    'forgejo_delete_branch',
    'forgejo_delete_branch_protection',
    'forgejo_delete_file',
    'forgejo_delete_issue_comment',
    'forgejo_delete_label',
    'forgejo_delete_milestone',
    'forgejo_delete_org',
    'forgejo_delete_package_version',
    'forgejo_delete_pull_review',
    'forgejo_delete_push_mirror',
    'forgejo_delete_release',
    'forgejo_delete_repo',
    'forgejo_delete_tag',
    'forgejo_delete_webhook',
    'forgejo_delete_wiki_page',
    'forgejo_dismiss_pull_review',
    'forgejo_merge_pull_request',
    'forgejo_remove_collaborator',
    'forgejo_remove_org_member',
  ]);
});

test('toolset selection and read-only mode', () => {
  const defaults = selectTools(parseToolsets(undefined), false);
  assert.equal(defaults.length, 55);
  assert.ok(defaults.every(t => t.toolset === 'meta' || DEFAULT_TOOLSETS.includes(t.toolset)));
  assert.equal(selectTools(parseToolsets('all'), false).length, ALL_TOOLS.length);

  const readOnly = selectTools(parseToolsets('all'), true);
  assert.ok(readOnly.length > 40 && readOnly.length < ALL_TOOLS.length);
  assert.ok(readOnly.every(t => t.annotations.readOnlyHint === true));
  assert.ok(readOnly.some(t => t.name === 'forgejo_hello'));

  const issuesOnly = selectTools(parseToolsets('issues'), false).map(t => t.name);
  assert.ok(issuesOnly.includes('forgejo_hello'), 'meta is always on');
  assert.ok(issuesOnly.every(n => n === 'forgejo_hello' || ALL_TOOLS.find(t => t.name === n)!.toolset === 'issues'));
});

test('version-gated tools are exactly the Actions features added in Forgejo 16/17', () => {
  const gated = Object.fromEntries(ALL_TOOLS.filter(t => t.minVersion).map(t => [t.name, t.minVersion]));
  assert.deepEqual(gated, {
    forgejo_get_job_logs: '16.0',
    forgejo_cancel_workflow_run: '16.0',
    forgejo_list_run_artifacts: '16.0',
    forgejo_rerun_workflow: '17.0',
  });
});

test('gated tools refuse to run on older instances with a clear message, and say so in their description', async () => {
  const fake = fakeForgejo({}, { version: '14.0.3+gitea-1.22.0' });
  const { client, call, close } = await connect({ fetchImpl: fake.fetch });
  const res = await call('forgejo_get_job_logs', { owner: 'o', repo: 'r', job_id: 1 });
  assert.equal(res.isError, true);
  assert.match(res.text, /needs Forgejo 16\.0 or newer.*14\.0\.3/);
  assert.equal(fake.calls().length, 0, 'no API call is made');
  const listed = (await client.listTools()).tools.find(t => t.name === 'forgejo_rerun_workflow')!;
  assert.match(listed.description ?? '', /Requires Forgejo 17\.0 or newer/);
  await close();
});

test('tool input schemas contain no $ref and every parameter is described', async () => {
  const { client, close } = await connect({});
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, ALL_TOOLS.length);
  const undescribed: string[] = [];
  for (const tool of tools) {
    const schema = JSON.stringify(tool.inputSchema);
    assert.ok(!schema.includes('"$ref"'), `${tool.name} schema contains $ref`);
    for (const [param, def] of Object.entries((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>)) {
      if (!def.description) undescribed.push(`${tool.name}.${param}`);
    }
  }
  assert.deepEqual(undescribed, [], 'every parameter needs a description');
  await close();
});

test('tools are listed in a stable order (the same on every request)', async () => {
  const a = await connect({});
  const b = await connect({});
  assert.deepEqual((await a.client.listTools()).tools.map(t => t.name), (await b.client.listTools()).tools.map(t => t.name));
  await a.close();
  await b.close();
});
