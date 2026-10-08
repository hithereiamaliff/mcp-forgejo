# Changelog

## 3.0.0 (2026-10-08)

Complete rewrite in TypeScript on the TechMavie MCP v2 pattern. The Go implementation (a fork of [goern/forgejo-mcp](https://codeberg.org/goern/forgejo-mcp), last version 2.17.0) is kept at tag `go-legacy-v2.17.0`.

### Breaking changes

- The Go binary, its CLI flags (`--transport`, `--url`, `--token`) and the SSE transport are gone. Run `npx mcp-forgejo` (stdio) or the HTTP server (`node dist/http-server.js`) instead.
- All tools are renamed with a `forgejo_` prefix and reorganised. For example, `get_issue_by_index` is now `forgejo_get_issue` and `list_repo_issues` is now `forgejo_list_issues`. See [TOOLS.md](TOOLS.md).
- Configuration is through environment variables: `FORGEJO_URL`, `FORGEJO_ACCESS_TOKEN`, `FORGEJO_TOOLSETS`, `FORGEJO_READ_ONLY`.

### Added

- **Multi-tenant hosting:**
  - mcp-key-service integration (`usr_` keys in the path, as a Bearer token, in the `X-API-Key` header or as `?api_key=`)
  - self-hosted header mode
  - per-request isolation
  - analytics dashboard, server card
  - Docker/nginx deployment with a test-gated deploy workflow
- **118 tools in 16 toolsets** (55 on by default), selectable per connection with `?toolsets=`, plus a read-only mode (`?read_only=true`).
- **New capabilities compared with 2.x:**
  - repositories: import/mirror from GitHub/GitLab/Gitea, search
  - files and commits: multi-file commits, recursive trees, compare, commit status
  - issues and labels: global issue search, labels and milestones by name
  - pull requests: diff trimming, auto-merge, update branch
  - releases, wiki (REST), packages
  - Actions: workflow list, job logs, cancel, rerun, artifacts, secrets and variables
  - repo admin: branch protection, webhooks, push mirrors, collaborators
  - instance admin: users and cron tasks
- **Instance awareness:** version detection with clear "needs Forgejo X" messages, fallbacks for older versions, and page sizes capped to the instance limit.
- **Safety:**
  - SSRF guard for user-supplied instance URLs, and redirects are never followed
  - rejection of `.`/`..` path segments
  - token scrubbing
  - untrusted-content fencing against prompt injection
  - destructive-action annotations, with name confirmation required to delete repositories and organizations
- **Tests:** about 170 `node:test` cases (unit, tool behaviour with a fake Forgejo, HTTP integration with a fake key service), plus a live smoke test.

### Deployment (2026-10-08)

- Deployed to https://mcp.techmavie.digital/forgejo with the `forgejo` connector in mcp-key-service.
- The host port is configurable (`MCP_HOST_PORT` in the VPS `.env`) after the planned port 8098 turned out to be taken; production uses 8100.
- End-to-end tested through Claude, covering reads, commits, PR review/merge, issues, mirror sync and repository deletion.
- Copy-paste runbooks: [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md) and [docs/FORGEJO-UPGRADE.md](docs/FORGEJO-UPGRADE.md). The Forgejo instance itself was upgraded from 14.0.3 to 15.0.9 LTS the same day.
- Docs-only changes no longer trigger a redeploy.
