#!/usr/bin/env node
/**
 * Live smoke test against a real Forgejo instance, over stdio like a real MCP client.
 *
 * Read-only by default. With SMOKE_WRITE=1 it also runs a full lifecycle on a
 * throw-away repository (created and deleted again):
 *   create repo → push files → branch → PR → review → merge → issue with labels
 *   → wiki page → release → delete repo
 *
 * Usage:
 *   npm run build
 *   npm run smoke                      (FORGEJO_URL + FORGEJO_ACCESS_TOKEN from env or .env)
 *   SMOKE_WRITE=1 npm run smoke
 */

import { readFileSync, existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Minimal .env loader (no dependency); never prints values.
const KEYS = ['FORGEJO_URL', 'FORGEJO_ACCESS_TOKEN', 'SMOKE_WRITE'];
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf-8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && KEYS.includes(match[1]) && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

if (!process.env.FORGEJO_URL || !process.env.FORGEJO_ACCESS_TOKEN) {
  console.error('Set FORGEJO_URL and FORGEJO_ACCESS_TOKEN (environment or .env) to run the live smoke test.');
  process.exit(1);
}
if (!existsSync('dist/cli.js')) {
  console.error('Run "npm run build" first.');
  process.exit(1);
}
const WRITE = ['1', 'true', 'yes'].includes(String(process.env.SMOKE_WRITE).toLowerCase());

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/cli.js'],
  env: {
    PATH: process.env.PATH ?? '',
    FORGEJO_URL: process.env.FORGEJO_URL,
    FORGEJO_ACCESS_TOKEN: process.env.FORGEJO_ACCESS_TOKEN,
    FORGEJO_TOOLSETS: 'all',
  },
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);

let failures = 0;
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { text: result.content.map(c => c.text).join('\n'), isError: Boolean(result.isError) };
}
async function check(label, name, args, expect, { allowError = false } = {}) {
  const res = await call(name, args);
  const ok = (allowError || !res.isError) && (!expect || expect.test(res.text));
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(res.text.split('\n').slice(0, 15).map(l => `      ${l}`).join('\n'));
  return res;
}
async function json(name, args) {
  const res = await call(name, { ...args, response_format: 'json' });
  if (res.isError) throw new Error(`${name}: ${res.text}`);
  return JSON.parse(res.text);
}

const tools = await client.listTools();
console.log(`Connected to ${process.env.FORGEJO_URL}: ${tools.tools.length} tools\n`);

// ---- Read-only checks -----------------------------------------------------------
await check('hello', 'forgejo_hello', {}, /Forgejo instance/);
const me = await json('forgejo_get_user', {});
console.log(`PASS  get_user (authenticated as ${me.login})`);
const repos = await json('forgejo_list_repos', { limit: 5 });
console.log(`PASS  list_repos (${repos.repositories.length} shown, total ${repos.total ?? '?'})`);
await check('search_repos', 'forgejo_search_repos', { limit: 3 });
await check('search_issues (assigned to me)', 'forgejo_search_issues', { assigned: true, limit: 5 });
await check('list_notifications', 'forgejo_list_notifications', { limit: 5 });
await check('list_orgs', 'forgejo_list_orgs', {});
const firstRepo = repos.repositories.find(r => !r.empty);
if (firstRepo) {
  const [owner, repo] = firstRepo.full_name.split('/');
  await check(`get_repo ${firstRepo.full_name}`, 'forgejo_get_repo', { owner, repo }, /Default branch/);
  await check('get_tree', 'forgejo_get_tree', { owner, repo, max_entries: 20 });
  await check('get_file_contents (root)', 'forgejo_get_file_contents', { owner, repo }, /directory/);
  await check('list_branches', 'forgejo_list_branches', { owner, repo });
  await check('list_commits', 'forgejo_list_commits', { owner, repo, limit: 3 });
  await check('list_issues', 'forgejo_list_issues', { owner, repo, state: 'all', limit: 3 });
  await check('list_pull_requests', 'forgejo_list_pull_requests', { owner, repo, state: 'all', limit: 3 });
  await check('list_labels', 'forgejo_list_labels', { owner, repo });
  await check('list_releases', 'forgejo_list_releases', { owner, repo, limit: 3 });
  await check('list_workflow_runs', 'forgejo_list_workflow_runs', { owner, repo, limit: 3 }, undefined, { allowError: true });
}

