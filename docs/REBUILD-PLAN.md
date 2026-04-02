# Forgejo MCP — Architecture Rebuild Plan

> **Goal:** Replace the current Go-based codebase (forked from `codeberg.org/goern/forgejo-mcp`) with a TypeScript rewrite that replicates the architecture of `hithereiamaliff/mcp-github`, adapted for the Forgejo REST API, fully integrated with `hithereiamaliff/mcp-key-service`.

## Background

### Current State

This repo is a fork of [goern/forgejo-mcp](https://codeberg.org/goern/forgejo-mcp), a Go-based MCP server for Forgejo/Codeberg. It works, but its architecture is completely different from the rest of the TechMavie MCP infrastructure:

| Aspect | Current `mcp-forgejo` (Go) | Target architecture (`mcp-github` TypeScript) |
|--------|---------------------------|------------------------------------------------|
| Language | Go | TypeScript |
| Runtime | Compiled binary | Node.js |
| Auth model | Token via env var only | Key-service (`usr_` keys) + header-based + CLI |
| Deployment | Standalone binary or container | Docker on VPS behind Nginx reverse proxy |
| Infrastructure | No integration with TechMavie stack | Shared Nginx, analytics, key-service |
| Transport | stdio / SSE / streamable HTTP (standalone) | Streamable HTTP (Express-based) + stdio CLI |
| Analytics | None | Built-in analytics endpoints |
| Dependencies | Go modules, forked Forgejo SDK | `@modelcontextprotocol/sdk`, `express`, `zod` |

### Why Rebuild

1. **Stack consistency** — Every other TechMavie MCP server runs TypeScript/Node.js behind Nginx on the same VPS. A Go binary is the odd one out.
2. **Shared auth infrastructure** — The key-service pattern (`usr_` user keys) is already built and running. The Go server can't use it without significant modification.
3. **Deployment simplicity** — One `docker-compose.yml` pattern, one `Dockerfile` pattern, one Nginx config pattern across all MCP servers.
4. **Maintenance** — Aliff maintains TypeScript MCP servers daily. The Go codebase is unfamiliar territory.
5. **Analytics** — The `mcp-github` server has built-in analytics endpoints. The rebuild inherits this for free.

---

## Architecture Overview

### Source: `mcp-github` Structure

```
mcp-github/
├── src/
│   ├── index.ts              # MCP server definition, tool registration
│   ├── http-server.ts         # Express HTTP server, auth middleware, analytics
│   ├── cli.ts                 # CLI/stdio entry point
│   └── tools/
│       ├── repositories.ts    # Repo, branch, file, commit, tag tools
│       ├── issues.ts          # Issue and comment tools
│       ├── pullrequests.ts    # PR tools
│       └── search.ts          # Search tools
├── deploy/
│   ├── DEPLOYMENT.md
│   └── nginx-mcp.conf
├── docker-compose.yml
├── Dockerfile
├── .env.sample
├── package.json
└── tsconfig.json
```

### Target: `mcp-forgejo` Structure (after rebuild)

```
mcp-forgejo/
├── src/
│   ├── index.ts              # MCP server definition, tool registration
│   ├── http-server.ts         # Express HTTP server, auth middleware, analytics
│   ├── cli.ts                 # CLI/stdio entry point
│   └── tools/
│       ├── repositories.ts    # Repo, branch, file, commit tools
│       ├── issues.ts          # Issue, label, milestone, comment tools
│       ├── pullrequests.ts    # PR and review tools
│       ├── search.ts          # Search tools
│       ├── notifications.ts   # Notification tools (Forgejo-specific)
│       └── user.ts            # User info tools
├── deploy/
│   ├── DEPLOYMENT.md
│   └── nginx-mcp.conf
├── docs/
│   └── REBUILD-PLAN.md        # This file
├── docker-compose.yml
├── Dockerfile
├── .env.sample
├── package.json
└── tsconfig.json
```

---

## Key-Service Integration

### Overview

The rebuild must integrate with `hithereiamaliff/mcp-key-service`, the shared API key management service that powers all TechMavie MCP servers. This is not optional — it's the core auth infrastructure.

**Key-service repo:** [hithereiamaliff/mcp-key-service](https://github.com/hithereiamaliff/mcp-key-service)
**Live portal:** [mcpkeys.techmavie.digital](https://mcpkeys.techmavie.digital)

### How It Works

```
User (Claude.ai, Cursor, etc.)
  │
  │  Connects with usr_ key in URL
  ▼
mcp-forgejo (mcp.techmavie.digital/forgejo/mcp/usr_...)
  │
  │  POST /internal/resolve  (Bearer: forgejo-server-token)
  ▼
MCP Key Service → decrypts credentials → returns Forgejo token + instance URL
  │
  ▼
mcp-forgejo uses returned credentials to call Forgejo API
```

1. User creates a connection on [mcpkeys.techmavie.digital](https://mcpkeys.techmavie.digital), selects "Forgejo" connector, enters their Forgejo instance URL and access token.
2. Key-service encrypts and stores the credentials, returns a `usr_...` key.
3. User configures their MCP client: `https://mcp.techmavie.digital/forgejo/mcp/usr_...`
4. When a request arrives, `mcp-forgejo` extracts the `usr_` key from the URL path, calls `/internal/resolve` on the key-service.
5. Key-service decrypts and returns the Forgejo instance URL and access token.
6. `mcp-forgejo` uses those credentials for the Forgejo API call, scoped to that user's instance.

### Changes Required in `mcp-key-service`

#### 1. New Connector Definition

Add a `forgejo` connector to `src/connectors.ts`:

```typescript
forgejo: {
  label: 'Forgejo',
  fields: [
    {
      key: 'forgejo_url',
      label: 'Forgejo Instance URL',
      type: 'url',
      required: true,
      placeholder: 'https://git.example.com',
      helpText: 'The base URL of your Forgejo instance',
    },
    {
      key: 'forgejo_token',
      label: 'Access Token',
      type: 'password',
      required: true,
      helpText: 'Generate at Forgejo → Settings → Applications → Access Tokens',
    },
  ],
  servers: ['forgejo'],
},
```

#### 2. New Server Token

Add a `forgejo` entry to `INTERNAL_SERVER_TOKENS` in the VPS `.env` file:

```
INTERNAL_SERVER_TOKENS=nextcloud:token1,...,github:tokenN,forgejo:NEW_TOKEN_HERE
```

Generate with: `openssl rand -hex 32`

#### 3. Key-Service Credential Flow

When `mcp-forgejo` calls `/internal/resolve` with a `usr_` key, the key-service returns:

```json
{
  "valid": true,
  "credentials": {
    "forgejo_url": "https://git.example.com",
    "forgejo_token": "abc123..."
  },
  "label": "My Forgejo",
  "connector_id": "forgejo"
}
```

The MCP server then uses:
- `credentials.forgejo_url` as the base URL for all API calls (replacing any hardcoded instance URL)
- `credentials.forgejo_token` in the `Authorization: token {forgejo_token}` header

### Multi-Instance Support

Unlike the GitHub MCP (which always calls `api.github.com`), Forgejo is self-hosted — every user may have a **different instance URL**. This is a key architectural difference:

| Aspect | `mcp-github` | `mcp-forgejo` |
|--------|-------------|---------------|
| API base URL | Always `https://api.github.com` | Varies per user (from key-service credentials) |
| Token scope | GitHub PAT, same platform | Forgejo token, instance-specific |
| Instance discovery | Not needed | URL comes from key-service `forgejo_url` credential |

**Implementation note:** In `mcp-github`, the base URL is a constant. In `mcp-forgejo`, the base URL must be **dynamically resolved per request** from the key-service credentials. This means every tool function needs to accept the instance URL as a parameter rather than importing a constant.

### Auth Modes Summary (with key-service)

| Mode | Endpoint | How credentials are obtained |
|------|----------|------------------------------|
| **Hosted key-service** | `POST /forgejo/mcp/usr_...` | `usr_` key → key-service `/internal/resolve` → returns `forgejo_url` + `forgejo_token` |
| **Self-hosted HTTP** | `POST /forgejo/mcp` | `X-Forgejo-URL` + `X-Forgejo-Token` headers (direct, no key-service) |
| **CLI / stdio** | stdin/stdout | `FORGEJO_URL` + `FORGEJO_ACCESS_TOKEN` env vars |

---

## API Mapping: GitHub vs Forgejo

### Key Differences

| Aspect | GitHub API | Forgejo API |
|--------|-----------|-------------|
| Base URL | `https://api.github.com` | `https://{instance}/api/v1` |
| Auth header | `Authorization: Bearer ghp_...` | `Authorization: token {access_token}` |
| Pagination (page size) | `per_page` query param | `limit` query param |
| Pagination (page number) | `page` query param | `page` query param (same) |
| Default page size | 30 | 30 (configurable per instance) |
| Max page size | 100 | 50 (default `MAX_RESPONSE_ITEMS`) |
| API docs | docs.github.com | `{instance}/api/swagger` (auto-generated) |
| Rate limiting | 5,000 req/hr (authenticated) | Instance-dependent (usually none) |

### Endpoint Mapping — Core Tools

#### Repository Tools

| Tool | GitHub Endpoint | Forgejo Endpoint | Notes |
|------|----------------|------------------|-------|
| `get_repository` | `GET /repos/{owner}/{repo}` | `GET /api/v1/repos/{owner}/{repo}` | Response structure very similar |
| `list_branches` | `GET /repos/{owner}/{repo}/branches` | `GET /api/v1/repos/{owner}/{repo}/branches` | Same |
| `create_branch` | `POST /repos/{owner}/{repo}/git/refs` | `POST /api/v1/repos/{owner}/{repo}/branches` | Different — Forgejo has a direct branch creation endpoint |
| `get_file_contents` | `GET /repos/{owner}/{repo}/contents/{path}` | `GET /api/v1/repos/{owner}/{repo}/contents/{path}` | Same pattern, response includes `content` (base64) |
| `create_or_update_file` | `PUT /repos/{owner}/{repo}/contents/{path}` | `PUT /api/v1/repos/{owner}/{repo}/contents/{path}` | Same pattern |
| `list_commits` | `GET /repos/{owner}/{repo}/commits` | `GET /api/v1/repos/{owner}/{repo}/git/commits` | Path differs slightly |
| `get_commit` | `GET /repos/{owner}/{repo}/commits/{sha}` | `GET /api/v1/repos/{owner}/{repo}/git/commits/{sha}` | Path differs slightly |
| `list_tags` | `GET /repos/{owner}/{repo}/tags` | `GET /api/v1/repos/{owner}/{repo}/tags` | Same |
| `get_tag` | `GET /repos/{owner}/{repo}/git/tags/{tag_sha}` | `GET /api/v1/repos/{owner}/{repo}/tags/{tag}` | Forgejo uses tag name, not SHA |
| `create_repository` | `POST /user/repos` | `POST /api/v1/user/repos` | Same |
| `fork_repository` | `POST /repos/{owner}/{repo}/forks` | `POST /api/v1/repos/{owner}/{repo}/forks` | Same |

#### Issue Tools

| Tool | GitHub Endpoint | Forgejo Endpoint | Notes |
|------|----------------|------------------|-------|
| `list_issues` | `GET /repos/{owner}/{repo}/issues` | `GET /api/v1/repos/{owner}/{repo}/issues` | Same |
| `get_issue` | `GET /repos/{owner}/{repo}/issues/{number}` | `GET /api/v1/repos/{owner}/{repo}/issues/{index}` | Forgejo uses `index` not `number` |
| `create_issue` | `POST /repos/{owner}/{repo}/issues` | `POST /api/v1/repos/{owner}/{repo}/issues` | Same |
| `update_issue` | `PATCH /repos/{owner}/{repo}/issues/{number}` | `PATCH /api/v1/repos/{owner}/{repo}/issues/{index}` | Same pattern |
| `add_issue_comment` | `POST /repos/{owner}/{repo}/issues/{number}/comments` | `POST /api/v1/repos/{owner}/{repo}/issues/{index}/comments` | Same |
| `get_issue_comments` | `GET /repos/{owner}/{repo}/issues/{number}/comments` | `GET /api/v1/repos/{owner}/{repo}/issues/{index}/comments` | Same |

#### Pull Request Tools

| Tool | GitHub Endpoint | Forgejo Endpoint | Notes |
|------|----------------|------------------|-------|
| `list_pull_requests` | `GET /repos/{owner}/{repo}/pulls` | `GET /api/v1/repos/{owner}/{repo}/pulls` | Same |
| `get_pull_request` | `GET /repos/{owner}/{repo}/pulls/{number}` | `GET /api/v1/repos/{owner}/{repo}/pulls/{index}` | Same pattern |
| `create_pull_request` | `POST /repos/{owner}/{repo}/pulls` | `POST /api/v1/repos/{owner}/{repo}/pulls` | Same |
| `update_pull_request` | `PATCH /repos/{owner}/{repo}/pulls/{number}` | `PATCH /api/v1/repos/{owner}/{repo}/pulls/{index}` | Same |
| `merge_pull_request` | `PUT /repos/{owner}/{repo}/pulls/{number}/merge` | `POST /api/v1/repos/{owner}/{repo}/pulls/{index}/merge` | Method differs (PUT vs POST) |
| `get_pull_request_files` | `GET /repos/{owner}/{repo}/pulls/{number}/files` | `GET /api/v1/repos/{owner}/{repo}/pulls/{index}/files` | Same |
| `get_pull_request_reviews` | `GET /repos/{owner}/{repo}/pulls/{number}/reviews` | `GET /api/v1/repos/{owner}/{repo}/pulls/{index}/reviews` | Same |

#### Search Tools

| Tool | GitHub Endpoint | Forgejo Endpoint | Notes |
|------|----------------|------------------|-------|
| `search_repositories` | `GET /search/repositories` | `GET /api/v1/repos/search` | Different path and query params |
| `search_code` | `GET /search/code` | Not available | Forgejo does not have a code search API |
| `search_users` | `GET /search/users` | `GET /api/v1/users/search` | Different path |
| `search_issues` | `GET /search/issues` | `GET /api/v1/repos/{owner}/{repo}/issues?q=...` | Forgejo searches within a repo, not globally |

#### Forgejo-Specific Tools (not in GitHub MCP)

| Tool | Forgejo Endpoint | Description |
|------|-----------------|-------------|
| `get_user_info` | `GET /api/v1/user` | Get authenticated user info |
| `check_notifications` | `GET /api/v1/notifications` | List user notifications |
| `mark_notification_read` | `PATCH /api/v1/notifications/threads/{id}` | Mark notification as read |
| `list_repo_labels` | `GET /api/v1/repos/{owner}/{repo}/labels` | List labels with IDs |
| `list_repo_milestones` | `GET /api/v1/repos/{owner}/{repo}/milestones` | List milestones with IDs |
| `dispatch_workflow` | `POST /api/v1/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches` | Trigger Actions workflow |

---

## Implementation Plan

### Phase 1: Scaffold (estimated: 1 Claude Code session)

1. Remove all Go source files (`cmd/`, `pkg/`, `main.go`, `go.mod`, `go.sum`, `Makefile`, `.goreleaser.yml`, `Containerfile`)
2. Copy over from `mcp-github`:
   - `package.json` (rename to `mcp-forgejo`, update description and repo URLs)
   - `tsconfig.json`
   - `Dockerfile`
   - `docker-compose.yml`
   - `.env.sample`
   - `src/http-server.ts` (as-is, this is infrastructure code — includes key-service resolution logic)
   - `src/cli.ts` (as-is)
   - `src/index.ts` (update server name/description)
3. Replace `octokit` dependency with plain `fetch` calls to Forgejo's `/api/v1/` endpoints (Forgejo has no official JS SDK worth using — raw fetch is simpler and has zero dependencies)
4. Keep: `LICENSE`, `docs/` directory, `README.md` (will be rewritten)

### Phase 2: Core Tools (estimated: 1-2 Claude Code sessions)

1. **`src/tools/repositories.ts`** — Adapt all repo/branch/file/commit tools
   - Swap base URL pattern — **must accept dynamic URL from key-service credentials, not a constant**
   - Change auth header format (`Bearer` → `token`)
   - Change `per_page` → `limit` in pagination
   - Handle response field name differences
   - Remove `list_tags` / `get_tag` if not needed initially, or adapt

2. **`src/tools/issues.ts`** — Adapt issue and comment tools
   - Mostly 1:1 mapping
   - Add `list_repo_labels` and `list_repo_milestones` (useful Forgejo extras)

3. **`src/tools/pullrequests.ts`** — Adapt PR tools
   - Note: `merge_pull_request` uses POST instead of PUT
   - Review tools map cleanly

4. **`src/tools/search.ts`** — Adapt search tools
   - `search_repositories` → different endpoint path
   - `search_users` → different endpoint path
   - `search_code` → **remove** (Forgejo doesn't support this)
   - `search_issues` → scoped to repo, not global

### Phase 3: Forgejo-Specific Tools (estimated: 1 Claude Code session)

1. **`src/tools/notifications.ts`** — New file
   - `check_notifications`
   - `mark_notification_read`
   - `mark_all_notifications_read`
   - `list_repo_notifications`

2. **`src/tools/user.ts`** — New file
   - `get_user_info` (authenticated user)
   - `search_users` (could also live in search.ts)

3. **`src/tools/actions.ts`** — New file (if Forgejo Actions is enabled on the instance)
   - `dispatch_workflow`
   - `list_workflow_runs`
   - `get_workflow_run`

### Phase 4: Key-Service Integration (estimated: 1 session)

This phase covers changes to **both** `mcp-forgejo` and `mcp-key-service`:

#### In `mcp-key-service`:

1. **Add `forgejo` connector** to `src/connectors.ts` with fields:
   - `forgejo_url` (type: `url`, required) — Forgejo instance base URL
   - `forgejo_token` (type: `password`, required) — Forgejo personal access token
   - `servers: ['forgejo']`

2. **Generate a new server token** for Forgejo:
   ```bash
   openssl rand -hex 32
   ```

3. **Update `INTERNAL_SERVER_TOKENS`** in VPS `.env`:
   ```
   INTERNAL_SERVER_TOKENS=...,forgejo:GENERATED_TOKEN
   ```

4. **Rebuild key-service containers** to pick up the new connector:
   ```bash
   cd /path/to/mcp-key-service
   docker compose build --no-cache
   docker compose up -d
   ```

5. **Verify** the new connector appears on [mcpkeys.techmavie.digital](https://mcpkeys.techmavie.digital) portal.

#### In `mcp-forgejo`:

1. **Copy key-service resolution logic** from `mcp-github`'s `http-server.ts`:
   - Extract `usr_` key from URL path
   - Call `POST /internal/resolve` on key-service with `forgejo` server bearer token
   - Extract `forgejo_url` and `forgejo_token` from response credentials

2. **Pass dynamic credentials to tools** — every tool function must accept `(forgejoUrl: string, forgejoToken: string, ...)` instead of reading from a constant. This is the key difference from `mcp-github` where the base URL is always `api.github.com`.

3. **Set environment variables** in `docker-compose.yml` and `.env.sample`:
   ```
   KEY_SERVICE_URL=http://mcp-key-service:8090
   KEY_SERVICE_TOKEN=<the forgejo server token generated above>
   ```

4. **Join `mcp-network`** Docker network in `docker-compose.yml` so the container can reach the key-service internally.

### Phase 5: Deployment & Testing (estimated: 1 session)

1. Update `deploy/nginx-mcp.conf` — mount under `/forgejo/mcp`
2. Update `docker-compose.yml` — service name, port, env vars, network
3. Deploy to VPS and test all auth modes:
   - **Key-service mode:** Create a test connection on mcpkeys portal, connect via `usr_` key
   - **Self-hosted mode:** Test with `X-Forgejo-URL` + `X-Forgejo-Token` headers
   - **CLI mode:** Test with `FORGEJO_URL` + `FORGEJO_ACCESS_TOKEN` env vars
4. Test against the Forgejo instance on the VPS
5. Register on Smithery
6. Update this repo's `README.md`

---

## Environment Variables (Target)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `FORGEJO_URL` | unset | Default Forgejo instance URL (CLI mode only; key-service mode gets this per-user) |
| `FORGEJO_ACCESS_TOKEN` | unset | Token for CLI/stdio mode only |
| `MCP_API_KEY` | unset | Required for self-hosted `/mcp` and analytics |
| `KEY_SERVICE_URL` | unset | Key-service internal URL (e.g., `http://mcp-key-service:8090`) |
| `KEY_SERVICE_TOKEN` | unset | Bearer token for `/internal/resolve` (the `forgejo` server token) |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS allowlist |
| `PUBLIC_BASE_PATH` | unset | Reverse-proxy mount path (e.g., `/forgejo`) |

---

## Authentication Modes (Target)

| Mode | Endpoint | How credentials are obtained |
|------|----------|------------------------------|
| **Hosted key-service** | `POST /forgejo/mcp/usr_...` | `usr_` key → key-service `/internal/resolve` → returns `forgejo_url` + `forgejo_token` |
| **Self-hosted HTTP** | `POST /forgejo/mcp` | `X-API-Key` (MCP auth) + `X-Forgejo-URL` + `X-Forgejo-Token` headers |
| **CLI / stdio** | stdin/stdout | `FORGEJO_URL` + `FORGEJO_ACCESS_TOKEN` env vars |

---

## Tools to Remove (GitHub-specific, no Forgejo equivalent)

- `search_code` — Forgejo has no code search API
- `get_pull_request_status` — Forgejo handles commit statuses differently
- `update_pull_request_branch` — No direct equivalent
- `create_pull_request_review_comment` — May not be supported; verify against instance Swagger

---

## Tools to Add (Forgejo-specific)

- `check_notifications` / `mark_notification_read` / `mark_all_notifications_read`
- `list_repo_labels` / `list_repo_milestones`
- `dispatch_workflow` / `list_workflow_runs` / `get_workflow_run` (if Actions enabled)
- `get_user_info` (authenticated user)
- `delete_branch` (Forgejo has a direct endpoint; GitHub requires ref deletion)
- `delete_file` (direct Forgejo endpoint)

---

## Checklist Summary

### `mcp-forgejo` repo
- [ ] Strip Go codebase
- [ ] Scaffold TypeScript project from `mcp-github`
- [ ] Implement core tools (repos, issues, PRs, search)
- [ ] Implement Forgejo-specific tools (notifications, user, actions)
- [ ] Dynamic base URL per request (from key-service credentials)
- [ ] Auth header: `Authorization: token {forgejo_token}`
- [ ] Pagination: `per_page` → `limit`
- [ ] Deploy behind Nginx at `/forgejo/mcp`
- [ ] Join `mcp-network` Docker network
- [ ] Test all 3 auth modes
- [ ] Update README
- [ ] Register on Smithery

### `mcp-key-service` repo
- [ ] Add `forgejo` connector to `src/connectors.ts`
- [ ] Generate and add `forgejo` server token to `INTERNAL_SERVER_TOKENS`
- [ ] Rebuild and deploy key-service
- [ ] Verify connector appears on mcpkeys portal
- [ ] Test `usr_` key creation and resolution for Forgejo

---

## References

- **Source architecture:** [hithereiamaliff/mcp-github](https://github.com/hithereiamaliff/mcp-github)
- **Key-service:** [hithereiamaliff/mcp-key-service](https://github.com/hithereiamaliff/mcp-key-service)
- **Key-service portal:** [mcpkeys.techmavie.digital](https://mcpkeys.techmavie.digital)
- **Original fork:** [goern/forgejo-mcp](https://codeberg.org/goern/forgejo-mcp) (Go, retained for attribution)
- **Forgejo API docs:** `https://{your-instance}/api/swagger` (auto-generated per instance)
- **Forgejo API usage guide:** [forgejo.org/docs/next/user/api-usage](https://forgejo.org/docs/next/user/api-usage/)
- **Forgejo API settings endpoint:** `GET /api/v1/settings/api` (returns `max_response_items`, `default_paging_num`)
