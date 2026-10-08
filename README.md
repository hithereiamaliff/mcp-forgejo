# Forgejo MCP Server

An MCP (Model Context Protocol) server for [Forgejo](https://forgejo.org/): your self-hosted Git forge, [Codeberg](https://codeberg.org), or any other Forgejo instance (most tools also work on Gitea). It lets Claude and other AI assistants browse and change repositories, files, branches, issues, pull requests, reviews, notifications, Actions, releases, wikis, organizations and more.

**118 tools** in 16 toolsets. **55 everyday tools are on by default**, and you can switch the rest on per connection. Every tool is annotated read-only or destructive, so clients know when to ask before acting. Run it hosted (multi-user, via [mcp-key-service](https://mcpkeys.techmavie.digital)) or locally over stdio.

**Hosted endpoint:** `https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY`

> v3 is a complete TypeScript rewrite. Versions 1–2 were a fork of the Go server [goern/forgejo-mcp](https://codeberg.org/goern/forgejo-mcp); the last of them is kept at tag [`go-legacy-v2.17.0`](https://github.com/hithereiamaliff/mcp-forgejo/tree/go-legacy-v2.17.0). Thanks to Christoph Görn and the contributors of the original project.

## Quick start

### Option 1: Hosted (recommended)

1. Create an access token on your Forgejo instance: **Settings → Applications → Generate New Token** (see [Token scopes](#token-scopes)).
2. Sign in at **https://mcpkeys.techmavie.digital** and create a **Forgejo** connection with your instance URL (e.g. `https://git.example.com` or `https://codeberg.org`) and the token.
3. Copy your personal key (`usr_...`) and add the server to your MCP client:

   ```text
   https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY
   ```

   ```json
   {
     "mcpServers": {
       "forgejo": {
         "type": "http",
         "url": "https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY"
       }
     }
   }
   ```

   Clients that support custom headers can keep the key out of the URL: `POST https://mcp.techmavie.digital/forgejo/mcp` with `Authorization: Bearer usr_YOUR_KEY`. `?api_key=usr_YOUR_KEY` also works.

Your Forgejo token is stored encrypted in the key service and is never written to this server's disk or shared between users.

### Option 2: Local (stdio)

```json
{
  "mcpServers": {
    "forgejo": {
      "command": "npx",
      "args": ["-y", "github:hithereiamaliff/mcp-forgejo"],
      "env": {
        "FORGEJO_URL": "https://git.example.com",
        "FORGEJO_ACCESS_TOKEN": "your_forgejo_token",
        "FORGEJO_TOOLSETS": "default"
      }
    }
  }
}
```

Locally, `http://` and LAN/localhost instances are allowed. The hosted server refuses them (see [Security](#security)).

### Option 3: Self-hosted HTTP

Run your own instance (see [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md)) and authenticate with headers:

```bash
curl -X POST https://your-host/forgejo/mcp \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $MCP_API_KEY" \
  -H "X-Forgejo-Url: https://git.example.com" \
  -H "X-Forgejo-Token: $FORGEJO_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Choosing tools: toolsets and read-only mode

Tools are grouped into toolsets. Pick them per connection with a query parameter (or the `X-Forgejo-Toolsets` header), or locally with `FORGEJO_TOOLSETS`:

| Toolset | Default | Tools | What it covers |
|---|---|---|---|
| `meta` | always | 1 | `forgejo_hello`: connection check and server info |
| `users` | ✓ | 2 | User profiles and user search |
| `repos` | ✓ | 7 | List, search, create, fork, update and **import/mirror** repositories (from GitHub, GitLab, Gitea…) |
| `code` | ✓ | 14 | Files, trees, multi-file commits, branches, commits, comparisons, CI status, tags |
| `issues` | ✓ | 12 | Issues, comments, labels by name, milestones, global search ("assigned to me") |
| `pulls` | ✓ | 16 | Pull requests, diffs, merging (incl. auto-merge), full review workflow |
| `notifications` | ✓ | 3 | Notification inbox |
| `actions` | | 8 | Forgejo Actions: workflows, dispatch, runs, jobs, logs, cancel, rerun, artifacts |
| `actions_admin` | | 6 | Actions secrets and variables (repo, org, user) |
| `releases` | | 6 | Releases and tag deletion |
| `wiki` | | 6 | Wiki pages and revisions |
| `labels` | | 6 | Create, update and delete labels and milestones |
| `orgs` | | 11 | Organizations, members and teams |
| `repo_admin` | | 14 | Collaborators, branch protection, webhooks, push/pull mirrors, repository deletion |
| `packages` | | 3 | Package registry |
| `admin` | | 3 | Site administration (instance admins only) |

```text
https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY?toolsets=default,actions,releases
https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY?toolsets=all
https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY?read_only=true
```

`read_only=true` (or `X-Forgejo-Read-Only: true`, or `FORGEJO_READ_ONLY=true`) hides every tool that writes, whatever toolsets are enabled. For a hard guarantee, also use a token with read-only scopes.

The key always comes directly after `/mcp/`, then a **`?`** before the options. To change the toolsets of a connector you already added in Claude, **remove it and add it again** with the new URL; editing the URL in place can leave a stale sign-in state. `forgejo_hello` shows which toolsets are active.

The full list with parameters is in **[TOOLS.md](TOOLS.md)** (generated from the code).

## What it's good at

- **Exploring code without a search API:** `forgejo_get_tree` lists every file (with a path filter), and `forgejo_get_file_contents` reads files with line ranges or lists folders with next-step hints.
- **Multi-file commits:** `forgejo_push_files` creates, updates, renames and deletes files in one commit, optionally on a new branch. File SHAs are looked up for you.
- **Labels and milestones by name:** "label it `bug` and put it in `v1.0`" just works. Repo and org labels are both matched, and unknown names come back with the list of available labels.
- **Pull requests end to end:** open (draft, reviewers), read the diff (trimmed per file for big PRs), check CI status, review with inline comments, merge with any method or schedule auto-merge.
- **Global triage:** `forgejo_search_issues` finds issues and PRs across all repositories ("assigned to me", "review requested", "mentioning me").
- **Moving from GitHub:** `forgejo_migrate_repo` imports or mirrors a GitHub/GitLab/Gitea repository, with issues, PRs, releases and wiki. `forgejo_create_push_mirror` keeps a copy on GitHub in sync.
- **Instance-aware:** the server reads your Forgejo version. Features from newer releases (job logs, cancel and artifacts need 16+, rerun needs 17+) say so clearly instead of failing with an unexplained 404, and older versions get fallbacks where possible.

## Token scopes

Forgejo tokens have `read:`/`write:` scopes per area. Pick what you need:

| Use | Scopes |
|---|---|
| Default toolsets | `repository`, `issue`, `notification`, `user` (read or write) |
| `orgs` toolset | + `organization` |
| `packages` toolset | + `package` |
| `admin` toolset | + `admin` (site admins only) |
| Deleting repositories (`repo_admin`) | `write:user` (`write:organization` for org repos), required by Forgejo 15+ |
| Read-only connection | the same, `read:` only |

Without `read:user`, everything still works except tools that need your user name. `forgejo_hello` explains this. Repository-specific tokens (Forgejo 15+) work too. If a scope is missing, tools tell you exactly which one.

## Troubleshooting the connection

| What you see | Cause | Fix |
|---|---|---|
| Claude asks you to **sign in** | The server answered "not authenticated": the `usr_` key is missing from the URL, `&` was used instead of `?`, or the key is old (re-creating a connection in the portal issues a new key). This server has no OAuth login. | Use `https://mcp.techmavie.digital/forgejo/mcp/usr_KEY?toolsets=…` with the current key, and re-add the connector |
| Only the default tools appear | The option name is misspelled (it is `toolsets`, plural) | Fix the URL and re-add the connector |
| `Unknown toolset(s): …` | A toolset name is misspelled | Use a name from the table above |
| A tool says a token scope is missing | The Forgejo token lacks that scope | Create a token with it and update the connection in the portal |

[deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md#sign-in-prompt-or-connection-errors) has two copy-paste commands that **check a connector URL without sharing your key** and build a correct URL with extra toolsets.

## Authentication modes

| Mode | Endpoint | Credentials |
|---|---|---|
| Hosted (key service) | `POST /forgejo/mcp/usr_…`, `Authorization: Bearer usr_…`, `X-API-Key: usr_…` or `?api_key=usr_…` | Instance URL + token stored in mcp-key-service |
| Self-hosted HTTP | `POST /forgejo/mcp` | `X-API-Key: <MCP_API_KEY>` + `X-Forgejo-Url` + `X-Forgejo-Token` (or the server's `FORGEJO_URL` / `FORGEJO_ACCESS_TOKEN`) |
| Local stdio | `npx mcp-forgejo` | `FORGEJO_URL` + `FORGEJO_ACCESS_TOKEN` |

Raw Forgejo tokens are never accepted in URLs: they would end up in proxy logs.

## HTTP endpoints

| Endpoint | Description |
|---|---|
| `POST /mcp/{usr_key}` | MCP endpoint, hosted mode |
| `POST /mcp` | MCP endpoint, header auth or `?api_key=` |
| `GET /health` | Health check |
| `GET /` | Server info |
| `GET /.well-known/mcp/server-card.json` | Server card (all tools, with toolsets) |
| `GET /analytics`, `/analytics/tools` | Usage stats (needs `X-API-Key: <MCP_API_KEY>`) |
| `GET /analytics/dashboard` | Analytics dashboard |

The server is stateless: every request gets its own MCP server instance. `GET`/`DELETE` on `/mcp` return 405.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `FORGEJO_URL` / `FORGEJO_ACCESS_TOKEN` | – | Instance and token (local CLI; HTTP self-hosted fallback) |
| `FORGEJO_TOOLSETS` | `default` | Default toolsets (`default`, `all`, or a list) |
| `FORGEJO_READ_ONLY` | `false` | Hide all write tools by default |
| `KEY_SERVICE_URL` | – | Full resolve URL, e.g. `http://mcp-key-service:8090/internal/resolve` |
| `KEY_SERVICE_TOKEN` | – | This server's token in mcp-key-service (`forgejo:<token>`) |
| `KEY_SERVICE_SERVER_ID` | `forgejo` | Server ID sent to the key service |
| `MCP_API_KEY` | – | Enables self-hosted mode and analytics |
| `FORGEJO_ALLOW_HTTP` | `false` | HTTP server: allow `http://` instances |
| `FORGEJO_ALLOW_PRIVATE_HOSTS` | `false` | HTTP server: allow private/LAN addresses (single-user deployments only) |
| `FORGEJO_TRUSTED_HOSTS` | – | Host names exempt from the private-address check |
| `FORGEJO_TIMEOUT_MS` | `30000` | Timeout per Forgejo request |
| `FORGEJO_MAX_RESPONSE_MB` | `20` | Largest Forgejo response the server reads |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP listener |
| `PUBLIC_BASE_PATH` | – | Reverse-proxy prefix used in advertised URLs (e.g. `/forgejo`) |
| `ANALYTICS_DIR` | `/app/data` | Where analytics are persisted |
| `ALLOWED_ORIGINS` | `*` | CORS allow-list |

See [.env.sample](.env.sample) for the full list with comments.

## Security

- **Per-request isolation:** each request gets a fresh MCP server. Credentials live only in that request's closure, never in `process.env` or shared state.
- **SSRF guard:** the hosted server calls URLs that users saved in the portal, so it refuses:
  - `http://` URLs
  - addresses that resolve to private, loopback, link-local, metadata, CGNAT or IPv6-ULA ranges, including IPv4-mapped forms. The check runs at connection time, which also defeats DNS rebinding.

  It also never follows redirects, so your token can't be forwarded to another host.
- **Path safety:** names like `..` are rejected before any request, so a crafted branch or tag name can't turn into a request against another route (e.g. deleting the repository).
- **No secret leakage:** tokens are scrubbed from every error. Webhook secrets, mirror passwords and token-like URL parts are never printed. Analytics store hashed IPs and fixed route names only, never `usr_` keys. nginx access logs are off for this location.
- **Prompt-injection awareness:** issue and PR bodies, comments, commit messages, file contents, wiki pages and logs come back fenced and labelled as untrusted content. The server instructions tell the model never to follow instructions inside them.
- **Destructive actions are explicit:** deletes, merges, cancels and dismissals carry `destructiveHint`. Deleting a repository or organization also requires typing its full name back.

## Local development

```bash
npm install
npm run dev            # HTTP server on :8080 (tsx)
npm test               # unit + integration tests (node:test)
npm run typecheck
npm run build          # → dist/
npm run docs:tools     # regenerate TOOLS.md

# Live check against a real instance (FORGEJO_URL + FORGEJO_ACCESS_TOKEN in .env):
npm run build && npm run smoke                  # read-only
SMOKE_WRITE=1 npm run smoke                     # also a full write lifecycle on a throw-away repo
```

## Project structure

```text
src/
├── index.ts            # server factory, tool registry, toolset/read-only filtering, instructions
├── http-server.ts      # Streamable HTTP: auth modes, key service, analytics, server card
├── cli.ts              # stdio entry point
├── config.ts           # toolsets, booleans, network policy
├── forgejo/            # REST client, errors, URL normalisation, SSRF guard, capabilities, projections
├── tools/              # one file per toolset (+ shared.ts, lookups.ts)
└── utils/              # key service, analytics, security, markdown, diffs, workflow parsing
tests/                  # node:test suites (core, ssrf, client, key service, tools, http)
scripts/                # smoke-test.mjs, generate-tools-md.ts
deploy/                 # DEPLOYMENT.md, nginx-mcp.conf
```

## Documentation

| Document | What's in it |
|---|---|
| [TOOLS.md](TOOLS.md) | Every tool with its parameters (generated from the code) |
| [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md) | Deployment and usage guide: hosted server, local mode, self-hosting, troubleshooting |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

## License

MIT. See [LICENSE](LICENSE).
