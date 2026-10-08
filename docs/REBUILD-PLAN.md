# Forgejo MCP v3: Revamp Plan

> **Status:** ✅ Done on 2026-10-08. Approved with the recommended options D1–D7, built, merged ([#1](https://github.com/hithereiamaliff/mcp-forgejo/pull/1), [mcp-key-service#2](https://github.com/hithereiamaliff/mcp-key-service/pull/2)), deployed and tested end to end. Deviation from §5: the host port is `MCP_HOST_PORT` (production 8100) because 8098 was taken. The VPS runbook is [deploy/DEPLOYMENT.md](../deploy/DEPLOYMENT.md), and the Forgejo 14 → 15 upgrade (D5) is recorded in [FORGEJO-UPGRADE.md](FORGEJO-UPGRADE.md).
> **Replaces:** the April 2026 rebuild plan (commit `dcbd650`). The corrections are listed in §1.5.
> **Goal:** Replace the Go fork of `goern/forgejo-mcp` with a TypeScript MCP server. It should follow the proven **TechMavie v2 pattern** (`mcp-zerobounce` v2 / `mcp-github` v2), integrate fully with `mcp-key-service`, support multiple tenants (any Forgejo instance, including Codeberg), and cover far more of the Forgejo API than today.

---

## 0. Summary

| | Today (Go fork, v2.17.0) | Target (TypeScript, v3.0.0) |
|---|---|---|
| Stack | Go binary, forgejo-sdk v3 | Node 24, TypeScript, Express 5, `@modelcontextprotocol/sdk` 1.32.x, zod 3 |
| Tenancy | One token and one instance per process | **Per-request credentials**: every request can target a different instance and token |
| Auth | `--token` flag or env | `usr_` key via key service (path, Bearer, header or query), self-hosted headers, CLI env |
| Tools | 72 generic names (`get_issue_by_index`…) | ~118 tools prefixed `forgejo_*` in **toolsets**, with a **read-only mode**. About 55 are on by default. |
| Output | Raw JSON dumps | Compact **markdown** by default, plus `response_format: "json"` (compact projections, not raw API objects) |
| Safety | None specific | SSRF guard on user-supplied URLs, token scrubbing, no redirects, size caps, prompt-injection notice |
| Ops | Not deployed in the TechMavie stack | Docker on Hetzner behind Nginx at `mcp.techmavie.digital/forgejo/`, plus analytics dashboard, server card, CI deploy |
| Tests | Go unit tests (upstream's) | `node:test`: unit, catalogue rules, HTTP integration, fake key service, fake Forgejo, and a live smoke test against `git.mynameisaliff.co.uk` |

---

## 1. Findings

### 1.1 The current repo

- `hithereiamaliff/mcp-forgejo` is a fork of `goern/forgejo-mcp` at **v2.17.0**. It is Go, with 72 tools across user, repos, branches, files, commits, issues, PRs and reviews, orgs and teams, notifications, Actions (dispatch, list and get runs) and wiki.
- Almost all of it is upstream's work: about 120 commits by Christoph Görn. Several directories are upstream's own tooling and have no use in your workflow: `.beads/` (the `bd` issue tracker), `openspec/`, `.forgejo/workflows`, `.husky`, `.releaserc`, `.renovaterc`, `.social-media`, `demos/`, `.devcontainer`, and the `.claude/` OpenSpec commands and skills.
- Known limitations:
  - **One token per process.** It cannot serve multiple users safely.
  - Labels can only be added by numeric ID.
  - No key-service integration and no analytics.
  - Generic tool names that collide with the GitHub MCP when both are connected (`create_issue`, `list_branches`…).
- **Upstream has moved a long way.** It now lives at `git.b4mad.industries/agentic-forges/forgejo-mcp` and is at **v3.2.0** (Sept 2026, about 165 tools, OAuth resource-server mode). Syncing the fork is a valid alternative, but it keeps the Go stack and still needs custom key-service glue. Rejected; see §9.

### 1.2 Your Forgejo instance: `https://git.mynameisaliff.co.uk`

Probed live:

| Check | Result |
|---|---|
| `GET /api/v1/version` | **`14.0.3+gitea-1.22.0`** |
| `GET /api/v1/settings/api` | `max_response_items: 50`, `default_paging_num: 30`, `default_git_trees_per_page: 1000`, `default_max_blob_size: 10485760` |
| `GET /api/v1/settings/repository` | mirrors, migrations, LFS, stars, forks and time tracking all **enabled** |
| `GET /swagger.v1.json` | 200, **473 operations**. Breakdown: repository 184, user 74, issue 67, organization 65, admin 42, misc 13, activitypub 11, notification 7, package 6, settings 4. |
| Pagination headers | `Link` + `X-Total-Count` |
| Rate-limit headers | none |

> ⚠️ **Security: Forgejo 14 is end-of-life since 30 April 2026.** Your 14.0.3 is missing at least 14.0.4 (Go security patches) and 14.0.5, which fixed an authorization bypass: *any authenticated user could write to public repos they don't own*. Forgejo's advice is to upgrade v14 to v15 immediately.
>
> | Version | Status |
> |---|---|
> | **15.0.x LTS** | supported to 15 Jul 2027; latest 15.0.9 |
> | **16.0.x** | EOL 29 Oct 2026 |
> | **17.0** | releases 15 Oct 2026, EOL 28 Jan 2027 |
>
> This is separate from the MCP work, but it affects which Actions tools will work (§2.11). See decision **D5**.

**Forgejo API facts the design relies on:**

- **Auth header:** `Authorization: token <PAT>`. `Bearer` also works.
- **Pagination:** `page` (1-based) and `limit`. `limit` is **silently capped** at `max_response_items` (50). `X-Total-Count` gives totals. The git-trees endpoint uses `per_page`.
- **Token scopes:** `read:`/`write:` pairs for `activitypub, admin, issue, misc, notification, organization, package, repository, user`.
  - **No endpoint reveals a token's scopes.** Missing scopes return 403 with `token does not have at least one of required scope(s): [read:user]`, and the server parses that into actionable advice.
  - Repo-specific tokens (v15+) cannot use `read:user`, so `GET /user` will fail. "Who am I" must degrade gracefully.
- **Labels can be passed by name *or* ID** to `PUT/POST /issues/{index}/labels` (`IssueLabelsOption`). This fixes the Go fork's ID-only limitation. `POST /issues` (create) still needs IDs, so the server resolves names first.
- **Global issue/PR search exists:** `GET /repos/issues/search` with `assigned`, `created`, `mentioned`, `review_requested`, `reviewed`, `owner`, `team`, `type`, `labels` and `sort`.
- **Multi-file commits exist:** `POST /repos/{o}/{r}/contents` (`ChangeFilesOptions`, with create, update, delete and rename operations, and `new_branch`).
- **PR extras:**
  - `GET /pulls/{index}.diff|.patch`
  - `POST /pulls/{index}/update?style=merge|rebase` (update branch)
  - merge `Do: merge|rebase|rebase-merge|squash|fast-forward-only|manually-merged`
  - `merge_when_checks_succeed` (auto-merge), and `DELETE /pulls/{index}/merge` cancels it
- **Combined commit status:** `GET /commits/{ref}/status` and `/statuses`.
- **Migrations and mirrors:**
  - `POST /repos/migrate` (`service: github|gitlab|gitea|gogs|…`, `mirror`, include issues, PRs, releases and wiki, `auth_token`). This lets you **import or mirror your GitHub repos into Forgejo** with one tool call.
  - Push mirrors: `/push_mirrors`, plus `/mirror-sync`.
- **Wiki API exists** (it was "blocked" only in the Go SDK): `wiki/new`, `wiki/page/{name}` (GET, PATCH, DELETE), `wiki/pages` and `wiki/revisions/{name}`.
- **Actions on v14:**
  - available: `GET /actions/runs` (filters: event, status, run_number, head_sha), `GET /actions/runs/{id}`, `GET /actions/tasks`, `POST /actions/workflows/{file}/dispatches` (with `return_run_info`), and repo/org/user secrets and variables
  - **not available:** jobs, logs, cancel, rerun and artifacts; they arrive in v16 and v17 (§2.11)
  - there is no "list workflows" endpoint in any version, so the server synthesises it from `.forgejo/workflows/`
- **No code-search API**, and no Projects/Kanban API, even in v17.

### 1.3 Reference MCPs compared

| | mcp-github v2 | mcp-keywords-everywhere | **mcp-zerobounce v2** |
|---|---|---|---|
| Base | TS, SDK 1.18, Express 4, `server.tool()` | single 1850-line JS file, hand-rolled JSON-RPC | **TS, SDK 1.32.1, Express 5, `defineTool` + `registerTool`** |
| Key service | inline, no cache, **wrong 401/403 mapping**, no `server_id` | 60s cache | **`KeyServiceClient`**: `server_id`, 60s/10s cache, sha256 cache keys, dedupe, correct status mapping |
| Hosted auth | path, `?api_key=` | path, `?api_key=` | **path, `Authorization: Bearer usr_`, `X-API-Key: usr_`, `?api_key=`** (raw keys refused) |
| Errors | `Error:` text, **no `isError`** | n/a | `isError: true`, actionable text, no stack traces |
| Annotations | none | none | `READ_ONLY` / `DESTRUCTIVE` presets on every tool |
| Analytics | basic | unauthenticated | per-tool errors and durations, client apps, bounded maps |
| Tests | none | none | **about 81 `node:test` cases**: unit, HTTP, fake key service, catalogue rules |
| Docker/CI | root, port bound to all interfaces, no health gate | broken healthcheck | non-root, multi-stage, `127.0.0.1` bind, external `mcp-network`, build before recreate, health-gated deploy |

**Decision:** copy **mcp-zerobounce v2's infrastructure** wholesale: http-server, key-service client, security, analytics, `defineTool`, format helpers, tests, Docker, CI and nginx. Use **mcp-github v2's tool inventory and markdown style** as the baseline for tool content, including the "directory guidance" from `get_file_contents`. Then add Forgejo-specific tools on top.

Lessons carried over from zerobounce's commit history:
- Use zod schema *factories*, never shared instances, so no `$ref` appears in schemas (strict clients reject it). A test enforces this.
- Bind ports to `127.0.0.1` only, because published Docker ports bypass ufw.
- Turn nginx `access_log off`, because `usr_` keys appear in URLs.
- Never put credentials in `process.env`, because v1 leaked keys across users that way.
- A 403 from the key service means *our* server token is wrong, not that the user's key is invalid.
- Patch the Accept header in both `headers` and `rawHeaders`.
- Normalise case-insensitive `/MCP/` paths.

### 1.4 mcp-key-service contract (origin/main `fe5d4db`)

- `POST http://mcp-key-service:8090/internal/resolve` with header `Authorization: Bearer <server token>` and body `{ "key": "usr_…", "server_id": "forgejo" }`.
- Responses:

  | Status | Meaning |
  |---|---|
  | 200 | `{ valid: true, credentials: {…}, label, connector_id }` |
  | 401 | invalid, revoked or suspended key, or connector not allowed for this server |
  | 403 | bad server token, or `server_id` mismatch |
  | 400 | missing key |
  | 500 | decrypt failure |
- `INTERNAL_SERVER_TOKENS=server_id:hex,…` is parsed **at startup only**. Adding `forgejo` needs a key-service restart.
- A connector is `{ label, fields: [{ key, label, type: 'text'|'url'|'password', required, placeholder?, helpText? }], servers: [...], urlPath? }`. The portal renders the form from `/api/connectors`, so **no portal code change is needed**.
- **URL fields are only checked with `new URL()`.** `http://169.254.169.254`, `file:` and private IPs are all accepted. The key service never fetches URLs, so **SSRF protection must live in the Forgejo MCP** (§2.6).
- **Precedents:** `nextcloud` (`nextcloud_host`), `ghost-cms` (`ghost_url`) and `openwebui` (`url`) already take user-supplied instance URLs.
- The ZeroBounce connector commit (`cd54e9a`) is the checklist to copy: `connectors.ts`, `.env.sample` comment, README table and server-ID list, landing-page list, and the smoke test, which has rate-limit arithmetic that must be adjusted.

### 1.5 Corrections to the April plan

| April plan said | Actually |
|---|---|
| `KEY_SERVICE_URL=http://mcp-key-service:8090` | Must be the **full** `…/internal/resolve` URL; both reference servers POST to it as given. |
| `list_commits` → `GET /git/commits` | `GET /repos/{o}/{r}/commits`. `/git/commits/{sha}` gets a single commit. |
| "search_issues is repo-scoped only" | `GET /repos/issues/search` is global. |
| "No equivalent for `update_pull_request_branch`" | `POST /pulls/{index}/update?style=merge\|rebase` |
| "Remove `get_pull_request_status`" | `GET /commits/{ref}/status` gives the combined status. |
| "Review comments may not be supported" | `POST /pulls/{index}/reviews` takes inline `comments[]` (path, new_position, old_position). |
| Wiki and Projects "blocked" | The wiki works over REST, so it is included. Projects still has no API. |
| Copy `http-server.ts` from mcp-github "as-is" | mcp-github has the status-mapping bug, no `server_id`, no cache and no `isError`. Copy from **mcp-zerobounce v2** instead. |
| Pass `(forgejoUrl, forgejoToken)` into every tool | Better: a per-request `ToolContext.getClient()` closure, the zerobounce pattern. Tools never see raw credentials. |
| Docker network: join `mcp-network` | It must be declared **`external: true`**. Many older servers declare a project-scoped bridge with the same name, which isn't actually shared. |

---

## 2. Target architecture

### 2.1 Repository layout

```
mcp-forgejo/
├── src/
│   ├── index.ts              # createForgejoServer(), ALL_TOOLS, SERVER_INSTRUCTIONS, toolset/read-only filtering
│   ├── http-server.ts        # Express 5 Streamable HTTP (from zerobounce): auth modes, analytics, server card
│   ├── cli.ts                # stdio entry (bin: mcp-forgejo)
│   ├── config.ts             # env parsing shared by http + cli (toolsets, read-only, limits, SSRF policy)
│   ├── version.ts
│   ├── forgejo/
│   │   ├── client.ts         # ForgejoClient: request/paginate/getText, timeouts, retries, size caps, no redirects
│   │   ├── errors.ts         # ForgejoError kinds; 401/403-scope/404/409/422/429 → actionable text
│   │   ├── url.ts            # normalizeInstanceUrl(): scheme, trailing "/", strip "/api/v1", subpath installs
│   │   ├── ssrf.ts           # undici Agent with guarded DNS lookup (blocks private/loopback/link-local/metadata)
│   │   ├── capabilities.ts   # per-instance cache of /version + /settings/api; requireVersion('16.0')
│   │   ├── projections.ts    # compact shapes: repo, issue, PR, user, commit, run, release…
│   │   └── types.ts          # minimal hand-written subsets of swagger models
│   ├── tools/
│   │   ├── shared.ts         # defineTool, annotation presets, toolset ids, schema factories, result helpers
│   │   ├── meta.ts           # forgejo_hello
│   │   ├── users.ts  repos.ts  code.ts  issues.ts  labels.ts  pulls.ts  notifications.ts
│   │   ├── actions.ts  actions-admin.ts  releases.ts  wiki.ts  orgs.ts  repo-admin.ts  packages.ts  admin.ts
│   └── utils/
│       ├── key-service.ts    # from zerobounce: server_id 'forgejo', maps forgejo_url/forgejo_token (+aliases)
│       ├── security.ts  analytics.ts  format.ts
│       ├── diff.ts           # diff truncation / per-file filtering
│       └── workflows.ts      # parse .forgejo/workflows/*.yml (triggers, dispatch inputs)
├── tests/                    # node:test (helpers, core, client, ssrf, key-service, tools, http)
├── scripts/                  # smoke-test.mjs (live), generate-tools-md.ts (→ TOOLS.md)
├── deploy/                   # DEPLOYMENT.md, nginx-mcp.conf
├── .github/workflows/        # ci.yml (typecheck + tests on PRs), deploy-vps.yml (tests → deploy, health-gated)
├── Dockerfile  docker-compose.yml  .env.sample  .dockerignore  .npmignore
├── package.json  tsconfig.json  README.md  TOOLS.md  CHANGELOG.md  AGENTS.md  CLAUDE.md  LICENSE
└── docs/REBUILD-PLAN.md
```

Runtime dependencies are kept small: `@modelcontextprotocol/sdk`, `express`, `cors`, `zod`, `undici` (guarded dispatcher) and `yaml` (workflow parsing).

### 2.2 Request flow (hosted)

```
Claude.ai / Cursor / Claude Code
  │  POST https://mcp.techmavie.digital/forgejo/mcp/usr_…      (or Bearer usr_… / X-API-Key / ?api_key=)
  ▼
Nginx  location /forgejo/ → 127.0.0.1:$MCP_HOST_PORT (default 8099; access_log off, no CORS here)
  ▼
mcp-forgejo (Express 5)
  ├─ resolveHosted(usr_…) ──► KeyServiceClient ──► POST mcp-key-service:8090/internal/resolve
  │                              (60s cache by sha256(key), dedupe in-flight)   {key, server_id:"forgejo"}
  │                          ◄── { forgejo_url, forgejo_token }
  ├─ normalizeInstanceUrl() + SSRF policy check
  ├─ new McpServer + StreamableHTTPServerTransport (stateless, JSON responses) for THIS request only
  │     ToolContext { getClient() → ForgejoClient(baseUrl, token) via guarded undici Agent,
  │                   capabilities(), toolsets, readOnly, authMode }
  └─ tool handler → Forgejo REST /api/v1/… → projection → markdown | json → isError on failure
```

### 2.3 Auth modes

| Mode | How | Credentials source |
|---|---|---|
| **Hosted (key service)** | `POST /mcp/usr_…`, or `Authorization: Bearer usr_…`, `X-API-Key: usr_…`, or `?api_key=usr_…` (compatibility; the portal's `url_example` uses this form) | Key service resolves `forgejo_url` and `forgejo_token` |
| **Self-hosted HTTP** | `POST /mcp` with `X-API-Key: <MCP_API_KEY>` (constant-time compare) plus `X-Forgejo-Url` and `X-Forgejo-Token` | Headers, falling back to `FORGEJO_URL` and `FORGEJO_ACCESS_TOKEN` env |
| **CLI / stdio** | `npx mcp-forgejo` or `node dist/cli.js` | `FORGEJO_URL`, `FORGEJO_ACCESS_TOKEN` env |
| Diagnostics | `/mcp-debug/open` only when `ENABLE_MCP_DIAGNOSTICS=true` | none (ping tool only) |

Raw (non-`usr_`) keys in the query string are refused with `400 raw_key_not_supported`. `tools/list` and `forgejo_hello` work without credentials, which helps discovery and Smithery-style scanners. Other tools return a friendly "connect a Forgejo account" error.

### 2.4 Per-request isolation

This copies zerobounce exactly:

- A brand-new `McpServer` and transport per HTTP request.
- Credentials live only in a closure.
- `ctx.getClient()` builds the `ForgejoClient` lazily.
- Nothing is written to `process.env`, and there is no module-level mutable credential state.
- Cleanup runs on `res.finish` and `res.close`.

### 2.5 ForgejoClient

- **Base URL:** `normalizeInstanceUrl()`:
  - trims whitespace
  - requires `https:` (in hosted mode; `http:` is allowed in self-hosted and CLI)
  - rejects userinfo, query and fragment
  - strips trailing `/` and a trailing `/api/v1`
  - keeps sub-paths such as `https://example.com/git`
- **Request headers:** `Authorization: token …`, `Accept: application/json`, `User-Agent: mcp-forgejo/3.0.0`.
- **Timeouts:** 30s by default (`FORGEJO_TIMEOUT_MS`).
- **Response size:** the body is streamed with a cap (`FORGEJO_MAX_RESPONSE_MB`, 20 by default).
- **Redirects:** `redirect: 'manual'`, so a 3xx becomes an error ("your instance redirected to X; update the URL in your connection"). This stops the token being forwarded to another host.
- **Retries:** at most one, only for idempotent GETs, and only on 502, 503 or 504 or a network error.
  - **Never** retried: writes, 429 or timeouts.
  - On 429 the error reports `Retry-After` (Codeberg sends `ratelimit-policy` 2000 requests per 10 minutes).
- **Pagination:**
  - `paginate()` reads `X-Total-Count` and `Link`.
  - `limit` is capped to the instance's `max_response_items`, cached per instance.
  - The tool's default `limit` is 20.
  - Every list output ends with `Showing 21–40 of 97 · page 2/5 · next: page=3`.
- **Errors** (`ForgejoError`):

  | Status | Message to the model |
  |---|---|
  | 401 | Token rejected, expired or revoked. Create a new one at `{url}/user/settings/applications` and update the connection at mcpkeys.techmavie.digital. |
  | 403 | Parses `required scope(s): [x]`: "Your token lacks `x`. Regenerate it with that scope." |
  | 404 | Not found, *or* the token cannot see it (v15+ returns 404 for unauthorised private repos). |
  | 409 / 422 | Forgejo's message passed through, e.g. a merge conflict or a stale file SHA. |

  The token is scrubbed from every message, and stack traces never reach the model.
- **Lean list requests:** `GET /commits` sets `stat=false&verification=false&files=false` by default, because the API defaults are heavy.

### 2.6 SSRF guard (critical for multi-tenant hosting)

The hosted server fetches **whatever URL a user saved in the portal**. Without a guard, a user could point it at `http://169.254.169.254/`, `http://mcp-key-service:8090/` or `http://127.0.0.1:…` on the VPS.

1. **URL policy** (`url.ts`): `https:` only in hosted mode; no userinfo, query or fragment; port numbers are allowed.
2. **Connect-time DNS validation** (`ssrf.ts`): every outbound request goes through an `undici.Agent({ connect: { lookup: guardedLookup } })`.
   - The lookup resolves the hostname and **rejects** loopback, RFC1918, CGNAT, link-local and metadata (`169.254/16`), IPv6 ULA (`fc00::/7`) and link-local (`fe80::/10`), `::1`, IPv4-mapped IPv6 forms of those, multicast and `0.0.0.0/8`.
   - Checking at connect time defeats DNS rebinding (check-then-connect races).
3. **No redirects** (§2.5).
4. **Escape hatches**, for self-hosters only and off by default:
   - `FORGEJO_ALLOW_PRIVATE_HOSTS=true` for LAN instances.
   - `FORGEJO_TRUSTED_HOSTS=git.mynameisaliff.co.uk` to exempt named hosts. This is a fallback in case container-to-own-VPS hairpin NAT needs `extra_hosts: host-gateway`.
5. Tests cover each blocked range, IPv6-mapped bypasses, a rebinding stub and redirect refusal.

### 2.7 Instance capabilities and version gating

- `capabilities.ts` caches `GET /api/v1/version` and `GET /api/v1/settings/api` **per normalised instance URL** for 10 minutes. These are unauthenticated and cheap.
- It parses `14.0.3+gitea-1.22.0` into `{ major: 14, minor: 0, patch: 3 }`.
- Tools can declare `minVersion: '16.0'`. They are **always listed**, so `tools/list` is deterministic as the spec requires, and the description notes "Requires Forgejo 16+".
- Calling a gated tool on an older instance returns a friendly error: *"forgejo_get_job_logs needs Forgejo ≥ 16.0; git.example.com runs 14.0.3. Upgrade, or use forgejo_get_workflow_run for task statuses."*
- Graceful degradation where possible:
  - `forgejo_get_workflow_run` on v14/15 joins `GET /actions/tasks` by `run_number` to show per-job statuses.
  - `forgejo_list_pull_requests` with `base`/`head` filters client-side on versions before 16.

### 2.8 Tool definition pattern (from zerobounce)

```ts
export const getIssue = defineTool({
  name: 'forgejo_get_issue',
  title: 'Get issue',
  toolset: 'issues',
  description: 'Get one issue or pull request by number, with labels, assignees, milestone and (optionally) the latest comments…',
  inputSchema: { ...repoRef(), index: issueIndex(), include_comments: z.boolean().default(false)…, response_format: responseFormat() },
  annotations: READ_ONLY,            // READ_ONLY | WRITE | WRITE_IDEMPOTENT | DESTRUCTIVE
  minVersion: undefined,             // e.g. '16.0'
  async handler(args, ctx) { const c = ctx.getClient(); … return markdownResult(…) },
});
```

- **Naming:** `forgejo_<verb>_<noun>`, enforced by the test regex `/^forgejo_[a-z_]+$/`. The prefix avoids collisions with the GitHub MCP tools you already have connected.
- **Annotation presets:**

  | Preset | Used for |
  |---|---|
  | `READ_ONLY` | all reads |
  | `WRITE` | creates and comments |
  | `WRITE_IDEMPOTENT` | updates and set operations |
  | `DESTRUCTIVE` | deletes, merges, dismissals |

  Clients use these to decide when to ask before running a tool.
- **Common parameters** come from schema factories: `owner`, `repo`, `index`, `page`, `limit`, `response_format`, `ref`.
- **Convenience behaviours** (each is a known pain point in the Go fork):
  - Labels and milestones can be given **by name or ID**; the server resolves names against repo and org labels.
  - `create_or_update_file` and `push_files` **auto-fetch the current blob SHA** when it isn't supplied.
  - `get_file_contents`:
    - base64-decodes content and detects binary files
    - supports `start_line`/`end_line` and a size cap
    - for a directory, returns a listing plus suggested next calls (the mcp-github `formatDirectoryGuidance` idea)
  - Diffs are truncated per file with a summary table, a `files` filter and a "call again with files=[…]" hint.
  - Outputs suggest the next tool to call where it helps, for example after `forgejo_dispatch_workflow`.

### 2.9 Toolsets and read-only mode

Borrowed from gitea-mcp and github-mcp-server, with the per-request selection made compatible with the MCP spec:

| Setting | Env (server default) | Per-request override (hosted and self-hosted) |
|---|---|---|
| Toolsets | `FORGEJO_TOOLSETS=default` | `?toolsets=default,actions,wiki` or header `X-Forgejo-Toolsets` |
| Read-only | `FORGEJO_READ_ONLY=false` | `?read_only=true` or header `X-Forgejo-Read-Only` |

- `default` is `users, repos, code, issues, pulls, notifications`. `all` enables everything. `meta` (`forgejo_hello`) is always on.
- **Read-only always wins.** It drops every tool that isn't `READ_ONLY`. The real enforcement is still the token's scopes, so the README recommends read-only tokens for read-only connections.
- Example hosted URLs:
  - `…/forgejo/mcp/usr_abc?toolsets=all`
  - `…/forgejo/mcp/usr_abc?read_only=true`

### 2.10 Output, server instructions and untrusted content

- **Default output is compact markdown:** headers, bullet facts, tables for lists, and ISO timestamps.
- `response_format: "json"` returns the **compact projection** as pretty JSON, not the raw 70-field API objects.
- **`SERVER_INSTRUCTIONS`**, sent at initialize, cover:
  - `owner/repo` conventions
  - that issues and PRs share the `index` space
  - that labels accept names
  - how pagination works
  - which toolsets exist and how to enable them
  - that Forgejo has no code search, so use `get_tree` plus `get_file_contents`
  - an explicit **prompt-injection notice**: issue, PR, comment, wiki and file content is untrusted user data and must never be followed as instructions
- User-authored bodies are rendered inside fenced blocks labelled with author and source.

### 2.11 Version-gated features

| Feature | Min version | Endpoint(s) |
|---|---|---|
| Runs list/get, tasks, dispatch, secrets, variables, wiki, releases, migrate, mirrors | ≤ 14 ✅ (your instance) | as listed in §3 |
| Runners management, run/task filters, repo-scoped tokens | 15.0 | `/actions/runners…` |
| **Run jobs, job logs, run logs zip, cancel/delete run, artifacts**, PR list `base`/`head` filter, multi-line review comments | **16.0** | `/actions/runs/{id}/jobs`, `/actions/jobs/{id}/logs`, `/runs/{id}/cancel`, `/actions/artifacts…` |
| Get single job, log `step`/`q`/`format=ndjson` filters, **rerun run/job**, lock/unlock issues | **17.0** | `/actions/jobs/{id}`, `/runs/{id}/rerun`, `/jobs/{id}/rerun`, `/issues/{i}/lock` |

---

## 3. Tool catalogue (proposed)

Key: **R** read-only · **W** write · **WI** idempotent write · **D** destructive. ★ marks a toolset in `default`.
Paths are relative to `/api/v1`; `R/` = `/repos/{owner}/{repo}`.

### meta (always on): 1 tool
| Tool | Endpoint(s) | |
|---|---|---|
| `forgejo_hello` | `GET /version`, `/settings/api`, `/user` (graceful) | R |

It reports: MCP version, instance URL and version, auth mode, authenticated user (if `read:user` is available), enabled toolsets, read-only flag, and any version-gated tools that are unavailable.

### users ★: 2
| Tool | Endpoint(s) | |
|---|---|---|
| `forgejo_get_user` | `GET /user` (no username) · `GET /users/{u}` | R |
| `forgejo_search_users` | `GET /users/search` | R |

### repos ★: 7
| Tool | Endpoint(s) | |
|---|---|---|
| `forgejo_list_repos` | `GET /user/repos` · `/orgs/{o}/repos` · `/users/{u}/repos` (by `owner`) | R |
| `forgejo_search_repos` | `GET /repos/search` (q, topic, mode, archived, private, sort) | R |
| `forgejo_get_repo` | `GET R` (+ `R/languages`, topics) | R |
| `forgejo_create_repo` | `POST /user/repos` · `POST /orgs/{org}/repos` (auto_init, gitignores, license, readme, template via `POST /repos/{t_owner}/{t_repo}/generate`) | W |
| `forgejo_fork_repo` | `POST R/forks` | W |
| `forgejo_update_repo` | `PATCH R` (+ `PUT R/topics`) | WI |
| `forgejo_migrate_repo` | `POST /repos/migrate`: import or **mirror from GitHub, GitLab, Gitea, or plain git**, with issues, PRs, releases and wiki | W |

### code ★: 14
| Tool | Endpoint(s) | |
|---|---|---|
| `forgejo_get_file_contents` | `GET R/contents/{path}?ref=` (file, or directory listing with guidance) · `GET R/raw/{path}` | R |
| `forgejo_get_tree` | `GET R/git/trees/{sha}?recursive=true` (path-prefix filter, truncation flag) | R |
| `forgejo_create_or_update_file` | `POST`/`PUT R/contents/{path}` (auto SHA, `new_branch`) | W |
| `forgejo_delete_file` | `DELETE R/contents/{path}` | D |
| `forgejo_push_files` | `POST R/contents` (multi-file create, update, delete, rename in one commit) | W |
| `forgejo_list_branches` | `GET R/branches` | R |
| `forgejo_create_branch` | `POST R/branches` (from branch, tag or commit) | W |
| `forgejo_delete_branch` | `DELETE R/branches/{b}` | D |
| `forgejo_list_commits` | `GET R/commits` (sha, path, `not`; lean flags) | R |
| `forgejo_get_commit` | `GET R/git/commits/{sha}` (+ `.diff`, truncated) | R |
| `forgejo_compare_refs` | `GET R/compare/{base}...{head}` | R |
| `forgejo_get_commit_status` | `GET R/commits/{ref}/status` + `/statuses` | R |
| `forgejo_list_tags` | `GET R/tags` | R |
| `forgejo_create_tag` | `POST R/tags` | W |

### issues ★: 12
| Tool | Endpoint(s) | |
|---|---|---|
| `forgejo_list_issues` | `GET R/issues` (state, labels, milestones, type, q, since, created_by, assigned_by, mentioned_by) | R |
| `forgejo_search_issues` | `GET /repos/issues/search` (**global**: assigned, created, mentioned, review_requested, owner, team, type) | R |
| `forgejo_get_issue` | `GET R/issues/{i}` (+ latest comments, optional) | R |
| `forgejo_create_issue` | `POST R/issues` (labels and milestone **by name or ID**, assignees, due date, ref) | W |
| `forgejo_update_issue` | `PATCH R/issues/{i}` (title, body, state, assignees, milestone, due date) | WI |
| `forgejo_update_issue_labels` | `POST`/`PUT`/`DELETE R/issues/{i}/labels` (add, remove, replace, clear; names or IDs) | WI |
| `forgejo_list_issue_comments` | `GET R/issues/{i}/comments` | R |
| `forgejo_add_issue_comment` | `POST R/issues/{i}/comments` (also works for PRs) | W |
| `forgejo_edit_issue_comment` | `PATCH R/issues/comments/{id}` | WI |
| `forgejo_delete_issue_comment` | `DELETE R/issues/comments/{id}` | D |
| `forgejo_list_labels` | `GET R/labels` (+ `GET /orgs/{o}/labels`) | R |
| `forgejo_list_milestones` | `GET R/milestones` | R |

### pulls ★: 16
| Tool | Endpoint(s) | |
|---|---|---|
| `forgejo_list_pull_requests` | `GET R/pulls` (state, sort, labels, milestone, poster; base/head on 16+, client-side before) | R |
| `forgejo_get_pull_request` | `GET R/pulls/{i}` + head combined status + review summary | R |
| `forgejo_create_pull_request` | `POST R/pulls` (labels by name, assignees, reviewers; draft = `WIP:` title prefix) | W |
| `forgejo_update_pull_request` | `PATCH R/pulls/{i}` | WI |
| `forgejo_get_pull_request_diff` | `GET R/pulls/{i}.diff\|.patch` (file filter, truncation) | R |
| `forgejo_list_pull_request_files` | `GET R/pulls/{i}/files` | R |
| `forgejo_list_pull_request_commits` | `GET R/pulls/{i}/commits` | R |
| `forgejo_merge_pull_request` | `POST R/pulls/{i}/merge` (merge, rebase, rebase-merge, squash, fast-forward-only; delete branch; `merge_when_checks_succeed`; `head_commit_id` guard) · `DELETE …/merge` cancels auto-merge | D |
| `forgejo_update_pull_request_branch` | `POST R/pulls/{i}/update?style=merge\|rebase` | W |
| `forgejo_list_pull_reviews` | `GET R/pulls/{i}/reviews` | R |
| `forgejo_get_pull_review` | `GET R/pulls/{i}/reviews/{id}` + `/comments` | R |
| `forgejo_create_pull_review` | `POST R/pulls/{i}/reviews` (APPROVED, REQUEST_CHANGES, COMMENT, PENDING, plus inline comments) | W |
| `forgejo_submit_pull_review` | `POST R/pulls/{i}/reviews/{id}` | W |
| `forgejo_dismiss_pull_review` | `POST …/reviews/{id}/dismissals` · `/undismissals` | D |
| `forgejo_delete_pull_review` | `DELETE R/pulls/{i}/reviews/{id}` | D |
| `forgejo_request_pull_reviewers` | `POST`/`DELETE R/pulls/{i}/requested_reviewers` (users and teams) | WI |

### notifications ★: 3
| Tool | Endpoint(s) | |
|---|---|---|
| `forgejo_list_notifications` | `GET /notifications` · `GET R/notifications` (status, subject type, since; + `/notifications/new` count) | R |
| `forgejo_get_notification_thread` | `GET /notifications/threads/{id}` | R |
| `forgejo_mark_notifications_read` | `PATCH /notifications/threads/{id}` · `PUT /notifications` · `PUT R/notifications` (to read, unread or pinned) | WI |

**Default total: 1 + 2 + 7 + 14 + 12 + 16 + 3 = 55 tools.** In read-only mode that is about 30.

### actions (opt-in): 8
| Tool | Endpoint(s) | Min | |
|---|---|---|---|
| `forgejo_list_workflows` | synthesised: `GET R/contents/.forgejo/workflows` (+ `.github/workflows`), parsed for triggers and `workflow_dispatch` inputs | 14 | R |
| `forgejo_dispatch_workflow` | `POST R/actions/workflows/{file}/dispatches` (`return_run_info`) | 14 | W |
| `forgejo_list_workflow_runs` | `GET R/actions/runs` (event, status, head_sha, run_number) | 14 | R |
| `forgejo_get_workflow_run` | `GET R/actions/runs/{id}` (+ jobs on 16+, or tasks joined by run_number before 16) | 14 | R |
| `forgejo_get_job_logs` | `GET R/actions/jobs/{id}/logs` (tail N lines; `step` and `q` on 17+) | **16** | R |
| `forgejo_cancel_workflow_run` | `POST R/actions/runs/{id}/cancel` | **16** | D |
| `forgejo_list_run_artifacts` | `GET R/actions/runs/{id}/artifacts` | **16** | R |
| `forgejo_rerun_workflow` | `POST R/actions/runs/{id}/rerun` · `/jobs/{id}/rerun` | **17** | W |

### actions_admin (opt-in): 6
`forgejo_list_action_variables`, `forgejo_set_action_variable`, `forgejo_delete_action_variable`, `forgejo_list_action_secrets` (names only), `forgejo_set_action_secret`, `forgejo_delete_action_secret`. Each takes `scope: repo|org|user`.

### releases (opt-in): 6
`forgejo_list_releases`, `forgejo_get_release` (by id, tag or `latest`), `forgejo_create_release`, `forgejo_update_release`, `forgejo_delete_release` (D), `forgejo_delete_tag` (D).

### wiki (opt-in): 6
`forgejo_list_wiki_pages`, `forgejo_get_wiki_page`, `forgejo_get_wiki_page_revisions`, `forgejo_create_wiki_page`, `forgejo_update_wiki_page`, `forgejo_delete_wiki_page` (D). Content is base64-encoded and decoded transparently.

### labels (opt-in, label and milestone management): 6
`forgejo_create_label`, `forgejo_update_label`, `forgejo_delete_label` (D), `forgejo_create_milestone`, `forgejo_update_milestone` (incl. open/close), `forgejo_delete_milestone` (D).

### orgs (opt-in): 11
`forgejo_list_orgs`, `forgejo_get_org`, `forgejo_create_org`, `forgejo_update_org`, `forgejo_delete_org` (D), `forgejo_list_org_members`, `forgejo_remove_org_member` (D), `forgejo_list_teams`, `forgejo_create_team`, `forgejo_update_team_members` (add/remove), `forgejo_update_team_repos` (add/remove).

### repo_admin (opt-in): 14
`forgejo_delete_repo` (D), `forgejo_list_collaborators`, `forgejo_set_collaborator`, `forgejo_remove_collaborator` (D), `forgejo_list_branch_protections`, `forgejo_set_branch_protection`, `forgejo_delete_branch_protection` (D), `forgejo_list_webhooks`, `forgejo_create_webhook`, `forgejo_delete_webhook` (D), `forgejo_list_push_mirrors`, `forgejo_create_push_mirror` (e.g. Forgejo → GitHub), `forgejo_delete_push_mirror` (D), `forgejo_sync_mirror` (pull-mirror sync plus push-mirror sync).

### packages (opt-in): 3
`forgejo_list_packages`, `forgejo_get_package` (+ files), `forgejo_delete_package_version` (D).

### admin (opt-in, site admins only): 3
`forgejo_admin_list_users`, `forgejo_admin_list_cron_tasks`, `forgejo_admin_run_cron_task`.

**Grand total: about 118 tools** (55 default plus 63 opt-in).

**Deliberately excluded:**
- code search (no API)
- Projects/Kanban (no API)
- ActivityPub
- GPG and SSH key management, OAuth2 apps, avatars, quota, issue reactions, stopwatches, time tracking, repo transfer, admin user creation and deletion

These are low value for an AI assistant, or too sensitive. They are easy to add later with the same pattern.

---

## 4. Key-service integration (`mcp-key-service` repo)

Done as a **separate branch and PR** in that repo. The local checkout is one commit behind origin and would be fast-forwarded first.

1. **`src/connectors.ts`**: add the connector.
   ```ts
   forgejo: {
     label: 'Forgejo (self-hosted or Codeberg)',
     fields: [
       { key: 'forgejo_url', label: 'Forgejo Instance URL', type: 'url', required: true,
         placeholder: 'https://git.example.com',
         helpText: 'Base URL of your Forgejo instance, e.g. https://codeberg.org. Must be reachable over HTTPS from the internet.' },
       { key: 'forgejo_token', label: 'Access Token', type: 'password', required: true,
         helpText: 'Forgejo → Settings → Applications → Generate New Token. Grant read/write for repository, issue, notification and user (add organization/package/admin only if needed). Use read-only scopes for a read-only connection.' },
     ],
     servers: ['forgejo'],
   },
   ```
   The MCP side also accepts the aliases `url`/`baseUrl` and `token`/`accessToken`, so it is robust to future renames.
2. **`.env.sample`**: add `forgejo` to the "Supported server IDs" comment.
3. **`README.md`**: add a Supported Connectors table row and the server-ID list entry.
4. **`portal/src/app/page.tsx`**: add "Forgejo" to the landing-page service list.
5. **`scripts/smoke-test.mjs`**:
   - add a `forgejoToken`
   - register and resolve with `server_id:'forgejo'`, asserting both credential fields come back
   - add a cross-server **401** check
   - **re-balance the rate-limit arithmetic**: 5 registrations per hour per IP are already nearly used. Adjust the loop, `listBeforeRevoke`/`listAfterRevoke` totals and `stats.totalKeys`.
6. **Optional hardening (D6):**
   - in `validateCredentials`, require `http:` or `https:` for `type: 'url'` fields, and trim string values
   - this helps the nextcloud, ghost-cms and openwebui connectors too
   - add a smoke assertion (which also uses one limiter slot)
7. **Deploy order** (matters, because merging to main auto-deploys):
   1. **You:** add `forgejo:<openssl rand -hex 32>` to `INTERNAL_SERVER_TOKENS` in `/opt/mcp-key-service/.env`.
   2. Merge the PR. The workflow rebuilds and restarts the key service.
   3. Check that "Forgejo" appears on mcpkeys.techmavie.digital.

---

## 5. Deployment (mcp-forgejo)

| Item | Value |
|---|---|
| Public URL | `https://mcp.techmavie.digital/forgejo/mcp/usr_…` (+ `/forgejo/health`, `/forgejo/analytics/dashboard`, `/forgejo/.well-known/mcp/server-card.json`) |
| Container / service | `mcp-forgejo` |
| Host port | **`127.0.0.1:${MCP_HOST_PORT:-8099}:8080`**, set in the VPS `.env`. 8098 turned out to be taken by the Singapore Open Data MCP (deployed the same day), so the port is configurable instead of hard-coded. |
| Network | `mcp-network` with **`external: true`** (reaches `mcp-key-service:8090`) |
| Volume | `analytics-data:/app/data` |
| VPS dir | `/opt/mcp-servers/forgejo` (`.env` created by hand, never committed) |
| Nginx | `location /forgejo/ { proxy_pass http://127.0.0.1:<MCP_HOST_PORT>/; proxy_buffering off; proxy_request_buffering off; proxy_read_timeout 300s; client_max_body_size 12M; access_log off; }`. No CORS here. |
| Dockerfile | multi-stage `node:24-alpine`, `npm ci --ignore-scripts`, non-root `mcp` user, `HEALTHCHECK wget 127.0.0.1:8080/health` |
| CI | `ci.yml` runs typecheck and tests on PRs. `deploy-vps.yml` runs on push to `main`: tests, then SSH (`appleboy/ssh-action`, secrets `VPS_HOST`/`VPS_USERNAME`/`VPS_SSH_KEY`/`VPS_PORT`), `git reset --hard origin/main`, require `.env`, ensure `mcp-network`, build before `up -d`, poll `/health` 20×3s, dump logs on failure. |

**Environment variables:**

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `MCP_API_KEY` | unset | Required for self-hosted `/mcp` and analytics |
| `KEY_SERVICE_URL` | unset | `http://mcp-key-service:8090/internal/resolve` (full path) |
| `KEY_SERVICE_TOKEN` | unset | Must match `forgejo:<hex>` in the key service |
| `KEY_SERVICE_SERVER_ID` | `forgejo` | |
| `KEY_PORTAL_URL` | `https://mcpkeys.techmavie.digital` | Shown in "get a key" hints |
| `PUBLIC_BASE_PATH` | `/forgejo` | Advertised URLs only (nginx strips the prefix) |
| `ALLOWED_ORIGINS` | `*` | |
| `ANALYTICS_DIR` | `/app/data` | |
| `FORGEJO_URL` / `FORGEJO_ACCESS_TOKEN` | unset | CLI, and the self-hosted fallback |
| `FORGEJO_TOOLSETS` | `default` | e.g. `default,actions,wiki` or `all` |
| `FORGEJO_READ_ONLY` | `false` | |
| `FORGEJO_ALLOW_PRIVATE_HOSTS` | `false` | Self-host or LAN only; never on the public hosted server |
| `FORGEJO_TRUSTED_HOSTS` | unset | Named hosts exempt from the private-IP check (hairpin fallback) |
| `FORGEJO_TIMEOUT_MS` / `FORGEJO_MAX_RESPONSE_MB` | `30000` / `20` | |
| `MCP_PROTOCOL_VERSION`, `ENABLE_MCP_DIAGNOSTICS`, `MCP_TRACE_HTTP`, `MCP_BODY_LIMIT` | as in zerobounce | |

---

## 6. Testing strategy

All tests use **`node:test`** (`node --import tsx --test tests/*.test.ts`), the same harness as zerobounce.

| Suite | What it proves |
|---|---|
| `core.test.ts` | URL normalisation (sub-paths, `/api/v1` stripping, scheme rules), version parsing, pagination header parsing, projections, diff truncation, workflow YAML parsing, security helpers |
| `ssrf.test.ts` | Each blocked IPv4 and IPv6 range, IPv4-mapped IPv6 bypasses, rebinding (lookup returns public then private), trusted-host and allow-private escape hatches, redirect refusal |
| `client.test.ts` | `token` auth header, retry only on idempotent GET and 5xx, never on 429 or writes, scope-error parsing, 404 wording, size cap, token never appears in errors |
| `key-service.test.ts` | Ported from zerobounce: 401/403/404/5xx/HTML/network mapping, cache, dedupe, negative cache, `forgejo_url` and `forgejo_token` alias mapping |
| `tools.test.ts` | **Catalogue rules:** prefix regex; title; description ≥ 40 chars; all four annotation hints present; writes never `readOnlyHint`; an exact list of `DESTRUCTIVE` tools; **no `$ref`** in any schema; toolset membership; read-only filtering; version-gate messages. **Behaviour** against a fake Forgejo for labels by name, SHA auto-resolve, pagination footer, directory guidance and v14 fallbacks. |
| `http.test.ts` | Spawns the real server with a fake key service and a fake Forgejo (both `http.createServer`): every auth path, 405s, the Accept shim, toolset/read-only query params, `/MCP/` casing, no `usr_` in analytics, OAuth 404s, server card |
| `scripts/smoke-test.mjs` | **Live** against `git.mynameisaliff.co.uk` over stdio (`dist/cli.js`), using `FORGEJO_URL` and `FORGEJO_ACCESS_TOKEN` from a local, git-ignored `.env`. Read-only by default. `SMOKE_WRITE=1` runs this lifecycle on a throw-away repo `mcp-smoke-<timestamp>`: create file, branch, PR, review, merge, issue with labels by name, wiki page, then delete the repo. |

---

## 7. Execution plan

Work happens on branch **`feat/typescript-rewrite`** in this repo, with one logical commit per phase (conventional commits). Main stays deployable until the final merge, which needs your go-ahead because merging triggers the deploy.

| Phase | Deliverables | Done when |
|---|---|---|
| **0. Prep** | Tag the current main as **`go-legacy-v2.17.0`** and push the tag. Create the branch. | Tag visible on GitHub |
| **1. Scaffold** | Remove the Go code and upstream tooling (`cmd/ operation/ pkg/ test/ main.go go.* Makefile .goreleaser.yml Containerfile .containerignore .devcontainer/ .forgejo/ .husky/ .releaserc .renovaterc .social-media/ demos/ openspec/ .beads/ codemcp.toml config.json`, upstream `.claude/` OpenSpec commands and skills, old CHANGELOG). Port zerobounce's infrastructure: package.json (v3.0.0, `bin: mcp-forgejo`), tsconfig, version, config, http-server (Forgejo headers, toolset params), cli, utils (key-service with `server_id: forgejo`, security, analytics, format), Dockerfile, compose, nginx, CI and deploy workflows, `.env.sample`, `.dockerignore`/`.npmignore`, a rewritten `.mcp.json` (local dev). | `npm run build` passes; infrastructure tests pass; `forgejo_hello` works over HTTP and stdio |
| **2. Forgejo core** | `forgejo/*`: client, errors, url, **ssrf**, capabilities, projections, types | core, ssrf and client suites green |
| **3. Default toolsets** | users, repos, code, issues, pulls, notifications (55 tools) + `SERVER_INSTRUCTIONS` | catalogue and behaviour tests green; live **read-only** smoke passes against your instance |
| **4. Opt-in toolsets** | actions (with version gating), actions_admin, releases, wiki, labels, orgs, repo_admin, packages, admin | tests green; live write smoke (`SMOKE_WRITE=1`) passes |
| **5. Docs** | README (hosted URL, auth modes, toolsets, token-scope guide, Codeberg example, attribution to goern/forgejo-mcp), auto-generated `TOOLS.md`, `deploy/DEPLOYMENT.md`, rewritten `AGENTS.md` (TypeScript, without the beads "landing the plane"), `CHANGELOG.md` 3.0.0, LICENSE (MIT; keep the upstream notice and add yours) | Docs reviewed |
| **6. Key-service PR** | §4 changes in `mcp-key-service` (branch `feat/forgejo-connector`) | Its smoke test passes locally |
| **7. Ship** | Push the branch and open PRs on both repos. After your VPS steps (§8), merge the key-service PR, then the mcp-forgejo PR. Verify `/forgejo/health`, the server card, a hosted `usr_` connection from Claude.ai, and the analytics dashboard. | End-to-end call from Claude.ai works with a portal-issued `usr_` key |

Rough effort is 4–6 working sessions. Phases 3 and 4 are the bulk.

---

## 8. What you need to do (only you can)

1. **Review and approve** this plan and the decisions in §9.
2. **Create a Forgejo access token** for testing on `git.mynameisaliff.co.uk` (all scopes, or at least repository, issue, notification, user and organization at read/write). Put it in a local `.env` in this repo as `FORGEJO_URL=…` and `FORGEJO_ACCESS_TOKEN=…`. The file is git-ignored, and I will never print the token.
3. **VPS steps** before the final merge:
   1. Pick a free port (`ss -tlnp`) and set it as `MCP_HOST_PORT` in the server `.env`.
   2. Add `forgejo:<hex>` to `/opt/mcp-key-service/.env`.
   3. Create `/opt/mcp-servers/forgejo/.env` with `MCP_API_KEY`, `KEY_SERVICE_URL`, and `KEY_SERVICE_TOKEN` (the same hex).
   4. Include the nginx location block and reload nginx.
4. **GitHub repo secrets** on `hithereiamaliff/mcp-forgejo`: `VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`, `VPS_PORT`.
5. **Recommended:** upgrade the Forgejo instance from 14.0.3 (D5). Take a backup first.

---

## 9. Decisions for you (with my recommendation)

| # | Decision | Recommendation | Alternative |
|---|---|---|---|
| **D1** | MCP SDK line | **`@modelcontextprotocol/sdk` 1.32.x + zod 3**, identical to zerobounce, so the tested infrastructure ports 1:1 and every server in your fleet stays on one line. SDK use is confined to `index.ts`, `http-server.ts` and `cli.ts`. | SDK **v2** (`@modelcontextprotocol/server` 2.3.x + zod 4, spec 2026-07-28 stateless). It is more future-proof, but the infrastructure would be rewritten rather than ported, and client support for the new spec is still settling. The v1 line gets fixes for about 6 months after 27 Jul 2026, so plan a **fleet-wide v2 migration** around Q1 2027 either way. |
| **D2** | Tool shape | **Granular `forgejo_*` tools plus toolsets plus read-only.** Precise schemas, and correct per-tool annotations so clients prompt before destructive calls. | Consolidated gitea-mcp style (`issue_read` / `issue_write` with a `method` parameter): about 40 tools, but one tool mixes safe and destructive actions, so annotations can't be accurate. |
| **D3** | Default toolsets | **users, repos, code, issues, pulls, notifications (55 tools)**; everything else opt-in via `?toolsets=`. | Also turn `actions` on by default (63 tools). Most useful once your instance is on 16+. |
| **D4** | Repo strategy | **Rewrite in place** on `feat/typescript-rewrite`, tag `go-legacy-v2.17.0`, keep the repo name, credit upstream in the README. | A new repo (e.g. `mcp-forgejo-ts`) and archive this fork. |
| **D5** | Forgejo instance upgrade (outside MCP scope) | **Upgrade to 15.0.x LTS now** for the security fixes (supported to Jul 2027). The MCP version-gates the 16+/17+ Actions tools either way. | 17.0 (out 15 Oct) for job logs, cancel and rerun, at the cost of upgrading every quarter. |
| **D6** | Key-service URL hardening | **Yes**: http(s)-only and trimmed values for `url` fields, in the same PR. Small, and it benefits three existing connectors. | Connector only. |
| **D7** | Port / path | **`/forgejo/`; port from `MCP_HOST_PORT` (8098 was taken)** | another free port |

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| SSRF via user-supplied instance URLs | §2.6: connect-time DNS guard, https only, no redirects, tests per range |
| Container can't reach `git.mynameisaliff.co.uk` on the same VPS (hairpin NAT) | Test early in Phase 7. Fallback: `extra_hosts` plus `FORGEJO_TRUSTED_HOSTS`. |
| Token leakage | Closure-only credentials, scrubbing in errors and logs, nginx `access_log off`, `Bearer usr_` header option, analytics never stores keys or raw paths |
| Prompt injection via issue, PR or wiki content | Server instructions, fenced untrusted content, destructive annotations, read-only mode |
| Token-scope surprises (403s) | Parsed scope errors with a fix hint; `forgejo_hello` reports what works |
| Large responses blowing context | Compact projections, default `limit` 20, diff and file truncation with follow-up hints |
| Instance-version differences (14 vs 17) | Capability cache, `minVersion` gates, graceful fallbacks |
| Tool-count overload in clients | Toolsets, read-only mode, 55-tool default |
| Codeberg or other instances rate-limiting | Honour 429 and `Retry-After`; never auto-retry 429 |
| SDK v1 maintenance window | D1: isolated SDK touchpoints; fleet-wide v2 migration planned separately |

---

## 11. Later (not in v3.0.0)

- MCP **resources** (`forgejo://{owner}/{repo}/…` file and issue templates) and **prompts** (e.g. "review this PR").
- `outputSchema` / `structuredContent` for the most-used read tools.
- Optional OAuth / Forgejo 16 "Authorized Integrations" (JWT) as an alternative to static PATs.
- Time tracking, issue dependencies, reactions, stopwatches.
- A fleet-wide MCP SDK v2 migration (all TechMavie servers together).

## References

- **Templates:** `mcp-zerobounce` (v2 infrastructure), `mcp-github` origin/main (v2 tool content), `mcp-key-service` origin/main `fe5d4db`
- **Forgejo:**
  - live instance: `https://git.mynameisaliff.co.uk/swagger.v1.json` and `/api/v1/version`
  - release schedule: `https://forgejo.org/docs/latest/admin/release-schedule/`
  - API docs: `https://forgejo.org/docs/latest/user/api/usage`
  - token scopes: `https://forgejo.org/docs/latest/user/authentication/token-scope`
- **Other MCP servers:**
  - upstream Go: `git.b4mad.industries/agentic-forges/forgejo-mcp` (v3.2.0)
  - `gitea.com/gitea/gitea-mcp` (v1.8.0, toolsets and read-only)
  - `github/github-mcp-server` (toolsets and lockdown)
- **MCP:**
  - spec 2026-07-28: `https://modelcontextprotocol.io/specification/latest`
  - TypeScript SDK: `@modelcontextprotocol/sdk` 1.32.1 (legacy line) and `@modelcontextprotocol/server` 2.3.1 (v2)
