# Forgejo MCP — Architecture Rebuild Plan

> **Goal:** Replace the current Go-based codebase (forked from `codeberg.org/goern/forgejo-mcp`) with a TypeScript rewrite that replicates the architecture of `hithereiamaliff/mcp-github`, adapted for the Forgejo REST API.

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
   - `src/http-server.ts` (as-is, this is infrastructure code)
   - `src/cli.ts` (as-is)
   - `src/index.ts` (update server name/description)
3. Replace `octokit` dependency with plain `fetch` calls to Forgejo's `/api/v1/` endpoints (Forgejo has no official JS SDK worth using — raw fetch is simpler and has zero dependencies)
4. Keep: `LICENSE`, `docs/` directory, `README.md` (will be rewritten)

### Phase 2: Core Tools (estimated: 1-2 Claude Code sessions)

1. **`src/tools/repositories.ts`** — Adapt all repo/branch/file/commit tools
   - Swap base URL pattern
   - Change auth header format
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

### Phase 4: Deployment & Testing (estimated: 1 session)

1. Update `deploy/nginx-mcp.conf` — mount under `/forgejo/mcp`
2. Update `docker-compose.yml` — service name, port, env vars
3. Update `.env.sample` — replace GitHub vars with Forgejo vars:
   - `FORGEJO_URL` (instance base URL)
   - `FORGEJO_ACCESS_TOKEN` (for CLI/stdio mode)
   - `MCP_API_KEY` (for self-hosted HTTP mode)
   - `KEY_SERVICE_URL` and `KEY_SERVICE_TOKEN` (for hosted key-service mode)
4. Test against the local Forgejo instance on the VPS
5. Register on Smithery
6. Update this repo's `README.md`

---

## Environment Variables (Target)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `FORGEJO_URL` | (required) | Forgejo instance base URL (e.g., `https://git.example.com`) |
| `FORGEJO_ACCESS_TOKEN` | unset | Token for CLI/stdio mode only |
| `MCP_API_KEY` | unset | Required for self-hosted `/mcp` and analytics |
| `KEY_SERVICE_URL` | unset | Hosted key-service resolver URL |
| `KEY_SERVICE_TOKEN` | unset | Hosted key-service bearer token |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS allowlist |
| `PUBLIC_BASE_PATH` | unset | Reverse-proxy mount path (e.g., `/forgejo`) |

---

## Authentication Modes (Target)

| Mode | Endpoint | Client auth |
|------|----------|-------------|
| Hosted key-service | `POST /forgejo/mcp/usr_...` | User key in path |
| Self-hosted | `POST /forgejo/mcp` | `X-API-Key` + `X-Forgejo-Token` headers |
| CLI | stdio | `FORGEJO_ACCESS_TOKEN` env var |

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

## References

- **Source architecture:** [hithereiamaliff/mcp-github](https://github.com/hithereiamaliff/mcp-github)
- **Original fork:** [goern/forgejo-mcp](https://codeberg.org/goern/forgejo-mcp) (Go, retained for attribution)
- **Forgejo API docs:** `https://{your-instance}/api/swagger` (auto-generated per instance)
- **Forgejo API usage guide:** [forgejo.org/docs/next/user/api-usage](https://forgejo.org/docs/next/user/api-usage/)
- **Forgejo API settings endpoint:** `GET /api/v1/settings/api` (returns `max_response_items`, `default_paging_num`)