// ---- Write lifecycle on a throw-away repository ---------------------------------
if (WRITE) {
  const name = `mcp-smoke-${Date.now()}`;
  const owner = me.login;
  console.log(`\nWrite lifecycle on ${owner}/${name} (deleted at the end)`);
  try {
    await check('create_repo', 'forgejo_create_repo', { name, private: true, auto_init: true, default_branch: 'main' }, /Created repository/);
    await check('update_repo (wiki on, topics)', 'forgejo_update_repo', { owner, repo: name, has_wiki: true, topics: ['mcp-smoke'] });
    await check('push_files on new branch', 'forgejo_push_files', {
      owner,
      repo: name,
      message: 'smoke: add files',
      new_branch: 'feature/smoke',
      files: [
        { path: 'docs/hello.md', content: '# Hello\n\nfrom the smoke test\n' },
        { path: 'src/index.js', content: 'console.log("hi");\n' },
      ],
    }, /Committed 2 change/);
    await check('read file back', 'forgejo_get_file_contents', { owner, repo: name, path: 'docs/hello.md', ref: 'feature/smoke' }, /from the smoke test/);
    await check('compare', 'forgejo_compare_refs', { owner, repo: name, base: 'main', head: 'feature/smoke' }, /ahead/);
    await check('create_label (labels toolset)', 'forgejo_create_label', { owner, repo: name, name: 'smoke', color: '#0288d1' });
    await check('create_milestone', 'forgejo_create_milestone', { owner, repo: name, title: 'Smoke 1.0' });
    const pr = await check('create_pull_request', 'forgejo_create_pull_request', { owner, repo: name, title: 'Smoke PR', head: 'feature/smoke', labels: ['smoke'] }, /Opened pull request/);
    const prNumber = Number(/#(\d+)/.exec(pr.text)?.[1]);
    await check('get_pull_request', 'forgejo_get_pull_request', { owner, repo: name, index: prNumber }, /feature\/smoke/);
    await check('pull request diff', 'forgejo_get_pull_request_diff', { owner, repo: name, index: prNumber }, /docs\/hello\.md/);
    await check('comment on PR', 'forgejo_add_issue_comment', { owner, repo: name, index: prNumber, body: 'Smoke test comment' });
    await check('merge (squash, delete branch)', 'forgejo_merge_pull_request', { owner, repo: name, index: prNumber, method: 'squash', delete_branch: true }, /Merged/);
    await check('create_issue with label name + milestone title', 'forgejo_create_issue', { owner, repo: name, title: 'Smoke issue', labels: ['smoke'], milestone: 'Smoke 1.0' }, /Created issue/);
    await check('close issue', 'forgejo_update_issue', { owner, repo: name, index: prNumber + 1, state: 'closed' });
    await check('create wiki page', 'forgejo_create_wiki_page', { owner, repo: name, title: 'Home', content: '# Smoke wiki' });
    await check('read wiki page', 'forgejo_get_wiki_page', { owner, repo: name, page_name: 'Home' }, /Smoke wiki/);
    await check('create_release', 'forgejo_create_release', { owner, repo: name, tag_name: 'v0.0.1', name: 'Smoke release', body: 'notes' });
    await check('list_workflows (none expected)', 'forgejo_list_workflows', { owner, repo: name });
  } finally {
    await check('delete_repo (cleanup)', 'forgejo_delete_repo', { owner, repo: name, confirm_full_name: `${owner}/${name}` });
  }
}

await client.close();
console.log(failures ? `\n${failures} check(s) failed.` : `\nAll checks passed${WRITE ? ' (including the write lifecycle)' : ' (read-only; set SMOKE_WRITE=1 for the write lifecycle)'}.`);
process.exit(failures ? 1 : 0);
