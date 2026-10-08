/**
 * repo_admin toolset: repository deletion, collaborators, branch protection,
 * webhooks, push mirrors and mirror sync.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskUrl, repoAdminTools } from '../src/tools/repo-admin.js';
import { connect, fakeForgejo, json } from './helpers.js';

const empty = () => new Response(null, { status: 204 });

// -----------------------------------------------------------------------------
// Catalogue
// -----------------------------------------------------------------------------

test('repo_admin tools follow the catalogue rules', async () => {
  assert.equal(repoAdminTools.length, 14);
  for (const tool of repoAdminTools) {
    assert.match(tool.name, /^forgejo_[a-z_]+$/);
    assert.equal(tool.toolset, 'repo_admin');
    assert.ok(tool.description.length >= 60, `${tool.name} description too short`);
    assert.equal(tool.minVersion, undefined);
  }
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const mine = tools.filter(t => repoAdminTools.some(r => r.name === t.name));
  assert.equal(mine.length, 14);
  for (const t of mine) {
    assert.ok(!JSON.stringify(t.inputSchema).includes('$ref'), `${t.name} schema contains $ref`);
    for (const [prop, schema] of Object.entries(t.inputSchema.properties ?? {})) {
      assert.ok((schema as { description?: string }).description, `${t.name}.${prop} has no description`);
    }
  }
  const destructive = mine.filter(t => t.annotations?.destructiveHint).map(t => t.name).sort();
  assert.deepEqual(destructive, [
    'forgejo_delete_branch_protection',
    'forgejo_delete_push_mirror',
    'forgejo_delete_repo',
    'forgejo_delete_webhook',
    'forgejo_remove_collaborator',
  ]);
  await close();
});

test('maskUrl hides credentials embedded in URLs', () => {
  assert.equal(maskUrl('https://user:pa55@example.com/repo.git'), 'https://***@example.com/repo.git');
  assert.equal(maskUrl('https://ghp_abc@github.com/o/r.git'), 'https://***@github.com/o/r.git');
  assert.equal(maskUrl('https://ci.example.com/hook?access_token=s3cret&project=web'), 'https://ci.example.com/hook?access_token=***&project=web');
  assert.equal(
    maskUrl('https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
    'https://discord.com/api/webhooks/123456789012345678/***',
  );
  assert.equal(maskUrl('https://api.telegram.org/bot123456:ABC-DEF1234ghIkl/sendMessage?chat_id=1'), 'https://api.telegram.org/bot***/sendMessage?chat_id=1');
  assert.equal(maskUrl('https://ci.example.com/hooks/my-really-long-repository-name'), 'https://ci.example.com/hooks/my-really-long-repository-name');
  assert.equal(maskUrl('git@github.com:owner/repo.git'), 'git@github.com:owner/repo.git');
  assert.equal(maskUrl(undefined), undefined);
});

// -----------------------------------------------------------------------------
// Repository deletion
// -----------------------------------------------------------------------------

test('forgejo_delete_repo requires confirm_full_name to match', async () => {
  const fake = fakeForgejo({ 'DELETE /repos/o/r': empty });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const wrong = await call('forgejo_delete_repo', { owner: 'o', repo: 'r', confirm_full_name: 'o/other' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /does not match "o\/r", so nothing was deleted/);
  assert.equal(fake.calls().length, 0, 'no request is made without a matching confirmation');

  const ok = await call('forgejo_delete_repo', { owner: 'o', repo: 'r', confirm_full_name: 'o/r' });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /Permanently deleted repository \*\*o\/r\*\*/);
  const calls = fake.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].path, '/repos/o/r');
  await close();
});

// -----------------------------------------------------------------------------
// Collaborators
// -----------------------------------------------------------------------------

