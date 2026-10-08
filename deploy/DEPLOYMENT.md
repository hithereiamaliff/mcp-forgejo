# Forgejo MCP: deployment and usage guide

This guide covers everything you need to run and use the Forgejo MCP server:

1. [Using the hosted server](#using-the-hosted-server)
2. [Running it locally (stdio)](#running-it-locally-stdio)
3. [Self-hosting with Docker and a reverse proxy](#self-hosting-with-docker-and-a-reverse-proxy)
4. [Verifying a deployment](#verifying-a-deployment)
5. [Troubleshooting](#troubleshooting)
6. [Security notes](#security-notes)
7. [Maintenance](#maintenance)

For the list of tools, see [TOOLS.md](../TOOLS.md).

---

## Using the hosted server

The hosted server is at `https://mcp.techmavie.digital/forgejo`. Your Forgejo URL and token are stored encrypted in the key service ([mcpkeys.techmavie.digital](https://mcpkeys.techmavie.digital)). You connect with a personal `usr_` key.

### 1. Create a Forgejo access token

On your Forgejo instance, go to **Settings → Applications → Generate New Token**:

| Use | Scopes |
|---|---|
| Default toolsets | `repository`, `issue`, `notification`, `user` (read or write) |
| `orgs` toolset | add `organization` |
| `packages` toolset | add `package` |
| `admin` toolset | add `admin` (site admins only) |
| Deleting repositories (`repo_admin`) | `write:user` (or `write:organization` for org repos), required on Forgejo 15+ |
| Read-only connection | the same scopes, `read:` only |

### 2. Create a connection in the key portal

Add a **Forgejo** connection with your instance URL (e.g. `https://git.example.com` or `https://codeberg.org`) and the token, then copy your `usr_` key.

Re-creating a connection (for example to change the token) issues a **new** key, and the old one stops working.

### 3. Add the server to your MCP client

```text
https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY
```

The key goes directly after `/mcp/`. Options follow a **`?`**:

```text
https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY?toolsets=default,actions
https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY?toolsets=all
https://mcp.techmavie.digital/forgejo/mcp/usr_YOUR_KEY?read_only=true
```

| Option | Meaning |
|---|---|
| `toolsets` | `default`, `all`, or a comma-separated list (see the README for the toolset names) |
| `read_only` | `true` hides every tool that writes |

Clients that support custom headers can keep the key out of the URL instead. Send `POST https://mcp.techmavie.digital/forgejo/mcp` with `Authorization: Bearer usr_YOUR_KEY`, and optionally `X-Forgejo-Toolsets` and `X-Forgejo-Read-Only`.

**Changing toolsets:** remove the connector in your client and add it again with the new URL. Editing the URL of an existing connector can leave a stale sign-in state.

**Check the connection** by asking your assistant to run `forgejo_hello`. It shows the instance version, your user and the enabled toolsets.

---

## Running it locally (stdio)

```json
{
  "mcpServers": {
    "forgejo": {
      "command": "npx",
      "args": ["-y", "github:hithereiamaliff/mcp-forgejo"],
      "env": {
        "FORGEJO_URL": "https://git.example.com",
        "FORGEJO_ACCESS_TOKEN": "your_forgejo_token",
        "FORGEJO_TOOLSETS": "default",
        "FORGEJO_READ_ONLY": "false"
      }
    }
  }
}
```

In local mode, `http://` and LAN/localhost instances are allowed.

---

## Self-hosting with Docker and a reverse proxy

### Requirements

- A Linux host with Docker (Compose v2) and nginx (or another reverse proxy) serving HTTPS.
- A free localhost port for the container (default `8099`; set `MCP_HOST_PORT` to change it).

### 1. Get the code and configure it

```bash
git clone https://github.com/hithereiamaliff/mcp-forgejo.git /opt/mcp-servers/forgejo
cd /opt/mcp-servers/forgejo
cp .env.sample .env
```

Edit `.env`. For a **single-user** server with one Forgejo instance:

```env
MCP_API_KEY=<openssl rand -hex 32>       # protects self-hosted /mcp and /analytics
FORGEJO_URL=https://git.example.com      # used when a request doesn't send X-Forgejo-Url
FORGEJO_ACCESS_TOKEN=<forgejo token>
MCP_HOST_PORT=8099                       # a free port on the host
```

For a **multi-user** server backed by [mcp-key-service](https://github.com/hithereiamaliff/mcp-key-service):

```env
KEY_SERVICE_URL=http://mcp-key-service:8090/internal/resolve   # full resolve URL
KEY_SERVICE_TOKEN=<this server's token in the key service>
MCP_API_KEY=<openssl rand -hex 32>
MCP_HOST_PORT=8099
```

The key service must have a `forgejo` connector, with this server's token registered under the server ID `forgejo` (see the key service README). Both containers must share the external Docker network `mcp-network`.

Keep `FORGEJO_ALLOW_HTTP` and `FORGEJO_ALLOW_PRIVATE_HOSTS` **off** on any server other people use. They exist for private single-user setups; on a shared server they would let users reach internal services.

### 2. Start the container

Check that the port is free (this should print nothing):

```bash
ss -tlnp | grep ':8099'
```

Then start the container and follow its logs:

```bash
docker network inspect mcp-network >/dev/null 2>&1 || docker network create mcp-network
docker compose up -d --build
docker compose logs -f
```

The port is published on `127.0.0.1` only, so the server is reachable only through the reverse proxy.

### 3. Add the reverse-proxy route

Add the `location /forgejo/ { ... }` block from [nginx-mcp.conf](./nginx-mcp.conf) to your HTTPS `server { }` block. Make sure the port in `proxy_pass` matches `MCP_HOST_PORT`. Then test the config and reload:

```bash
nginx -t && systemctl reload nginx
```

Before the container is running, `https://your-domain/forgejo/health` should return `502`. A `200` with another server's name means the port is already used by something else.

### 4. Optional: deploy automatically from GitHub Actions

`.github/workflows/deploy-vps.yml` runs the tests on every push to `main`, then deploys over SSH:
1. `git reset --hard origin/main`
2. `docker compose build` and `docker compose up -d`
3. a health check on `127.0.0.1:$MCP_HOST_PORT/health`

Markdown and `docs/` changes are skipped. Add these repository secrets:

| Secret | Value |
|---|---|
| `VPS_HOST` | Host name or IP of the server |
| `VPS_USERNAME` | SSH user |
| `VPS_SSH_KEY` | Private key of a deploy key dedicated to this repository |
| `VPS_PORT` | SSH port (optional, default 22) |

The workflow expects the checkout at `/opt/mcp-servers/forgejo`, with its `.env` created by hand as in step 1.

### Forgejo on the same host

If the Forgejo instance runs on the same machine, the container normally reaches it through its public address. If that fails because the host doesn't route traffic back to itself, `forgejo_hello` reports a timeout or connection refused. To fix it:

1. Point the name at the host with a `docker-compose.override.yml`. It isn't tracked by git, so deploys keep it:

   ```yaml
   services:
     mcp-forgejo:
       extra_hosts:
         - "git.example.com:host-gateway"
   ```

2. Add the host to `.env`, so the private-address guard allows it:

   ```env
   FORGEJO_TRUSTED_HOSTS=git.example.com
   ```

---

## Verifying a deployment

```bash
BASE=https://your-domain/forgejo
```

1. Health. Expect `"status":"healthy"`, and `"keyService":"configured"` in key-service mode:

   ```bash
   curl -s $BASE/health
   ```

2. Server card. It lists all tools with their toolsets:

   ```bash
   curl -s $BASE/.well-known/mcp/server-card.json | head -c 600
   ```

3. No credentials. Expect a `401` with instructions:

   ```bash
   curl -s -X POST $BASE/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

4. Key-service mode only: a made-up key should return "This key is invalid, revoked or suspended". Any other answer means this server can't talk to the key service correctly.

   ```bash
   curl -s -X POST $BASE/mcp/usr_00000000000000000000000000000000 -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

5. Self-hosted mode: `forgejo_hello` with headers. The `X-Forgejo-Url` and `X-Forgejo-Token` headers can be left out if `.env` sets `FORGEJO_URL` and `FORGEJO_ACCESS_TOKEN`:

   ```bash
   curl -s -X POST $BASE/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "X-API-Key: $MCP_API_KEY" -H "X-Forgejo-Url: https://git.example.com" -H "X-Forgejo-Token: $FORGEJO_TOKEN" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"forgejo_hello","arguments":{}}}'
   ```

6. Analytics. Expect `401` without the key; the dashboard page loads at `$BASE/analytics/dashboard` and asks for `MCP_API_KEY`:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" $BASE/analytics
   ```

---

## Troubleshooting

### Sign-in prompt or connection errors

MCP clients such as Claude show a **sign-in** prompt when the server answers "not authenticated". This server has no OAuth login, so the prompt always means the connector URL is wrong:

| URL saved in the client | Server answer | Fix |
|---|---|---|
| `…/forgejo/mcp?toolsets=…` (key missing) | 401 `missing_auth` | put `usr_KEY` after `/mcp/` |
| `…/mcp/usr_KEY&toolsets=…` (`&` instead of `?`) | 403 `invalid_key` | use `?` before the options |
| an old key (connection re-created in the portal) | 403 `invalid_key` | copy the current key from the portal |
| `?toolset=…` or another misspelled option **name** | works, but with the default tools only | the option is `toolsets` (an unknown toolset **value** returns a clear 400) |

**Check a connector URL without revealing the key.** The URL is read from a hidden prompt; works anywhere `curl` is available:

```bash
read -rsp "Paste your full Forgejo MCP URL, then press Enter: " U; echo; curl -s -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"forgejo_hello","arguments":{}}}' "$U" | grep -o -E 'Enabled toolsets:[^\\]*|"message":"[^"]*"' | head -3; unset U
```

**Build a correct URL with extra toolsets from a working one.** It prints the new URL to paste into your client. To get different toolsets, change `default,repo_admin` in the command:

```bash
read -rsp "Paste your WORKING Forgejo MCP URL, then press Enter: " U; echo; BASE="${U%%\?*}"; NEW="$BASE?toolsets=default,repo_admin"; case "$U" in *api_key=*) NEW="$BASE?$(echo "${U#*\?}" | tr '&' '\n' | grep '^api_key=' | head -1)&toolsets=default,repo_admin";; esac; curl -s -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"forgejo_hello","arguments":{}}}' "$NEW" | grep -o -E 'Enabled toolsets:[^\\]*|"message":"[^"]*"' | head -3; echo; echo "Use this URL in your client (keep it private):"; echo "$NEW"; unset U BASE NEW
```

### Common errors

| Symptom | Cause / fix |
|---|---|
| `403 invalid_key` | The key is wrong, revoked or suspended, or belongs to another connector. Check the portal. |
| `502 malformed_response` | The saved connection lacks the instance URL or token. Re-save it in the portal. |
| `503 service_unavailable` | The key service is unreachable **or rejected this server's token**. Check that `KEY_SERVICE_TOKEN` matches this server's entry in the key service, that `KEY_SERVICE_URL` ends in `/internal/resolve`, and that both containers are on `mcp-network`. |
| `400 invalid_toolsets` | Unknown name in `?toolsets=`. The error lists the valid names. |
| Fewer tools than expected | A misspelled option name, or read-only mode is on. `forgejo_hello` shows what is enabled. |
| Tool error "http:// is not allowed" or "private or internal address" | The instance URL is `http://` or resolves to a private IP. The shared server only talks to public HTTPS instances. |
| Tool error "redirected … update it" | The instance URL redirects (http→https, www or a sub-path). Use the final URL. |
| Tool error "missing the scope(s) …" | Create a token with that scope and update the connection. |
| Tool error "needs Forgejo 16.0 or newer" | That Actions feature doesn't exist in the instance's version yet. |
| `/forgejo/health` shows another server's name | The host port is used by another container. Choose a free `MCP_HOST_PORT`, update `proxy_pass`, then redeploy. |
| Container exits immediately | Check `docker compose logs`. Common causes: only one of `KEY_SERVICE_URL` / `KEY_SERVICE_TOKEN` is set, or `FORGEJO_TOOLSETS` is invalid. |
| Empty `initialize` responses | Set `MCP_TRACE_HTTP=true`, restart, and check the logs. `ENABLE_MCP_DIAGNOSTICS=true` enables `/mcp-debug/open` for testing the connection on its own. |

---

## Security notes

- **Isolation:** every request gets a fresh MCP server. Credentials live only in that request and are never written to disk or to `process.env`.
- **Outbound requests are guarded:**
  - The server refuses `http://` and private, loopback, link-local and metadata addresses. It checks at connection time, which also defeats DNS rebinding.
  - It never follows redirects.
  - It rejects `.`/`..` path segments.
- **Secrets stay out of logs and output:**
  - Tokens are scrubbed from errors.
  - Secrets and token-like URL parts are never printed.
  - Analytics store only hashed IPs and fixed route names.
  - The nginx location turns off the access log, because `usr_` keys appear in URLs.
- **Don't publish your config:** keep `.env` files, connector URLs (they contain your key) and host-specific notes out of public repositories and chats.

---

## Maintenance

```bash
cd /opt/mcp-servers/forgejo
docker compose ps
docker compose logs -f --tail=100
docker compose restart
docker compose up -d --build          # rebuild after manual changes
```

To update a self-hosted copy without the GitHub workflow:

```bash
cd /opt/mcp-servers/forgejo && git pull && docker compose up -d --build
```
