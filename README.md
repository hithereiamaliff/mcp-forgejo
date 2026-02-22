# Forgejo MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for interacting with [Forgejo](https://forgejo.org/) instances through LLM interfaces.

Built with TypeScript and deployable via Docker to any VPS. Supports both **stdio** (local) and **Streamable HTTP** (remote/VPS) transports.

## Key Features

- **Repository Management** - Create repos, manage branches, files, and commits
- **Pull Request Operations** - Create, review, merge PRs with full review management
- **Issue Tracking** - Full issue lifecycle including comments and labels
- **User & Organization** - User info and org team search
- **CI/CD Integration** - Trigger and monitor Forgejo Actions workflows
- **Search** - Search users, repositories, and organization teams
- **VPS Deployment** - Docker + Nginx + GitHub Actions auto-deploy
- **Firebase Analytics** - Optional usage tracking

> **Note:** This MCP is designed for **Forgejo instances** (e.g., [Codeberg.org](https://codeberg.org)). It may work with Gitea for basic operations, but full compatibility is only guaranteed with Forgejo.

## Quick Start

### Prerequisites

- Node.js >= 18
- A Forgejo/Codeberg access token ([create one here](https://codeberg.org/user/settings/applications))

### Installation

```bash
git clone https://github.com/hithereiamaliff/mcp-forgejo.git
cd mcp-forgejo
npm install
npm run build
```

### Configuration

Copy `.env.sample` to `.env` and fill in your credentials:

```env
FORGEJO_URL=https://codeberg.org
FORGEJO_ACCESS_TOKEN=your_token_here
```

### Usage - Stdio Transport (Local)

Add to your Claude Desktop or MCP client configuration:

```json
{
  "mcpServers": {
    "forgejo": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "FORGEJO_URL": "https://codeberg.org",
        "FORGEJO_ACCESS_TOKEN": "YOUR_TOKEN_HERE"
      }
    }
  }
}
```

### Usage - HTTP Transport (VPS)

```bash
npm run serve:http
```

The server starts at `http://localhost:3000` with:
- **MCP endpoint**: `POST /mcp`
- **Health check**: `GET /health`
- **Analytics**: `GET /analytics`

Configure your MCP client to connect via Streamable HTTP:

```json
{
  "mcpServers": {
    "forgejo": {
      "url": "https://your-vps.example.com/forgejo/mcp?url=https://codeberg.org&token=YOUR_TOKEN"
    }
  }
}
```

## VPS Deployment

### Docker

```bash
docker compose up -d
```

See `docker-compose.yml` for configuration. The container exposes port `8190` by default.

### Nginx

Add the location block from `deploy/nginx-mcp.conf` to your Nginx site config to proxy `/forgejo/` to the container.

### Auto-Deploy (GitHub Actions)

The `.github/workflows/deploy-vps.yml` workflow auto-deploys on push to `main`. Required GitHub secrets:

| Secret | Description |
|--------|-------------|
| `VPS_HOST` | VPS hostname/IP |
| `VPS_USERNAME` | SSH username |
| `VPS_SSH_KEY` | SSH private key |
| `VPS_PORT` | SSH port |
| `FORGEJO_URL` | Forgejo instance URL |
| `FORGEJO_ACCESS_TOKEN` | Forgejo API token |

## Available Tools (35+)

### User
| Tool | Description |
|------|-------------|
| `get_my_user_info` | Get authenticated user info |

### Repository
| Tool | Description |
|------|-------------|
| `create_repo` | Create a new repository |
| `fork_repo` | Fork a repository |
| `list_my_repos` | List user's repositories |
| `get_file_content` | Get file content |
| `create_file` | Create a new file |
| `update_file` | Update an existing file |
| `delete_file` | Delete a file |
| `create_branch` | Create a branch |
| `delete_branch` | Delete a branch |
| `list_branches` | List branches |
| `list_repo_commits` | List repository commits |

### Issues
| Tool | Description |
|------|-------------|
| `get_issue_by_index` | Get issue by index |
| `list_repo_issues` | List repository issues |
| `create_issue` | Create a new issue |
| `update_issue` | Update an issue |
| `add_issue_labels` | Add labels to an issue |
| `issue_state_change` | Change issue state |
| `list_issue_comments` | List comments |
| `get_issue_comment` | Get a comment |
| `create_issue_comment` | Create a comment |
| `edit_issue_comment` | Edit a comment |
| `delete_issue_comment` | Delete a comment |

### Pull Requests
| Tool | Description |
|------|-------------|
| `get_pull_request_by_index` | Get PR by index |
| `list_repo_pull_requests` | List PRs |
| `create_pull_request` | Create a PR |
| `update_pull_request` | Update a PR |
| `merge_pull_request` | Merge a PR |
| `list_pull_reviews` | List reviews |
| `get_pull_review` | Get a review |
| `list_pull_review_comments` | List review comments |
| `create_pull_review` | Create a review |
| `submit_pull_review` | Submit a review |
| `dismiss_pull_review` | Dismiss a review |
| `delete_pull_review` | Delete a review |
| `create_review_requests` | Request reviews |
| `delete_review_requests` | Delete review requests |

### Search
| Tool | Description |
|------|-------------|
| `search_users` | Search for users |
| `search_repos` | Search for repositories |
| `search_org_teams` | Search organization teams |

### Actions/CI
| Tool | Description |
|------|-------------|
| `dispatch_workflow` | Trigger a workflow run |
| `list_workflow_runs` | List workflow runs |
| `get_workflow_run` | Get workflow run details |

### Utility
| Tool | Description |
|------|-------------|
| `hello` | Test server connectivity |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FORGEJO_URL` | URL of the Forgejo instance | Required |
| `FORGEJO_ACCESS_TOKEN` | Access token for authentication | Required |
| `PORT` | HTTP server port | `3000` |
| `HOST` | HTTP server host | `0.0.0.0` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Firebase credentials path | Optional |
| `FIREBASE_DATABASE_URL` | Firebase Realtime DB URL | Optional |

## Architecture

```
src/
  index.ts              # Stdio entry point
  http-server.ts         # HTTP entry point (Express + Streamable HTTP)
  forgejo-client.ts      # Axios-based Forgejo API client
  firebase-analytics.ts  # Optional Firebase analytics
  tools/
    register.ts          # Tool registration hub
    user.tools.ts        # User tools
    repo.tools.ts        # Repository tools
    branch.tools.ts      # Branch tools
    file.tools.ts        # File tools
    commit.tools.ts      # Commit tools
    issue.tools.ts       # Issue tools
    comment.tools.ts     # Comment tools
    pull.tools.ts        # Pull request tools
    review.tools.ts      # Review tools
    search.tools.ts      # Search tools
    actions.tools.ts     # Actions/workflow tools
```

## Acknowledgements

- Original [gitea-mcp](https://github.com/ArKade523/gitea-mcp) by @ArKade523
- Inspired by the Go implementation at [codeberg.org/goern/forgejo-mcp](https://codeberg.org/goern/forgejo-mcp)

## License

MIT - see [LICENSE](LICENSE) for details.