test('forgejo_list_collaborators lists users, optionally with permissions', async () => {
  const fake = fakeForgejo({
    'GET /repos/o/r/collaborators': () =>
      json(
        [
          { login: 'alice', full_name: 'Alice A', email: 'alice@example.com' },
          { login: 'bob', full_name: '' },
        ],
        200,
        { 'x-total-count': '2' },
      ),
    'GET /repos/o/r/collaborators/alice/permission': () => json({ permission: 'admin', role_name: 'admin', user: { login: 'alice' } }),
    'GET /repos/o/r/collaborators/bob/permission': () => json({ message: 'boom' }, 500),
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const plain = await call('forgejo_list_collaborators', { owner: 'o', repo: 'r', page: 1, limit: 10 });
  assert.equal(plain.isError, false);
  assert.match(plain.text, /## Collaborators of o\/r/);
  assert.match(plain.text, /\| alice \| Alice A \|/);
  assert.doesNotMatch(plain.text, /Permission/);
  const listCall = fake.calls()[0];
  assert.equal(listCall.path, '/repos/o/r/collaborators');
  assert.equal(listCall.query.get('limit'), '10');
  assert.equal(listCall.query.get('page'), '1');
  assert.equal(fake.calls().length, 1, 'no permission lookups by default');

  const withPerms = await call('forgejo_list_collaborators', { owner: 'o', repo: 'r', include_permissions: true });
  assert.equal(withPerms.isError, false);
  assert.match(withPerms.text, /\| alice \| Alice A \| admin \|/);
  assert.match(withPerms.text, /\| bob \|  \| — \|/);
  assert.match(withPerms.text, /Permission lookups that failed:\n- bob: .*HTTP 500/);

  const asJson = JSON.parse((await call('forgejo_list_collaborators', { owner: 'o', repo: 'r', include_permissions: true, response_format: 'json' })).text);
  assert.deepEqual(asJson.collaborators[0], { login: 'alice', full_name: 'Alice A', permission: 'admin' });
  assert.deepEqual(asJson.collaborators[1], { login: 'bob' });
  assert.equal(asJson.permission_lookup_failures.length, 1);
  assert.equal(asJson.total, 2);
  assert.ok(!JSON.stringify(asJson).includes('alice@example.com'), 'no raw user objects');
  await close();
});

test('forgejo_set_collaborator adds or changes access', async () => {
  let isCollaborator = false;
  const fake = fakeForgejo({
    'GET /repos/o/r/collaborators/new user': () => (isCollaborator ? empty() : json({ message: 'not found' }, 404)),
    'PUT /repos/o/r/collaborators/new user': () => {
      isCollaborator = true;
      return empty();
    },
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const added = await call('forgejo_set_collaborator', { owner: 'o', repo: 'r', username: 'new user', permission: 'write' });
  assert.equal(added.isError, false);
  assert.match(added.text, /Added \*\*new user\*\* as a collaborator on o\/r with \*\*write\*\* access/);
  const put = fake.calls().find(c => c.method === 'PUT')!;
  assert.equal(put.path, '/repos/o/r/collaborators/new%20user');
  assert.deepEqual(put.json, { permission: 'write' });

  const changed = await call('forgejo_set_collaborator', { owner: 'o', repo: 'r', username: 'new user', permission: 'admin' });
  assert.match(changed.text, /Changed \*\*new user\*\*'s access on o\/r to \*\*admin\*\*/);

  const invalid = await call('forgejo_set_collaborator', { owner: 'o', repo: 'r', username: 'x', permission: 'owner' });
  assert.equal(invalid.isError, true);
  await close();
});

test('forgejo_remove_collaborator deletes the collaborator', async () => {
  const fake = fakeForgejo({ 'DELETE /repos/o/r/collaborators/bob': empty });
  const { call, close } = await connect({ fetchImpl: fake.fetch });
  const res = await call('forgejo_remove_collaborator', { owner: 'o', repo: 'r', username: 'bob' });
  assert.equal(res.isError, false);
  assert.match(res.text, /Removed \*\*bob\*\* from the collaborators of o\/r/);
  assert.equal(fake.calls()[0].method, 'DELETE');
  await close();
});

// -----------------------------------------------------------------------------
// Branch protection
// -----------------------------------------------------------------------------

const MAIN_RULE = {
  rule_name: 'main',
  branch_name: 'main',
  enable_push: true,
  enable_push_whitelist: true,
  push_whitelist_usernames: ['alice'],
  push_whitelist_teams: ['release'],
  push_whitelist_deploy_keys: true,
  enable_merge_whitelist: false,
  required_approvals: 2,
  enable_approvals_whitelist: true,
  approvals_whitelist_username: ['carol'],
  enable_status_check: true,
  status_check_contexts: ['ci/build', 'ci/*'],
  block_on_rejected_reviews: true,
  block_on_outdated_branch: true,
  dismiss_stale_approvals: true,
  require_signed_commits: true,
  protected_file_patterns: '.forgejo/workflows/**',
  apply_to_admins: false,
  updated_at: '2026-10-01T10:00:00Z',
};

test('forgejo_list_branch_protections shows the key settings', async () => {
  const fake = fakeForgejo({
    'GET /repos/o/r/branch_protections': () => json([MAIN_RULE, { rule_name: 'release/*', enable_push: false }]),
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const md = await call('forgejo_list_branch_protections', { owner: 'o', repo: 'r' });
  assert.equal(md.isError, false);
  assert.match(md.text, /## Branch protection rules in o\/r \(2\)/);
  assert.match(md.text, /### main/);
  assert.match(md.text, /\*\*Push:\*\* only @alice, team release, plus deploy keys/);
  assert.match(md.text, /\*\*Required approvals:\*\* 2 \(counted only from @carol\)/);
  assert.match(md.text, /\*\*Status checks:\*\* required: ci\/build, ci\/\*/);
  assert.match(md.text, /\*\*Merging blocked by:\*\* rejected reviews, branch behind base/);
  assert.match(md.text, /\*\*Signed commits required:\*\* yes/);
  assert.match(md.text, /\*\*Protected files:\*\* \.forgejo\/workflows\/\*\*/);
  assert.match(md.text, /### release\/\*\n\n- \*\*Push:\*\* blocked for everyone/);

  const asJson = JSON.parse((await call('forgejo_list_branch_protections', { owner: 'o', repo: 'r', response_format: 'json' })).text);
  assert.equal(asJson.rules.length, 2);
  assert.equal(asJson.rules[0].required_approvals, 2);
  assert.equal(asJson.rules[0].apply_to_admins, false);
  assert.equal(asJson.rules[0].branch_name, undefined, 'deprecated field is not passed through');
  assert.equal(asJson.rules[1].enable_push, false);

  const none = fakeForgejo({ 'GET /repos/o/r/branch_protections': () => json([]) });
  const second = await connect({ fetchImpl: none.fetch });
  assert.match((await second.call('forgejo_list_branch_protections', { owner: 'o', repo: 'r' })).text, /has no branch protection rules/);
  await second.close();
  await close();
});

test('forgejo_set_branch_protection creates a missing rule (glob name encoded)', async () => {
  const fake = fakeForgejo({
    'GET /repos/o/r/branch_protections/release/*': () => json({ message: 'not found' }, 404),
    'POST /repos/o/r/branch_protections': req => json({ ...req.json, created_at: '2026-10-08T00:00:00Z' }, 201),
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const res = await call('forgejo_set_branch_protection', {
    owner: 'o',
    repo: 'r',
    rule_name: 'release/*',
    push_whitelist_usernames: ['alice'],
    required_approvals: 1,
    status_check_contexts: ['ci/build'],
  });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /Created branch protection rule \*\*release\/\*\*\* in o\/r/);
  assert.match(res.text, /also sent: enable_push_whitelist=true, enable_push=true, enable_status_check=true/);
  assert.match(res.text, /\*\*Push:\*\* only @alice/);

  const [get, post] = fake.calls();
  assert.equal(get.method, 'GET');
  assert.equal(get.path, '/repos/o/r/branch_protections/release%2F*');
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.json, {
    rule_name: 'release/*',
    push_whitelist_usernames: ['alice'],
    required_approvals: 1,
    status_check_contexts: ['ci/build'],
    enable_push_whitelist: true,
    enable_push: true,
    enable_status_check: true,
  });
  await close();
});

test('forgejo_set_branch_protection updates an existing rule with only the given fields', async () => {
  const fake = fakeForgejo({
    'GET /repos/o/r/branch_protections/main': () => json(MAIN_RULE),
    'PATCH /repos/o/r/branch_protections/main': req => json({ ...MAIN_RULE, ...req.json }),
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const res = await call('forgejo_set_branch_protection', {
    owner: 'o',
    repo: 'r',
    rule_name: 'main',
    required_approvals: 3,
    protected_file_patterns: '',
    response_format: 'json',
  });
  assert.equal(res.isError, false, res.text);
  const out = JSON.parse(res.text);
  assert.equal(out.created, false);
  assert.equal(out.rule.required_approvals, 3);
  assert.equal(out.implied_settings, undefined);
  const patch = fake.calls().find(c => c.method === 'PATCH')!;
  assert.deepEqual(patch.json, { required_approvals: 3, protected_file_patterns: '' }, 'no rule_name and no unspecified fields');
  assert.ok(!fake.calls().some(c => c.method === 'POST'));

  // Deploy-key switch alone: the current push switches are sent along so Forgejo applies it.
  await call('forgejo_set_branch_protection', { owner: 'o', repo: 'r', rule_name: 'main', push_whitelist_deploy_keys: false });
  const second = fake.calls().filter(c => c.method === 'PATCH')[1];
  assert.deepEqual(second.json, { push_whitelist_deploy_keys: false, enable_push_whitelist: true, enable_push: true });

  const nothing = await call('forgejo_set_branch_protection', { owner: 'o', repo: 'r', rule_name: 'main' });
  assert.equal(nothing.isError, true);
  assert.match(nothing.text, /already exists in o\/r; pass at least one setting/);

  const conflict = await call('forgejo_set_branch_protection', {
    owner: 'o',
    repo: 'r',
    rule_name: 'main',
    enable_push: false,
    push_whitelist_usernames: ['alice'],
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.text, /enable_push: false blocks all direct pushes/);
  assert.equal(fake.calls().filter(c => c.method === 'PATCH').length, 2, 'invalid input sends no PATCH');
  await close();
});

test('forgejo_delete_branch_protection deletes the encoded rule', async () => {
  const fake = fakeForgejo({ 'DELETE /repos/o/r/branch_protections/release/*': empty });
  const { call, close } = await connect({ fetchImpl: fake.fetch });
  const res = await call('forgejo_delete_branch_protection', { owner: 'o', repo: 'r', rule_name: 'release/*' });
  assert.equal(res.isError, false);
  assert.match(res.text, /Deleted branch protection rule \*\*release\/\*\*\* from o\/r/);
  assert.equal(fake.calls()[0].path, '/repos/o/r/branch_protections/release%2F*');
  await close();
});

// -----------------------------------------------------------------------------
// Webhooks
// -----------------------------------------------------------------------------

const HOOK_SECRET = 'super-secret-value';
const AUTH_HEADER = 'Bearer hook-auth-token-123';

test('forgejo_list_webhooks never prints secrets', async () => {
  const fake = fakeForgejo({
    'GET /repos/o/r/hooks': () =>
      json(
        [
          {
            id: 7,
            type: 'forgejo',
            config: { url: 'https://ci.example.com/hook', content_type: 'json', secret: HOOK_SECRET },
            events: ['push', 'pull_request'],
            active: true,
            branch_filter: 'main',
            authorization_header: AUTH_HEADER,
            metadata: { bot_token: 'meta-bot-token' },
            updated_at: '2026-10-01T10:00:00Z',
          },
          {
            id: 8,
            type: 'discord',
            config: { url: 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', content_type: 'json' },
            events: ['release'],
            active: false,
          },
        ],
        200,
        { 'x-total-count': '2' },
      ),
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const md = await call('forgejo_list_webhooks', { owner: 'o', repo: 'r' });
  assert.equal(md.isError, false);
  assert.match(md.text, /## Webhooks of o\/r/);
  assert.match(md.text, /\| 7 \| forgejo \| https:\/\/ci\.example\.com\/hook \| push, pull_request \| yes \| main \| 2026-10-01 10:00 UTC \|/);
  assert.match(md.text, /\| 8 \| discord \| https:\/\/discord\.com\/api\/webhooks\/123456789012345678\/\*\*\* \| release \| no \|/);

  const raw = await call('forgejo_list_webhooks', { owner: 'o', repo: 'r', response_format: 'json' });
  const out = JSON.parse(raw.text);
  assert.equal(out.webhooks[0].authorization_header_set, true);
  assert.equal(out.webhooks[0].url, 'https://ci.example.com/hook');
  assert.equal(out.total, 2);

  for (const text of [md.text, raw.text]) {
    assert.ok(!text.includes(HOOK_SECRET), 'secret leaked');
    assert.ok(!text.includes(AUTH_HEADER), 'authorization header leaked');
    assert.ok(!text.includes('meta-bot-token'), 'metadata leaked');
    assert.ok(!text.includes('AbCdEfGhIjKlMnOp'), 'URL token leaked');
  }
  await close();
});

test('forgejo_create_webhook sends the right body and hides the secret', async () => {
  const fake = fakeForgejo({
    'POST /repos/o/r/hooks': req =>
      json(
        {
          id: 12,
          type: req.json.type,
          config: { url: req.json.config.url, content_type: req.json.config.content_type },
          events: req.json.events,
          active: req.json.active,
          branch_filter: req.json.branch_filter ?? '*',
          authorization_header: req.json.authorization_header ?? '',
        },
        201,
      ),
    'POST /repos/o/r/hooks/12/tests': empty,
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const res = await call('forgejo_create_webhook', {
    owner: 'o',
    repo: 'r',
    url: 'https://ci.example.com/hook',
    secret: HOOK_SECRET,
    authorization_header: AUTH_HEADER,
    test: true,
  });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /Created webhook \*\*#12\*\* \(forgejo\) on o\/r/);
  assert.match(res.text, /\*\*Events:\*\* push/);
  assert.match(res.text, /\*\*Secret:\*\* set \(hidden\)/);
  assert.match(res.text, /\*\*Authorization header:\*\* set \(hidden\)/);
  assert.match(res.text, /\*\*Deliveries:\*\* https:\/\/git\.example\.com\/o\/r\/settings\/hooks\/12/);
  assert.match(res.text, /Test push event sent/);
  assert.ok(!res.text.includes(HOOK_SECRET));
  assert.ok(!res.text.includes(AUTH_HEADER));

  const [create, testCall] = fake.calls();
  assert.deepEqual(create.json, {
    type: 'forgejo',
    config: { url: 'https://ci.example.com/hook', content_type: 'json', secret: HOOK_SECRET },
    events: ['push'],
    active: true,
    authorization_header: AUTH_HEADER,
  });
  assert.equal(testCall.method, 'POST');
  assert.equal(testCall.path, '/repos/o/r/hooks/12/tests');

  // Slack with extra config, JSON output, no secret.
  const slack = await call('forgejo_create_webhook', {
    owner: 'o',
    repo: 'r',
    url: 'https://hooks.slack.com/services/T000/B000/XyZaBc123DeF456GhI789JkL',
    type: 'slack',
    events: ['release', 'issues'],
    branch_filter: 'main',
    extra_config: { channel: '#dev' },
    response_format: 'json',
  });
  const out = JSON.parse(slack.text);
  assert.equal(out.id, 12);
  assert.equal(out.url, 'https://hooks.slack.com/services/T000/B000/***');
  assert.deepEqual(out.events, ['release', 'issues']);
  assert.equal(out.secret_set, undefined);
  assert.equal(out.test, undefined);
  const slackBody = fake.calls()[2].json;
  assert.deepEqual(slackBody.config, { channel: '#dev', url: 'https://hooks.slack.com/services/T000/B000/XyZaBc123DeF456GhI789JkL', content_type: 'json' });
  assert.equal(slackBody.branch_filter, 'main');
  assert.equal(fake.calls().length, 3, 'no test call without test: true');

  const reserved = await call('forgejo_create_webhook', { owner: 'o', repo: 'r', url: 'https://x.example.com', extra_config: { secret: 'x' } });
  assert.equal(reserved.isError, true);
  assert.match(reserved.text, /Pass secret as top-level parameters/);

  const badType = await call('forgejo_create_webhook', { owner: 'o', repo: 'r', url: 'https://x.example.com', type: 'matrix' });
  assert.equal(badType.isError, true);
  assert.equal(fake.calls().length, 3, 'invalid input sends nothing');
  await close();
});

test('forgejo_create_webhook reports a failed test without failing the call', async () => {
  const fake = fakeForgejo({
    'POST /repos/o/r/hooks': () => json({ id: 3, type: 'forgejo', config: { url: 'https://x.example.com', content_type: 'json' }, events: ['push'], active: true }, 201),
    'POST /repos/o/r/hooks/3/tests': () => json({ message: 'repository is empty' }, 500),
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });
  const res = await call('forgejo_create_webhook', { owner: 'o', repo: 'r', url: 'https://x.example.com', test: true });
  assert.equal(res.isError, false);
  assert.match(res.text, /Created webhook \*\*#3\*\*/);
  assert.match(res.text, /The webhook was created, but sending the test event failed: .*repository is empty/);
  await close();
});

test('forgejo_delete_webhook deletes by ID', async () => {
  const fake = fakeForgejo({ 'DELETE /repos/o/r/hooks/5': empty });
  const { call, close } = await connect({ fetchImpl: fake.fetch });
  const res = await call('forgejo_delete_webhook', { owner: 'o', repo: 'r', id: 5 });
  assert.equal(res.isError, false);
  assert.match(res.text, /Deleted webhook #5 from o\/r/);
  assert.equal(fake.calls()[0].method, 'DELETE');
  await close();
});

// -----------------------------------------------------------------------------
// Push mirrors
// -----------------------------------------------------------------------------

const MIRROR_PASSWORD = 'ghp_mirrorTokenValue123';

test('forgejo_list_push_mirrors shows mirror state without credentials', async () => {
  const fake = fakeForgejo({
    'GET /repos/o/r/push_mirrors': () =>
      json([
        {
          remote_name: 'remote_mirror_abc',
          remote_address: 'https://github.com/o/r.git',
          interval: '8h0m0s',
          sync_on_commit: true,
          branch_filter: '',
          last_update: '2026-10-07T12:00:00Z',
          last_error: 'push failed: https://user:hunter2@github.com/o/r.git rejected',
          created: '2026-01-01T00:00:00Z',
        },
        {
          remote_name: 'remote_mirror_ssh',
          remote_address: 'git@codeberg.org:o/r.git',
          interval: '0s',
          sync_on_commit: false,
          last_update: '0001-01-01T00:00:00Z',
          public_key: 'ssh-ed25519 AAAAC3Nza forgejo',
        },
      ]),
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const md = await call('forgejo_list_push_mirrors', { owner: 'o', repo: 'r' });
  assert.equal(md.isError, false);
  assert.match(md.text, /## Push mirrors of o\/r/);
  assert.match(md.text, /\| remote_mirror_abc \| https:\/\/github\.com\/o\/r\.git \| 8h0m0s \| yes \| all \| 2026-10-07 12:00 UTC \| push failed: https:\/\/\*\*\*@github\.com/);
  assert.match(md.text, /\| remote_mirror_ssh \| git@codeberg\.org:o\/r\.git \| 0s \| no \| all \| never \|/);
  assert.match(md.text, /SSH public key of \*\*remote_mirror_ssh\*\*[\s\S]*ssh-ed25519 AAAAC3Nza forgejo/);
  assert.ok(!md.text.includes('hunter2'));
  assert.equal(fake.calls()[0].query.get('limit'), '20');

  const out = JSON.parse((await call('forgejo_list_push_mirrors', { owner: 'o', repo: 'r', response_format: 'json' })).text);
  assert.equal(out.push_mirrors.length, 2);
  assert.equal(out.push_mirrors[0].sync_on_commit, true);
  assert.equal(out.push_mirrors[1].last_update, undefined, '"never" dates are dropped');
  assert.ok(!JSON.stringify(out).includes('hunter2'));
  await close();
});

test('forgejo_create_push_mirror sends credentials but never prints them', async () => {
  const fake = fakeForgejo({
    'POST /repos/o/r/push_mirrors': req =>
      json({
        remote_name: 'remote_mirror_new',
        remote_address: req.json.remote_address,
        interval: req.json.interval,
        sync_on_commit: req.json.sync_on_commit,
        branch_filter: req.json.branch_filter ?? '',
        public_key: req.json.use_ssh ? 'ssh-ed25519 AAAAgenerated forgejo' : '',
      }),
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const res = await call('forgejo_create_push_mirror', {
    owner: 'o',
    repo: 'r',
    remote_address: 'https://github.com/o/r.git',
    remote_username: 'octo',
    remote_password: MIRROR_PASSWORD,
  });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /Created push mirror \*\*remote_mirror_new\*\* on o\/r → https:\/\/github\.com\/o\/r\.git/);
  assert.match(res.text, /\*\*Interval:\*\* 8h0m0s/);
  assert.match(res.text, /\*\*Push on every commit:\*\* yes/);
  assert.match(res.text, /forgejo_sync_mirror/);
  assert.ok(!res.text.includes(MIRROR_PASSWORD));
  assert.deepEqual(fake.calls()[0].json, {
    remote_address: 'https://github.com/o/r.git',
    remote_username: 'octo',
    remote_password: MIRROR_PASSWORD,
    interval: '8h0m0s',
    sync_on_commit: true,
  });

  const ssh = await call('forgejo_create_push_mirror', {
    owner: 'o',
    repo: 'r',
    remote_address: 'git@github.com:o/r.git',
    use_ssh: true,
    interval: '1h30m',
    sync_on_commit: false,
    branch_filter: 'main',
  });
  assert.equal(ssh.isError, false, ssh.text);
  assert.match(ssh.text, /deploy key \*\*with write access\*\*/);
  assert.match(ssh.text, /ssh-ed25519 AAAAgenerated forgejo/);
  assert.deepEqual(fake.calls()[1].json, {
    remote_address: 'git@github.com:o/r.git',
    interval: '1h30m',
    sync_on_commit: false,
    branch_filter: 'main',
    use_ssh: true,
  });

  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ remote_address: 'https://octo:pw@github.com/o/r.git' }, /Do not put credentials inside remote_address/],
    [{ remote_address: 'git@github.com:o/r.git' }, /set use_ssh: true/],
    [{ remote_address: 'git@github.com:o/r.git', use_ssh: true, remote_password: 'x', remote_username: 'y' }, /do not pass remote_username or remote_password/],
    [{ remote_address: 'https://github.com/o/r.git', remote_password: 'x' }, /remote_password needs remote_username/],
    [{ remote_address: 'https://github.com/o/r.git', interval: 'every hour' }, /duration/],
  ];
  for (const [args, message] of cases) {
    const bad = await call('forgejo_create_push_mirror', { owner: 'o', repo: 'r', ...args });
    assert.equal(bad.isError, true, JSON.stringify(args));
    assert.match(bad.text, message);
    assert.ok(!bad.text.includes('octo:pw'), 'credentials are not echoed back');
  }
  assert.equal(fake.calls().length, 2, 'invalid input sends nothing');
  await close();
});

test('forgejo_delete_push_mirror deletes by remote name', async () => {
  const fake = fakeForgejo({ 'DELETE /repos/o/r/push_mirrors/remote_mirror_abc': empty });
  const { call, close } = await connect({ fetchImpl: fake.fetch });
  const res = await call('forgejo_delete_push_mirror', { owner: 'o', repo: 'r', remote_name: 'remote_mirror_abc' });
  assert.equal(res.isError, false);
  assert.match(res.text, /Deleted push mirror \*\*remote_mirror_abc\*\* from o\/r/);
  assert.equal(fake.calls()[0].method, 'DELETE');
  await close();
});

// -----------------------------------------------------------------------------
// Mirror sync
// -----------------------------------------------------------------------------

test('forgejo_sync_mirror triggers pull, push or both', async () => {
  const notMirror = () => json({ message: 'Repository is not a mirror' }, 400);
  const fake = fakeForgejo({
    'POST /repos/o/pull/mirror-sync': () => new Response(null, { status: 200 }),
    'POST /repos/o/push/mirror-sync': notMirror,
    'GET /repos/o/push/push_mirrors': () => json([{ remote_name: 'remote_mirror_gh' }], 200, { 'x-total-count': '1' }),
    'POST /repos/o/push/push_mirrors-sync': () => new Response(null, { status: 200 }),
    'POST /repos/o/plain/mirror-sync': notMirror,
    'GET /repos/o/plain/push_mirrors': () => json([], 200, { 'x-total-count': '0' }),
  });
  const { call, close } = await connect({ fetchImpl: fake.fetch });

  const pull = await call('forgejo_sync_mirror', { owner: 'o', repo: 'pull', which: 'pull' });
  assert.equal(pull.isError, false);
  assert.match(pull.text, /Pull mirror: sync queued/);
  assert.deepEqual(fake.calls().map(c => `${c.method} ${c.path}`), ['POST /repos/o/pull/mirror-sync']);

  const pullFail = await call('forgejo_sync_mirror', { owner: 'o', repo: 'push', which: 'pull' });
  assert.equal(pullFail.isError, true);
  assert.match(pullFail.text, /Repository is not a mirror/);

  const push = await call('forgejo_sync_mirror', { owner: 'o', repo: 'push', which: 'push' });
  assert.equal(push.isError, false);
  assert.match(push.text, /Push mirrors: sync queued for 1 mirror \(remote_mirror_gh\)/);

  const noPush = await call('forgejo_sync_mirror', { owner: 'o', repo: 'plain', which: 'push' });
  assert.equal(noPush.isError, true);
  assert.match(noPush.text, /has no push mirrors/);
  assert.ok(!fake.calls().some(c => c.path === '/repos/o/plain/push_mirrors-sync'), 'no sync without push mirrors');

  // "both" tolerates the pull part failing on a repo that is not a pull mirror, and reports it.
  const both = await call('forgejo_sync_mirror', { owner: 'o', repo: 'push' });
  assert.equal(both.isError, false);
  assert.match(both.text, /- Pull mirror: not synced\. .*Repository is not a mirror/);
  assert.match(both.text, /- Push mirrors: sync queued for 1 mirror/);

  const nothing = await call('forgejo_sync_mirror', { owner: 'o', repo: 'plain', which: 'both' });
  assert.equal(nothing.isError, true);
  assert.match(nothing.text, /Nothing was synced for o\/plain/);
  assert.match(nothing.text, /Pull mirror: not synced/);
  assert.match(nothing.text, /Push mirrors: not synced\. o\/plain has no push mirrors/);
  await close();
});
